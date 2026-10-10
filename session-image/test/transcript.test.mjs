// Transcript sync: what a timeline entry becomes, batching, and the sync of one agent against a
// stand-in daemon timeline and server (re-send of the last entry, nothing-new, a new epoch, paging).
import { test } from "node:test";
import assert from "node:assert/strict";
import { batches, entryOf, syncAgent, toolText, trim, BATCH_ENTRIES } from "../lib/transcript.mjs";

const ts = "2026-10-08T12:00:00.000Z";
const user = (seq, text) => ({ seqStart: seq, seqEnd: seq, timestamp: ts, item: { type: "user_message", text } });
const reply = (seq, end, text) => ({ seqStart: seq, seqEnd: end, timestamp: ts, item: { type: "assistant_message", text } });

test("entries: user, assistant, tool calls and errors are kept; the rest is skipped", () => {
  assert.deepEqual(entryOf(user(3, "hi")), { seq: 3, role: "user", text: "hi", at: ts });
  assert.equal(entryOf(reply(4, 9, "hello")).role, "assistant");
  assert.equal(entryOf({ seqStart: 5, seqEnd: 5, timestamp: ts, item: { type: "reasoning", text: "hmm" } }), null);
  assert.equal(entryOf({ seqStart: 5, seqEnd: 5, timestamp: ts, item: { type: "todo", items: [] } }), null);
  assert.equal(entryOf(user(6, "   ")), null);
  assert.equal(entryOf({ seqStart: 7, seqEnd: 7, timestamp: ts, item: { type: "error", message: "rate limited" } }).text, "Error: rate limited");
  const tool = entryOf({
    seqStart: 8,
    seqEnd: 10,
    timestamp: ts,
    item: { type: "tool_call", callId: "c", name: "bash", status: "completed", error: null, detail: { type: "shell", command: "ls ~/files", output: "report.md\n" } },
  });
  assert.equal(tool.role, "tool");
  assert.equal(tool.text, "bash — ls ~/files — report.md\n");
  const failed = toolText({ name: "webfetch", status: "failed", error: "404", detail: { type: "unknown", input: { url: "https://x" }, output: null } });
  assert.match(failed, /^webfetch — \{"url":"https:\/\/x"\} — failed: 404$/);
  assert.equal(trim("a".repeat(20), 11), "aaaa … aaaa");
  assert.ok(entryOf(user(1, "x".repeat(10000))).text.length <= 4000);
});

test("batches stay under the entry and byte limits", () => {
  const many = Array.from({ length: 450 }, (_, i) => ({ seq: i, role: "user", text: "x", at: ts }));
  assert.deepEqual(batches(many).map((b) => b.length), [BATCH_ENTRIES, BATCH_ENTRIES, 50]);
  const big = Array.from({ length: 400 }, (_, i) => ({ seq: i, role: "tool", text: "y".repeat(4000), at: ts }));
  for (const b of batches(big)) assert.ok(Buffer.byteLength(JSON.stringify(b)) < 1024 * 1024);
});

/** A stand-in daemon timeline (projected entries) with the "after" semantics of Paseo's store. */
function timeline(entries, epoch = "e1") {
  const t = { epoch, entries, fetches: [] };
  t.probe = async () => ({ epoch: t.epoch, window: { minSeq: 0 }, entries: t.entries.slice(-1) });
  t.fetchPage = async ({ cursor, limit }) => {
    if (cursor) assert.ok(cursor.seq >= 0, "Paseo refuses a negative cursor");
    t.fetches.push(cursor ? cursor.seq : -1);
    if (cursor && cursor.epoch !== t.epoch) return { epoch: t.epoch, reset: true, entries: [], hasNewer: false };
    const after = t.entries.filter((e) => e.seqEnd > (cursor ? cursor.seq : -1));
    return { epoch: t.epoch, reset: false, entries: after.slice(0, limit), hasNewer: after.length > limit };
  };
  return t;
}
/** A stand-in server: what it holds per agent. */
function server() {
  const s = { posts: [], held: new Map() };
  s.post = async (body) => {
    s.posts.push(body);
    let h = s.held.get(body.agentId);
    if (!h || h.epoch !== body.epoch) s.held.set(body.agentId, (h = { epoch: body.epoch, entries: new Map() }));
    for (const e of body.entries) h.entries.set(e.seq, e);
  };
  return s;
}

