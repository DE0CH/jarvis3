// Transcript search (docs/API.md section 14). Each session reports its agents' conversations
// (Paseo timeline entries: what the user and the agent said, and each tool call trimmed) to the
// server, which keeps them in SQLite with an FTS5 trigram index: substring search in any language
// (中文 included), case-insensitive, ranked by bm25. A person searches their own tasks (live,
// paused and archived alike); an admin may search anyone's. Keyword only, no embeddings: nothing
// leaves the instance and nothing is billed.
//
// Jarvis 1's transcript-search (a hybrid keyword + semantic index over every archived transcript)
// is the analogue; here the session pushes its timeline as it goes, so a task is searchable while
// it runs, and an archived task stays searchable without unpacking its archive.
import type { SearchHit, SearchResult, SessionTranscriptCursors, SessionTranscriptRequest, TaskState, TranscriptEntry, TranscriptPage, TranscriptRole } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import type { TaskRow } from "./rows.ts";
import { tx } from "./db.ts";
import { iso } from "./clock.ts";
import { httpError } from "./errors.ts";

/** Longest text kept per entry (a longer one keeps its head and tail). */
export const MAX_ENTRY_CHARS = 8000;
export const MAX_ENTRIES_PER_POST = 500;
const ROLES: ReadonlySet<string> = new Set(["user", "assistant", "tool"]);

interface EntryRow {
  id: number;
  task_id: string;
  user_id: string;
  agent_id: string;
  seq: number;
  role: TranscriptRole;
  text: string;
  at: number;
}

export function trimText(text: string, max = MAX_ENTRY_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return `${text.slice(0, half)} … ${text.slice(text.length - half)}`;
}

const entryView = (r: EntryRow): TranscriptEntry => ({ agentId: r.agent_id, seq: r.seq, role: r.role, text: r.text, at: iso(r.at) });

// ---- the session's side --------------------------------------------------------------------------

export function cursors(ctx: Ctx, taskId: string): SessionTranscriptCursors {
  const rows = ctx.db
    .prepare(
      `SELECT a.agent_id AS agentId, a.epoch AS epoch, COALESCE(MAX(e.seq), -1) AS lastSeq
       FROM transcript_agents a LEFT JOIN transcript_entries e ON e.task_id = a.task_id AND e.agent_id = a.agent_id
       WHERE a.task_id = ? GROUP BY a.agent_id, a.epoch ORDER BY a.agent_id`,
    )
    .all(taskId) as { agentId: string; epoch: string; lastSeq: number }[];
  return { agents: rows.map((r) => ({ agentId: r.agentId, epoch: r.epoch, lastSeq: Number(r.lastSeq) })) };
}

/**
 * Store part of one agent's timeline. An entry whose seq the server already has replaces it (the
 * session re-sends the last entry, which may have grown since). A new epoch (Paseo rebuilt the
 * timeline) replaces everything held for that agent.
 */
export function ingest(ctx: Ctx, task: TaskRow, body: SessionTranscriptRequest): SessionTranscriptCursors {
  const agentId = body?.agentId;
  if (typeof agentId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(agentId)) throw httpError("bad_request", "agentId must match [A-Za-z0-9._:-]{1,128}");
  if (typeof body.epoch !== "string" || !body.epoch || body.epoch.length > 128) throw httpError("bad_request", "epoch must be a string of 1..128 characters");
  if (!Array.isArray(body.entries) || body.entries.length > MAX_ENTRIES_PER_POST) throw httpError("bad_request", `entries must be a list of at most ${MAX_ENTRIES_PER_POST}`);
  const now = ctx.clock.now();
  const entries = body.entries.map((e) => {
    if (!e || !Number.isInteger(e.seq) || e.seq < 0) throw httpError("bad_request", "each entry needs a seq (an integer ≥ 0)");
    if (!ROLES.has(e.role)) throw httpError("bad_request", "role must be user, assistant or tool");
    if (typeof e.text !== "string") throw httpError("bad_request", "text must be a string");
    const at = Date.parse(String(e.at));
    return { seq: e.seq, role: e.role, text: trimText(e.text), at: Number.isFinite(at) ? at : now };
  });
  tx(ctx.db, () => {
    const held = ctx.db.prepare("SELECT epoch FROM transcript_agents WHERE task_id = ? AND agent_id = ?").get(task.id, agentId) as { epoch: string } | undefined;
    if (held?.epoch !== body.epoch) {
      ctx.db.prepare("DELETE FROM transcript_entries WHERE task_id = ? AND agent_id = ?").run(task.id, agentId);
      ctx.db
        .prepare("INSERT INTO transcript_agents(task_id, agent_id, epoch) VALUES (?, ?, ?) ON CONFLICT(task_id, agent_id) DO UPDATE SET epoch = excluded.epoch")
        .run(task.id, agentId, body.epoch);
    }
    const up = ctx.db.prepare(
      `INSERT INTO transcript_entries(task_id, user_id, agent_id, seq, role, text, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, agent_id, seq) DO UPDATE SET role = excluded.role, text = excluded.text, at = excluded.at
       WHERE transcript_entries.text <> excluded.text OR transcript_entries.role <> excluded.role`,
    );
    for (const e of entries) {
      if (e.text.trim()) up.run(task.id, task.user_id, agentId, e.seq, e.role, e.text, e.at);
      else ctx.db.prepare("DELETE FROM transcript_entries WHERE task_id = ? AND agent_id = ? AND seq = ?").run(task.id, agentId, e.seq);
    }
  });
  return cursors(ctx, task.id);
}

