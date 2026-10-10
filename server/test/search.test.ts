// Transcript search: sessions report their timeline, people search their own tasks (live, paused,
// archived), admins anyone's; the reader pages through a task's conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, asService, createTask, fakeSession, GATE, type Harness, type Cred } from "./helpers.ts";
import { queryTerms, snippetOf, trimText } from "../src/transcripts.ts";

async function withUsers(fn: (h: Harness, u: Awaited<ReturnType<typeof seedUsers>>) => Promise<void>) {
  const h = await harness();
  try {
    await fn(h, await seedUsers(h));
  } finally {
    await h.close();
  }
}

const at = (i: number) => new Date(Date.UTC(2026, 9, 8, 12, i)).toISOString();

/** A task of `email` whose session reports `texts` (alternating user / assistant) for agent `agent`. */
async function taskWith(h: Harness, email: string, texts: string[], agent = "agent-main"): Promise<{ id: string; sess: Cred }> {
  const id = await createTask(h, email);
  const s = await fakeSession(h, id);
  const sess = await asService(h, GATE, s.token);
  await call(h, sess, "POST", "/api/session/status", { activity: "busy", agentId: agent });
  const r = await call(h, sess, "POST", "/api/session/transcript", {
    agentId: agent,
    epoch: "e1",
    entries: texts.map((text, i) => ({ seq: i * 2, role: i % 2 ? "assistant" : "user", text, at: at(i) })),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { id, sess };
}

test("query terms, snippets and trimming", () => {
  assert.deepEqual(queryTerms(`Invoice "ACME GmbH"  invoice 深圳`), ["invoice", "acme gmbh", "深圳"]);
  const { snippet, matches } = snippetOf("Before. The ACME GmbH invoice is due Friday; ACME pays late.", ["acme", "invoice"]);
  assert.equal(snippet, "Before. The ACME GmbH invoice is due Friday; ACME pays late.");
  assert.deepEqual(matches.map(([a, b]) => snippet.slice(a, b)), ["ACME", "invoice", "ACME"]);
  const long = "x".repeat(500) + " needle " + "y".repeat(500);
  const s2 = snippetOf(long, ["needle"]);
  assert.ok(s2.snippet.startsWith("…") && s2.snippet.endsWith("…") && s2.snippet.length <= 202, s2.snippet.length.toString());
  assert.equal(s2.snippet.slice(s2.matches[0]![0], s2.matches[0]![1]), "needle");
  assert.equal(trimText("a".repeat(20), 11), "aaaa … aaaa");
});

test("a person finds their own tasks' conversations, nobody else's; an admin finds everyone's", () =>
  withUsers(async (h, u) => {
    const a = await taskWith(h, u.alice, ["Please draft the ACME invoice reminder", "Done: the reminder to ACME is in drafts.", "请把深圳的报价单发给我", "好的，深圳报价单已发送。"]);
    await taskWith(h, u.bob, ["Bob's ACME contract renewal", "Renewal noted."]);
    const alice = await asEmail(h, u.alice);
    const bob = await asEmail(h, u.bob);
    const admin = await asEmail(h, u.admin);
    const aliceId = (await call(h, alice, "GET", "/api/me")).body.user.id;

    const mine = await call(h, alice, "GET", "/api/search?q=acme");
    assert.equal(mine.status, 200);
    assert.equal(mine.body.hits.length, 2);
    assert.ok(mine.body.hits.every((x: { taskId: string; userId: string }) => x.taskId === a.id && x.userId === aliceId));
    const hit = mine.body.hits[0];
    assert.ok(hit.taskTitle && hit.taskState && hit.agentId === "agent-main" && typeof hit.seq === "number");
    assert.deepEqual(hit.matches.map(([s, e]: [number, number]) => hit.snippet.slice(s, e).toLowerCase()), ["acme"]);

    // Chinese substrings, case-insensitive phrases, AND of terms, short terms
    assert.equal((await call(h, alice, "GET", `/api/search?q=${encodeURIComponent("深圳报价单")}`)).body.hits.length, 1);
    assert.equal((await call(h, alice, "GET", `/api/search?q=${encodeURIComponent('"acme invoice"')}`)).body.hits.length, 1);
    assert.equal((await call(h, alice, "GET", `/api/search?q=${encodeURIComponent("acme drafts")}`)).body.hits.length, 1);
    assert.equal((await call(h, alice, "GET", `/api/search?q=${encodeURIComponent("深圳")}`)).body.hits.length, 2, "a 2-character term");
    assert.equal((await call(h, alice, "GET", `/api/search?q=${encodeURIComponent("acme 深圳")}`)).body.hits.length, 0);

    // bob sees only his own; his userId filter on alice is a 404
    const bobs = (await call(h, bob, "GET", "/api/search?q=acme")).body.hits;
    assert.deepEqual(bobs.map((x: { text: string }) => x.text), ["Bob's ACME contract renewal"]);
    assert.equal((await call(h, bob, "GET", `/api/search?q=acme&userId=${aliceId}`)).status, 404);
    assert.equal((await call(h, bob, "GET", `/api/search?q=acme&taskId=${a.id}`)).status, 404);
    assert.equal((await call(h, bob, "GET", `/api/search?q=acme&all=1`)).status, 404);
    assert.equal((await call(h, bob, "GET", `/api/tasks/${a.id}/transcript`)).status, 404);

    // the admin: own by default, anyone's on request
    assert.equal((await call(h, admin, "GET", "/api/search?q=acme")).body.hits.length, 0);
    assert.equal((await call(h, admin, "GET", "/api/search?q=acme&all=1")).body.hits.length, 3);
    assert.equal((await call(h, admin, "GET", `/api/search?q=acme&userId=${aliceId}`)).body.hits.length, 2);
    assert.equal((await call(h, admin, "GET", `/api/search?q=acme&taskId=${a.id}`)).body.hits.length, 2);
    assert.equal((await call(h, alice, "GET", `/api/search?q=acme&taskId=${a.id}&limit=1`)).body.hits.length, 1);

    // bad queries
    assert.equal((await call(h, alice, "GET", "/api/search")).status, 400);
    assert.equal((await call(h, alice, "GET", `/api/search?q=${"x".repeat(201)}`)).status, 400);
    assert.equal((await call(h, alice, "GET", "/api/search?q=acme&limit=0")).status, 400);
    assert.equal((await call(h, alice, "GET", `/api/search?q=${encodeURIComponent('"*" OR NEAR(')}`)).status, 200, "FTS syntax is quoted, not parsed");

    // a session searches its owner's tasks only
    const fromSession = await call(h, a.sess, "GET", "/api/session/search?q=acme");
    assert.equal(fromSession.body.hits.length, 2);
    assert.ok(!fromSession.body.hits.some((x: { text: string }) => x.text.includes("Bob")));
    // and reads its owner's transcripts, nobody else's
    assert.equal((await call(h, a.sess, "GET", `/api/session/tasks/${a.id}/transcript?around=2&limit=2`)).body.entries.length, 2);
    const bobTask = (await call(h, bob, "GET", "/api/tasks")).body.tasks[0].id;
    assert.equal((await call(h, a.sess, "GET", `/api/session/tasks/${bobTask}/transcript`)).status, 404);
  }));

test("re-sent entries replace, a new epoch replaces the agent's transcript, cursors say what is held", () =>
  withUsers(async (h, u) => {
    const a = await taskWith(h, u.alice, ["first question", "partial answ"]);
    const alice = await asEmail(h, u.alice);
    let cur = (await call(h, a.sess, "GET", "/api/session/transcript")).body;
    assert.deepEqual(cur, { agents: [{ agentId: "agent-main", epoch: "e1", lastSeq: 2 }] });
    // the last entry grew: same seq, new text
    cur = (await call(h, a.sess, "POST", "/api/session/transcript", { agentId: "agent-main", epoch: "e1", entries: [{ seq: 2, role: "assistant", text: "partial answer, now complete", at: at(2) }, { seq: 3, role: "tool", text: "bash: ls -> report.md", at: at(3) }] })).body;
    assert.deepEqual(cur.agents, [{ agentId: "agent-main", epoch: "e1", lastSeq: 3 }]);
    assert.equal((await call(h, alice, "GET", "/api/search?q=partial")).body.hits[0].text, "partial answer, now complete");
    assert.equal((await call(h, alice, "GET", "/api/search?q=report.md")).body.hits[0].role, "tool");
    // a second agent
    await call(h, a.sess, "POST", "/api/session/transcript", { agentId: "agent-sub", epoch: "x", entries: [{ seq: 0, role: "user", text: "sub agent work", at: at(9) }] });
    // a new epoch for the main agent: what was held for it goes, the other agent stays
    cur = (await call(h, a.sess, "POST", "/api/session/transcript", { agentId: "agent-main", epoch: "e2", entries: [{ seq: 0, role: "user", text: "rebuilt timeline", at: at(5) }] })).body;
    assert.deepEqual(cur.agents, [{ agentId: "agent-main", epoch: "e2", lastSeq: 0 }, { agentId: "agent-sub", epoch: "x", lastSeq: 0 }]);
    assert.equal((await call(h, alice, "GET", "/api/search?q=partial")).body.hits.length, 0);
    assert.equal((await call(h, alice, "GET", "/api/search?q=rebuilt")).body.hits.length, 1);
    assert.equal((await call(h, alice, "GET", "/api/search?q=sub agent")).body.hits.length, 1);
    // validation
    for (const bad of [
      { agentId: "bad agent", epoch: "e", entries: [] },
      { agentId: "a", epoch: "", entries: [] },
      { agentId: "a", epoch: "e", entries: [{ seq: -1, role: "user", text: "x", at: at(0) }] },
      { agentId: "a", epoch: "e", entries: [{ seq: 1, role: "system", text: "x", at: at(0) }] },
      { agentId: "a", epoch: "e", entries: Array.from({ length: 501 }, (_, i) => ({ seq: i, role: "user", text: "x", at: at(0) })) },
    ]) {
      assert.equal((await call(h, a.sess, "POST", "/api/session/transcript", bad)).status, 400, JSON.stringify(bad).slice(0, 80));
    }
    // a long text is trimmed, head and tail kept
    await call(h, a.sess, "POST", "/api/session/transcript", { agentId: "agent-main", epoch: "e2", entries: [{ seq: 1, role: "tool", text: "HEAD" + "z".repeat(20000) + "TAIL", at: at(6) }] });
    const page = (await call(h, alice, "GET", `/api/tasks/${a.id}/transcript`)).body;
    const t = page.entries.find((e: { seq: number }) => e.seq === 1).text;
    assert.ok(t.length <= 8000 && t.startsWith("HEAD") && t.endsWith("TAIL"));
  }));

test("the reader pages through a task's conversation; archived tasks stay searchable", () =>
  withUsers(async (h, u) => {
    const texts = Array.from({ length: 30 }, (_, i) => `message number ${i}${i === 17 ? " with the NEEDLE" : ""}`);
    const a = await taskWith(h, u.alice, texts);
    const alice = await asEmail(h, u.alice);
    const hit = (await call(h, alice, "GET", "/api/search?q=needle")).body.hits[0];
    assert.equal(hit.seq, 34);
    const around = (await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?around=${hit.seq}&limit=6`)).body;
    assert.deepEqual(around.entries.map((e: { seq: number }) => e.seq), [28, 30, 32, 34, 36, 38]);
    assert.equal(around.hasOlder, true);
    assert.equal(around.hasNewer, true);
    const first = (await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?limit=3`)).body;
    assert.deepEqual(first.entries.map((e: { seq: number }) => e.seq), [0, 2, 4]);
    assert.equal(first.hasOlder, false);
    const older = (await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?before=4&limit=10`)).body;
    assert.deepEqual(older.entries.map((e: { seq: number }) => e.seq), [0, 2]);
    const newer = (await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?after=54&limit=10`)).body;
    assert.deepEqual(newer.entries.map((e: { seq: number }) => e.seq), [56, 58]);
    assert.equal(newer.hasNewer, false);
    assert.equal(newer.hasOlder, true);
    assert.equal((await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?agentId=nobody`)).body.entries.length, 0);
    assert.equal((await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?around=1&before=2`)).status, 400);
    assert.equal((await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?limit=500`)).status, 400);

    // destroy: archived, and still found and readable
    assert.equal((await call(h, alice, "DELETE", `/api/tasks/${a.id}`)).status, 202);
    await h.jarvis.settle();
    const after = (await call(h, alice, "GET", "/api/search?q=needle")).body.hits;
    assert.equal(after.length, 1);
    assert.equal(after[0].taskState, "archived");
    assert.equal((await call(h, alice, "GET", `/api/tasks/${a.id}/transcript?around=34&limit=2`)).body.entries.length, 2);
    // the dead machine's session token can't add to it
    assert.equal((await call(h, a.sess, "POST", "/api/session/transcript", { agentId: "agent-main", epoch: "e1", entries: [] })).status, 401);
  }));