test("sync: first time everything, then only the last entry again and what is new", async () => {
  const tl = timeline([user(0, "question"), reply(1, 3, "partial")]);
  const sv = server();
  const run = (held) => syncAgent({ agentId: "a1", held, probe: tl.probe, fetchPage: tl.fetchPage, post: sv.post });
  let held = await run(null);
  assert.deepEqual(held, { epoch: "e1", lastSeq: 1, lastEnd: 3, sent: 2 });
  assert.deepEqual(tl.fetches, [-1]);

  // nothing new: no fetch, no post
  const posts = sv.posts.length;
  const same = await run(held);
  assert.equal(same.sent, 0);
  assert.equal(sv.posts.length, posts);
  assert.deepEqual(tl.fetches, [-1]);

  // the reply grew and a tool call followed: the reply is sent again (same seq), then the tool call
  tl.entries[1] = reply(1, 5, "partial answer, complete");
  tl.entries.push({ seqStart: 6, seqEnd: 7, timestamp: ts, item: { type: "tool_call", name: "bash", status: "completed", error: null, detail: { type: "shell", command: "date", output: "Thu" } } });
  held = await run(held);
  assert.equal(held.sent, 2);
  assert.equal(held.lastSeq, 6);
  assert.equal(tl.fetches.at(-1), 0, "fetched again from just before the last entry the server holds");
  assert.equal(sv.held.get("a1").entries.get(1).text, "partial answer, complete");
  assert.equal(sv.held.get("a1").entries.size, 3);
});

test("sync: a new epoch sends everything again; an empty new epoch still replaces", async () => {
  const sv = server();
  let tl = timeline([user(0, "old")], "e1");
  const held = await syncAgent({ agentId: "a1", held: null, probe: tl.probe, fetchPage: tl.fetchPage, post: sv.post });
  tl = timeline([user(0, "rebuilt"), reply(1, 1, "again")], "e2");
  const next = await syncAgent({ agentId: "a1", held, probe: tl.probe, fetchPage: tl.fetchPage, post: sv.post });
  assert.equal(next.epoch, "e2");
  assert.equal(next.sent, 2);
  assert.equal(sv.held.get("a1").entries.get(0).text, "rebuilt");
  const empty = timeline([], "e3");
  await syncAgent({ agentId: "a1", held: next, probe: empty.probe, fetchPage: empty.fetchPage, post: sv.post });
  assert.equal(sv.held.get("a1").epoch, "e3");
  assert.equal(sv.held.get("a1").entries.size, 0);
});

test("sync: long timelines are read in pages and posted in batches", async () => {
  const sv = server();
  const tl = timeline(Array.from({ length: 450 }, (_, i) => user(i, `m${i}`)));
  const r = await syncAgent({ agentId: "a1", held: null, probe: tl.probe, fetchPage: tl.fetchPage, post: sv.post });
  assert.equal(r.sent, 450);
  assert.equal(r.lastSeq, 449);
  assert.deepEqual(tl.fetches, [-1, 199, 399]);
  assert.equal(sv.held.get("a1").entries.size, 450);
  // a cursor from the server (no local lastEnd yet, after a reboot): re-reads from its last entry
  const again = await syncAgent({ agentId: "a1", held: { epoch: "e1", lastSeq: 449 }, probe: tl.probe, fetchPage: tl.fetchPage, post: sv.post });
  assert.equal(again.sent, 1);
});