// ---- search ----------------------------------------------------------------------------------------

/** "foo bar" baz -> ["foo bar", "baz"]; lowercased, deduplicated, at most 8 terms. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 8);
}

const SNIPPET_CHARS = 200;

/** A window of `text` around the first match, and every match's [start, end) inside it. */
export function snippetOf(text: string, terms: string[]): { snippet: string; matches: [number, number][] } {
  const lower = text.toLowerCase();
  let first = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  let start = first < 0 ? 0 : Math.max(0, first - Math.floor(SNIPPET_CHARS / 3));
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  start = Math.max(0, Math.min(start, end - SNIPPET_CHARS));
  const pre = start > 0 ? "…" : "";
  const post = end < text.length ? "…" : "";
  const body = text.slice(start, end).replace(/\s+/g, " ");
  // whitespace collapsing changes offsets: search the collapsed body itself
  const snippet = pre + body + post;
  const low = snippet.toLowerCase();
  const ranges: [number, number][] = [];
  for (const t of terms) {
    const tt = t.replace(/\s+/g, " ");
    for (let i = low.indexOf(tt); i >= 0 && tt; i = low.indexOf(tt, i + tt.length)) ranges.push([i, i + tt.length]);
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return { snippet, matches: merged };
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => "\\" + c);

export interface SearchScope {
  /** null: everyone (admin). */
  userId: string | null;
  taskId?: string;
  limit: number;
}

/**
 * Every term must appear (AND). Terms of 3+ characters go through the trigram index (a phrase in
 * double quotes stays one term); shorter ones (the index can't hold them) are matched with LIKE on
 * the rows the index found, or, when every term is short, on the scope's rows, newest first.
 */
export function search(ctx: Ctx, q: unknown, scope: SearchScope): SearchResult {
  const query = typeof q === "string" ? q.trim() : "";
  if (!query || query.length > 200) throw httpError("bad_request", "q must be 1..200 characters");
  const terms = queryTerms(query);
  if (!terms.length) return { query, hits: [] };
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (scope.userId) where.push("e.user_id = ?"), args.push(scope.userId);
  if (scope.taskId) where.push("e.task_id = ?"), args.push(scope.taskId);
  for (const t of short) where.push("e.text LIKE ? ESCAPE '\\'"), args.push(`%${escapeLike(t)}%`);
  const cols = "e.*, t.title AS task_title, t.state AS task_state";
  let rows: (EntryRow & { task_title: string; task_state: TaskState })[];
  if (long.length) {
    const match = long.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
    rows = ctx.db
      .prepare(
        `SELECT ${cols} FROM transcript_fts f JOIN transcript_entries e ON e.id = f.rowid JOIN tasks t ON t.id = e.task_id
         WHERE transcript_fts MATCH ? ${where.map((w) => "AND " + w).join(" ")} ORDER BY bm25(transcript_fts), e.at DESC LIMIT ?`,
      )
      .all(match, ...args, scope.limit) as never;
  } else {
    rows = ctx.db
      .prepare(`SELECT ${cols} FROM transcript_entries e JOIN tasks t ON t.id = e.task_id WHERE ${where.join(" AND ")} ORDER BY e.at DESC, e.id DESC LIMIT ?`)
      .all(...args, scope.limit) as never;
  }
  const hits: SearchHit[] = rows.map((r) => ({
    ...entryView(r),
    taskId: r.task_id,
    taskTitle: r.task_title,
    taskState: r.task_state,
    userId: r.user_id,
    ...snippetOf(r.text, terms),
  }));
  return { query, hits };
}

// ---- reading a task's transcript ------------------------------------------------------------------------

export interface PageQuery {
  agentId?: string | null;
  around?: number;
  before?: number;
  after?: number;
  limit: number;
}

/** The agent a page is read from by default: the task's main agent, else the one with most entries. */
function defaultAgent(ctx: Ctx, task: TaskRow): string | null {
  if (task.agent_id) return task.agent_id;
  const r = ctx.db.prepare("SELECT agent_id FROM transcript_entries WHERE task_id = ? GROUP BY agent_id ORDER BY COUNT(*) DESC LIMIT 1").get(task.id) as
    | { agent_id: string }
    | undefined;
  return r?.agent_id ?? null;
}

export function page(ctx: Ctx, task: TaskRow, o: PageQuery): TranscriptPage {
  const agentId = o.agentId || defaultAgent(ctx, task);
  if (!agentId) return { taskId: task.id, entries: [], hasOlder: false, hasNewer: false };
  const sel = (sql: string, ...a: (string | number)[]) => ctx.db.prepare(`SELECT * FROM transcript_entries WHERE task_id = ? AND agent_id = ? ${sql}`).all(task.id, agentId, ...a) as unknown as EntryRow[];
  let rows: EntryRow[];
  if (o.around !== undefined) {
    const half = Math.max(1, Math.floor(o.limit / 2));
    const older = sel("AND seq < ? ORDER BY seq DESC LIMIT ?", o.around, half).reverse();
    rows = [...older, ...sel("AND seq >= ? ORDER BY seq ASC LIMIT ?", o.around, o.limit - older.length)];
  } else if (o.before !== undefined) {
    rows = sel("AND seq < ? ORDER BY seq DESC LIMIT ?", o.before, o.limit).reverse();
  } else if (o.after !== undefined) {
    rows = sel("AND seq > ? ORDER BY seq ASC LIMIT ?", o.after, o.limit);
  } else {
    rows = sel("ORDER BY seq ASC LIMIT ?", o.limit);
  }
  const exists = (sql: string, s: number) =>
    ctx.db.prepare(`SELECT 1 FROM transcript_entries WHERE task_id = ? AND agent_id = ? AND ${sql} LIMIT 1`).get(task.id, agentId, s) !== undefined;
  const first = rows[0]?.seq;
  const last = rows[rows.length - 1]?.seq;
  return {
    taskId: task.id,
    entries: rows.map(entryView),
    hasOlder: first !== undefined ? exists("seq < ?", first) : o.after !== undefined ? exists("seq <= ?", o.after) : false,
    hasNewer: last !== undefined ? exists("seq > ?", last) : o.before !== undefined ? exists("seq >= ?", o.before) : false,
  };
}

/** Parse ?around / ?before / ?after / ?limit / ?agentId of GET /api/tasks/:id/transcript. */
export function pageQuery(sp: URLSearchParams): PageQuery {
  const int = (k: string): number | undefined => {
    const v = sp.get(k);
    if (v === null || v === "") return undefined;
    if (!/^\d{1,15}$/.test(v)) throw httpError("bad_request", `${k} must be a whole number`);
    return Number(v);
  };
  const limit = int("limit") ?? 50;
  if (limit < 1 || limit > 200) throw httpError("bad_request", "limit must be 1..200");
  const q: PageQuery = { limit, agentId: sp.get("agentId") };
  const around = int("around"), before = int("before"), after = int("after");
  if ([around, before, after].filter((x) => x !== undefined).length > 1) throw httpError("bad_request", "give at most one of around, before, after");
  if (around !== undefined) q.around = around;
  if (before !== undefined) q.before = before;
  if (after !== undefined) q.after = after;
  return q;
}
