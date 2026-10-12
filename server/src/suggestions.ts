// "Suggest for everyone" (DESIGN, Environment layers): part of a user's personal layer becomes a
// pull request on the org-env repo, for an admin to review and merge. The server holds the only
// credential (OrgEnvForge); the user and the session never touch git.
//
//   skill         skills/<name>/ in the org-env repo becomes exactly the personal skill's files
//   instructions  the personal instructions are appended to AGENTS.md
//   note          one "remember" note is appended to AGENTS.md as a bullet
import type { SuggestRequest, SuggestionView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice, isAdminRole } from "./ctx.ts";
import type { UserRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { httpError, HttpError } from "./errors.ts";
import { GitHubError } from "./github.ts";
import { getPersonal } from "./layers.ts";
import type { PullRequestState } from "./providers.ts";

export interface SuggestionRow {
  id: string;
  user_id: string;
  by_user_id: string;
  kind: SuggestionView["kind"];
  name: string;
  title: string;
  branch: string;
  pr_number: number;
  pr_url: string;
  state: PullRequestState;
  created_at: number;
  updated_at: number;
  checked_at: number;
}

/** Open suggestions a user may have at once. */
export const MAX_OPEN = 20;
/** A listing re-checks an open pull request at most this often. */
export const RECHECK_MS = 60_000;

export const suggestionsEnabled = (ctx: Ctx): boolean => !!ctx.forge;

export function suggestionView(ctx: Ctx, s: SuggestionRow): SuggestionView {
  const u = ctx.db.prepare("SELECT email FROM users WHERE id = ?").get(s.user_id) as { email: string } | undefined;
  return {
    id: s.id,
    userId: s.user_id,
    userEmail: u?.email ?? "",
    byUserId: s.by_user_id,
    kind: s.kind,
    name: s.name,
    title: s.title,
    number: s.pr_number,
    url: s.pr_url,
    state: s.state,
    createdAt: iso(s.created_at),
    updatedAt: iso(s.updated_at),
    checkedAt: iso(s.checked_at),
  };
}

const appendSection = (existing: string | null, text: string): string => {
  const base = (existing ?? "").replace(/\s+$/, "");
  return (base ? `${base}\n\n` : "") + text.trim() + "\n";
};

const quote = (s: string) => s.split("\n").map((l) => `> ${l}`).join("\n");

function admins(ctx: Ctx): UserRow[] {
  return (ctx.db.prepare("SELECT * FROM users WHERE status = 'active'").all() as unknown as UserRow[]).filter((u) => isAdminRole(ctx.config, u.role));
}

/** Open a pull request for part of `owner`'s personal layer. `by` pressed the button (owner or admin). */
export async function suggest(ctx: Ctx, owner: UserRow, by: UserRow, body: SuggestRequest): Promise<SuggestionRow> {
  if (!ctx.forge) throw httpError("conflict", "Suggest for everyone is not set up on this instance");
  if (!body || typeof body !== "object") throw httpError("bad_request", "body must be an object");
  const message = body.message;
  if (message !== undefined && (typeof message !== "string" || message.length > 4000)) throw httpError("bad_request", "message must be ≤ 4000 characters");
  const layer = getPersonal(ctx, owner.id).data;
  const who = owner.name ? `${owner.name} (${owner.email})` : owner.email;
  let name: string, title: string, what: string, edit: Parameters<NonNullable<Ctx["forge"]>["openPullRequest"]>[0]["edit"];
  if (body.kind === "skill") {
    const skill = layer.skills.find((s) => s.name === body.name);
    if (typeof body.name !== "string" || !skill) throw httpError("not_found", "no such skill");
    name = skill.name;
    title = `Suggest skill "${name}" for everyone`;
    what = `the skill \`${name}\` from ${who}'s personal layer as \`skills/${name}/\``;
    const dir = `skills/${name}/`;
    edit = async (base) => {
      const out: Record<string, string | null> = {};
      for (const p of await base.list(dir)) out[p] = null; // files the personal skill doesn't have go
      for (const [rel, text] of Object.entries(skill.files)) out[dir + rel] = text;
      return out;
    };
  } else if (body.kind === "instructions") {
    const text = layer.instructions.trim();
    if (!text) throw httpError("conflict", "the personal instructions are empty");
    name = "";
    title = `Suggest ${owner.name || owner.email}'s instructions for everyone`;
    what = `${who}'s personal instructions, appended to \`AGENTS.md\``;
    edit = async (base) => ({ "AGENTS.md": appendSection(await base.read("AGENTS.md"), text) });
  } else if (body.kind === "note") {
    const note = layer.notes.find((n) => n.id === body.noteId);
    if (typeof body.noteId !== "string" || !note) throw httpError("not_found", "no such note");
    name = note.id;
    title = `Suggest a note for everyone: ${note.text.replace(/\s+/g, " ").slice(0, 60)}`;
    what = `a note from ${who}'s personal layer, appended to \`AGENTS.md\``;
    edit = async (base) => ({ "AGENTS.md": appendSection(await base.read("AGENTS.md"), `- ${note.text.replace(/\n+/g, " ")}`) });
  } else {
    throw httpError("bad_request", "kind must be skill, instructions or note");
  }
  const dup = ctx.db.prepare("SELECT * FROM suggestions WHERE user_id = ? AND kind = ? AND name = ? AND state = 'open'").get(owner.id, body.kind, name) as
    | SuggestionRow
    | undefined;
  if (dup) throw httpError("conflict", `already suggested and still open: ${dup.pr_url}`);
  const open = ctx.db.prepare("SELECT COUNT(*) AS n FROM suggestions WHERE user_id = ? AND state = 'open'").get(owner.id) as { n: number };
  if (open.n >= MAX_OPEN) throw httpError("conflict", `at most ${MAX_OPEN} open suggestions per person`);

  const id = randomId();
  const branch = `jarvis/suggest-${body.kind}-${(name || "instructions").slice(0, 40)}-${id.slice(0, 6)}`;
  const lines = [
    `Suggested for everyone from Jarvis: ${what}.`,
    by.id !== owner.id ? `\nOpened by ${by.name || by.email} (admin) on ${who}'s behalf.` : "",
    message?.trim() ? `\nTheir note:\n\n${quote(message.trim())}` : "",
    `\nMerging makes it part of the org layer for every new task once the instance's pinned org-env commit (\`orgEnv.commit\`) is moved past the merge.`,
  ];
  let pr: { number: number; url: string };
  try {
    pr = await ctx.forge.openPullRequest({ branch, title, body: lines.filter(Boolean).join("\n"), message: title, edit });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof GitHubError && e.status === 409) throw httpError("conflict", e.message);
    throw httpError("upstream", `could not open the pull request: ${(e as Error).message}`.slice(0, 400));
  }
  const now = ctx.clock.now();
  ctx.db
    .prepare(
      "INSERT INTO suggestions(id, user_id, by_user_id, kind, name, title, branch, pr_number, pr_url, state, created_at, updated_at, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
    )
    .run(id, owner.id, by.id, body.kind, name, title, branch, pr.number, pr.url, now, now, now);
  for (const a of admins(ctx)) addNotice(ctx, a.id, "suggestion", `${owner.email} suggested something for everyone: ${title} — ${pr.url}`);
  ctx.log("suggestion opened", { user: owner.id, kind: body.kind, pr: pr.number });
  return getSuggestion(ctx, id)!;
}

