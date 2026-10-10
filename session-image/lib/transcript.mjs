// Transcript sync (docs/API.md section 14): the daemon's agent timelines -> POST /api/session/transcript,
// so the task owner can search the conversation from the app (live, paused or archived). Pure
// helpers here (unit-tested); the loop that drives them is in agent.mjs.
//
// What is kept per Paseo timeline entry: what the user said, what the agent answered, and each tool
// call as one line of name + input + output (trimmed, head and tail). Reasoning, todos, compaction
// markers and plugin items are left out.

/** Longest text sent per entry; the server keeps at most 8000 characters. */
export const ENTRY_CHARS = 4000;
/** Per POST: at most this many entries and about this many bytes of JSON (the server takes ≤ 1 MiB). */
export const BATCH_ENTRIES = 200;
export const BATCH_BYTES = 600_000;

export function trim(text, max = ENTRY_CHARS) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const half = Math.floor((max - 3) / 2);
  return `${s.slice(0, half)} … ${s.slice(s.length - half)}`;
}

const short = (v, max) => {
  if (v === undefined || v === null || v === "") return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return trim(s, max);
};

/** A tool call as one searchable line: name, what it was given, what came back (or the error). */
export function toolText(item) {
  const d = item.detail ?? {};
  const parts = [item.name || "tool"];
  switch (d.type) {
    case "shell":
      parts.push(short(d.command, 600), short(d.output, 1200));
      break;
    case "read":
    case "edit":
    case "write":
      parts.push(short(d.filePath ?? d.path, 300), short(d.content ?? d.newString ?? d.diff, 800));
      break;
    case "search":
    case "fetch":
      parts.push(short(d.query ?? d.url ?? d.pattern, 400), short(d.output ?? d.result, 1200));
      break;
    case "plain_text":
      parts.push(short(d.label, 200), short(d.text, 1400));
      break;
    case "sub_agent":
      parts.push(short(d.description, 400), short(d.log, 1200));
      break;
    case "plan":
      parts.push(short(d.text, 1600));
      break;
    default: {
      const rest = { ...d };
      delete rest.type;
      parts.push(short(rest.input ?? rest, 800), short(rest.output, 1200));
    }
  }
  if (item.status === "failed" && item.error) parts.push(`failed: ${short(item.error, 400)}`);
  return trim(parts.filter(Boolean).join(" — "));
}

/** One projected timeline entry (fetch_agent_timeline_response) -> a transcript entry, or null to skip. */
export function entryOf(e) {
  const item = e?.item;
  if (!item || typeof e.seqStart !== "number") return null;
  let role;
  let text;
  if (item.type === "user_message") (role = "user"), (text = item.text);
  else if (item.type === "assistant_message") (role = "assistant"), (text = item.text);
  else if (item.type === "tool_call") (role = "tool"), (text = toolText(item));
  else if (item.type === "error") (role = "assistant"), (text = `Error: ${item.message}`);
  else return null;
  text = trim(text);
  if (!text.trim()) return null;
  return { seq: e.seqStart, role, text, at: e.timestamp || new Date().toISOString() };
}

/** Split entries into POST-sized batches. */
export function batches(entries) {
  const out = [];
  let cur = [];
  let bytes = 0;
  for (const e of entries) {
    const n = Buffer.byteLength(JSON.stringify(e));
    if (cur.length && (cur.length >= BATCH_ENTRIES || bytes + n > BATCH_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Sync one agent: `fetchPage({cursor, limit})` is the daemon's timeline fetch ("after" a cursor,
 * projected), `post(body)` is POST /api/session/transcript (returns the server's cursors).
 * `held` = what the server holds for this agent ({epoch, lastSeq}) or null.
 *
 * The last entry the server holds is fetched again (its text may have grown: a reply still being
 * written at the previous sync); the server replaces an entry with the same seq. A changed epoch
 * (Paseo rebuilt the timeline) sends everything again, and the server drops what it held.
 * Returns the new {epoch, lastSeq} and how many entries went up.
 */
export async function syncAgent({ agentId, held, probe, fetchPage, post }) {
  const tail = await probe();
  const epoch = tail.epoch;
  const minSeq = tail.window?.minSeq ?? 0;
  const sameEpoch = held && held.epoch === epoch;
  let cursorSeq = sameEpoch ? Math.max(minSeq - 1, held.lastSeq - 1) : minSeq - 1;
  // nothing new since the last sync: the tail's last entry is the one the server already has
  const last = tail.entries?.[tail.entries.length - 1];
  if (sameEpoch && last && held.lastEnd !== undefined && last.seqEnd === held.lastEnd) {
    return { epoch, lastSeq: held.lastSeq, lastEnd: held.lastEnd, sent: 0 };
  }
  if (sameEpoch && !last) return { epoch, lastSeq: held.lastSeq, lastEnd: held.lastEnd, sent: 0 };
  let lastSeq = sameEpoch ? held.lastSeq : -1;
  let lastEnd = held?.lastEnd;
  let sent = 0;
  let registered = sameEpoch;
  for (let pages = 0; pages < 10_000; pages++) {
    // Paseo's cursor seq is ≥ 0; "after" with no cursor reads from the start of the window
    const page = await fetchPage({ cursor: cursorSeq >= 0 ? { epoch, seq: cursorSeq } : undefined, limit: 200 });
    if (page.epoch !== epoch || page.reset) throw new Error("the timeline changed while it was read; next sync starts over");
    const entries = (page.entries || []).map(entryOf).filter(Boolean);
    for (const b of batches(entries)) {
      await post({ agentId, epoch, entries: b });
      registered = true;
      sent += b.length;
    }
    const pe = page.entries || [];
    if (pe.length) {
      lastSeq = Math.max(lastSeq, ...entries.map((e) => e.seq));
      lastEnd = pe[pe.length - 1].seqEnd;
      cursorSeq = pe[pe.length - 1].seqEnd;
    }
    if (!page.hasNewer || !pe.length) break;
  }
  // a new epoch with nothing to send still replaces what the server holds
  if (!registered) await post({ agentId, epoch, entries: [] });
  return { epoch, lastSeq, lastEnd, sent };
}