export function getSuggestion(ctx: Ctx, id: string): SuggestionRow | null {
  return (ctx.db.prepare("SELECT * FROM suggestions WHERE id = ?").get(id) as SuggestionRow | undefined) ?? null;
}

export function listSuggestions(ctx: Ctx, userId: string | null): SuggestionRow[] {
  return (
    userId
      ? ctx.db.prepare("SELECT * FROM suggestions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").all(userId)
      : ctx.db.prepare("SELECT * FROM suggestions ORDER BY created_at DESC, rowid DESC").all()
  ) as unknown as SuggestionRow[];
}

/**
 * Re-read the state of open pull requests last checked before `olderThan` ms ago. A merge or a
 * close is recorded and the owner gets a notice. A forge error leaves the row as it was.
 */
export async function refreshSuggestions(ctx: Ctx, rows: SuggestionRow[], olderThan = RECHECK_MS): Promise<void> {
  if (!ctx.forge) return;
  const now = ctx.clock.now();
  for (const s of rows) {
    if (s.state !== "open" || now - s.checked_at < olderThan) continue;
    let state: PullRequestState;
    try {
      state = await ctx.forge.pullRequestState(s.pr_number);
    } catch (e) {
      ctx.log("suggestion check failed", { id: s.id, error: (e as Error).message });
      continue;
    }
    const t = ctx.clock.now();
    if (state === s.state) {
      ctx.db.prepare("UPDATE suggestions SET checked_at = ? WHERE id = ?").run(t, s.id);
      continue;
    }
    ctx.db.prepare("UPDATE suggestions SET state = ?, checked_at = ?, updated_at = ? WHERE id = ?").run(state, t, t, s.id);
    const text =
      state === "merged"
        ? `Your suggestion was accepted for everyone: ${s.title}. It reaches new chats once the instance loads the new org-env commit.`
        : `Your suggestion was closed without being merged: ${s.title}.`;
    addNotice(ctx, s.user_id, "suggestion", `${text} — ${s.pr_url}`);
  }
}
