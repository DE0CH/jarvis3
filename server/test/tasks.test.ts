// The task lifecycle against the fake provider: create -> running -> idle -> pause (snapshot ->
// destroy) -> resume (new machine from the snapshot) -> destroy (archive first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, asService, createTask, fakeSession, machineOf, GATE, type Harness } from "./helpers.ts";

async function withAlice(fn: (h: Harness, alice: string) => Promise<void>) {
  const h = await harness();
  try {
    const u = await seedUsers(h);
    await fn(h, u.alice);
  } finally {
    await h.close();
  }
}
const get = async (h: Harness, email: string, id: string) => (await call(h, await asEmail(h, email), "GET", `/api/tasks/${id}`)).body;

test("create: machine gets the right env; state starting until the session dials in", () =>
  withAlice(async (h, alice) => {
    const r = await call(h, await asEmail(h, alice), "POST", "/api/tasks", { prompt: "Write the weekly report\nwith numbers", model: "openai/gpt-test" });
    assert.equal(r.status, 201);
    assert.equal(r.body.state, "starting");
    assert.equal(r.body.title, "Write the weekly report");
    assert.equal(r.body.busy?.kind, "creating");
    await h.jarvis.settle();
    const m = machineOf(h, r.body.id)!;
    assert.equal(m.state, "started");
    assert.equal(m.image, "ghcr.io/example/session:test");
    assert.equal(m.env.JARVIS_FIRST_PROMPT, "Write the weekly report\nwith numbers");
    assert.equal(m.env.JARVIS_TASK_TITLE, "Write the weekly report");
    assert.equal(m.env.JARVIS_MODEL, "openai/gpt-test");
    assert.equal(m.env.JARVIS_URL, "https://jarvis.example.org");
    assert.equal(m.env.CF_ACCESS_CLIENT_ID, GATE);
    assert.match(m.env.OPENROUTER_API_KEY!, /^sk-or-v1-fake-/);
    assert.match(m.env.PASEO_PASSWORD!, /^[0-9a-f]{64}$/);
    assert.equal(m.env.JARVIS_RESTORE_URL, undefined);
    assert.equal(m.metadata.jarvisTask, r.body.id);
    // nothing admin-capable in the machine
    for (const k of Object.keys(m.env)) assert.ok(!/FLY|S3_|OPENROUTER_MANAGEMENT|CF_DEVICE|GOOGLE|DB_KEY/.test(k), k);
    const before = await get(h, alice, r.body.id);
    assert.equal(before.state, "starting");
    assert.equal(before.connected, false);
    const s = await fakeSession(h, r.body.id);
    const after = await get(h, alice, r.body.id);
    assert.equal(after.state, "running");
    assert.equal(after.connected, true);
    s.ws.close();
  }));

test("validation: prompt, model, requestId; idempotent create", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    assert.equal((await call(h, c, "POST", "/api/tasks", { prompt: "" })).status, 400);
    assert.equal((await call(h, c, "POST", "/api/tasks", { prompt: "x".repeat(16001) })).status, 400);
    assert.equal((await call(h, c, "POST", "/api/tasks", { prompt: "x", model: "some/other-model" })).status, 400);
    assert.equal((await call(h, c, "POST", "/api/tasks", { prompt: "x", requestId: "bad id!" })).status, 400);
    const a = await call(h, c, "POST", "/api/tasks", { prompt: "x", requestId: "req-1" });
    const b = await call(h, c, "POST", "/api/tasks", { prompt: "x", requestId: "req-1" });
    assert.equal(a.body.id, b.body.id);
    await h.jarvis.settle();
    assert.equal(h.machines.machines.size, 1);
  }));

test("status reports: busy/idle and title; idle auto-pause after idleMinutes", () =>
  withAlice(async (h, alice) => {
    const id = await createTask(h, alice);
    const s = await fakeSession(h, id);
    const sess = await asService(h, GATE, s.token);
    const idle = await call(h, sess, "POST", "/api/session/status", { activity: "idle", title: "Weekly report" });
    assert.equal(idle.body.state, "idle");
    assert.equal(idle.body.title, "Weekly report");
    assert.equal((await call(h, sess, "POST", "/api/session/status", { activity: "nap" })).status, 400);
    h.clock.advance(59 * 60_000);
    await h.jarvis.tick();
    assert.equal((await get(h, alice, id)).state, "idle");
    h.clock.advance(2 * 60_000);
    await h.jarvis.tick();
    await h.jarvis.settle();
    const t = await get(h, alice, id);
    assert.equal(t.state, "paused");
    assert.equal(t.pausedReason, "idle");
  }));

test("the session reports the task's agent id; it is in TaskView and survives pause/resume", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    const id = await createTask(h, alice);
    assert.equal((await get(h, alice, id)).agentId, null, "null until the session reports it");
    const s = await fakeSession(h, id);
    const sess = await asService(h, GATE, s.token);
    for (const bad of ["", "has space", "x".repeat(129), 42]) {
      assert.equal((await call(h, sess, "POST", "/api/session/status", { activity: "busy", agentId: bad })).status, 400, String(bad));
    }
    const r = await call(h, sess, "POST", "/api/session/status", { activity: "busy", agentId: "agent_01J9:main" });
    assert.equal(r.body.agentId, "agent_01J9:main");
    // a report without it keeps it
    await call(h, sess, "POST", "/api/session/status", { activity: "idle" });
    assert.equal((await get(h, alice, id)).agentId, "agent_01J9:main");
    assert.equal((await call(h, c, "GET", "/api/tasks")).body.tasks[0].agentId, "agent_01J9:main");
    await call(h, c, "POST", `/api/tasks/${id}/pause`);
    await h.jarvis.settle();
    assert.equal((await get(h, alice, id)).agentId, "agent_01J9:main", "kept while paused");
    await call(h, c, "POST", `/api/tasks/${id}/resume`);
    await h.jarvis.settle();
    const s2 = await fakeSession(h, id);
    assert.equal((await get(h, alice, id)).agentId, "agent_01J9:main", "kept after resume");
    s.ws.close();
    s2.ws.close();
  }));

test("pause snapshots then destroys; the session token dies; resume restores on a new machine; destroy archives", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    const id = await createTask(h, alice);
    const s = await fakeSession(h, id);
    const firstMachine = machineOf(h, id)!.id;
    const oldToken = s.token;

    let release!: () => void;
    h.machines.hold = new Promise<void>((r) => (release = r));
    const p = await call(h, c, "POST", `/api/tasks/${id}/pause`);
    assert.equal(p.status, 202);
    assert.equal(p.body.state, "pausing");
    assert.equal(p.body.busy.kind, "pausing");
    // a second op while one runs: busy
    const clash = await call(h, c, "DELETE", `/api/tasks/${id}`);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, "busy");
    assert.equal((await get(h, alice, id)).busy.kind, "pausing");
    h.machines.hold = null;
    release();
    await h.jarvis.settle();
    let t = await get(h, alice, id);
    assert.equal(t.state, "paused");
    assert.equal(t.pausedReason, "user");
    assert.equal(t.connected, false);
    assert.ok(h.blobs.objects.has(`snapshots/${id}/state.tar.gz`));
    assert.ok(h.machines.destroyed.includes(firstMachine));
    assert.equal((await call(h, await asService(h, GATE, oldToken), "GET", "/api/session/bundle")).status, 401, "old token is dead");
    // pause again / daemon while paused
    assert.equal((await call(h, c, "POST", `/api/tasks/${id}/pause`)).status, 409);

    const r = await call(h, c, "POST", `/api/tasks/${id}/resume`);
    assert.equal(r.status, 202);
    await h.jarvis.settle();
    const m2 = machineOf(h, id)!;
    assert.notEqual(m2.id, firstMachine);
    assert.equal(m2.env.JARVIS_RESTORE_URL, `fake-s3://get/snapshots/${id}/state.tar.gz?expires=3600`);
    assert.equal(m2.env.JARVIS_FIRST_PROMPT, undefined, "the first prompt is not replayed");
    assert.equal(m2.env.JARVIS_TASK_TITLE, undefined);
    assert.notEqual(m2.env.JARVIS_SESSION_TOKEN, oldToken);
    assert.equal(m2.env.PASEO_PASSWORD, machineOf(h, id)!.env.PASEO_PASSWORD);
    assert.equal((await call(h, c, "POST", `/api/tasks/${id}/resume`)).status, 409, "already resumed");
    const s2 = await fakeSession(h, id);
    assert.equal((await get(h, alice, id)).state, "running");

    const d = await call(h, c, "DELETE", `/api/tasks/${id}`);
    assert.equal(d.status, 202);
    await h.jarvis.settle();
    t = await get(h, alice, id);
    assert.equal(t.state, "archived");
    const userId = (await call(h, c, "GET", "/api/me")).body.user.id;
    assert.ok(h.blobs.objects.has(`archives/${userId}/${id}/state.tar.gz`));
    const meta = JSON.parse(new TextDecoder().decode(h.blobs.objects.get(`archives/${userId}/${id}/task.json`)!));
    assert.equal(meta.id, id);
    assert.ok(!h.blobs.objects.has(`snapshots/${id}/state.tar.gz`), "snapshot removed after archiving");
    assert.equal(h.machines.machines.size, 0);
    assert.equal((await call(h, c, "DELETE", `/api/tasks/${id}`)).status, 409, "already archived");
    assert.equal((await call(h, c, "POST", `/api/tasks/${id}/resume`)).status, 409);
    s2.ws.close();
  }));

test("destroying a paused task moves its snapshot into the archive", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    const id = await createTask(h, alice);
    await call(h, c, "POST", `/api/tasks/${id}/pause`);
    await h.jarvis.settle();
    await call(h, c, "DELETE", `/api/tasks/${id}`);
    await h.jarvis.settle();
    const userId = (await call(h, c, "GET", "/api/me")).body.user.id;
    assert.equal((await get(h, alice, id)).state, "archived");
    assert.ok(h.blobs.objects.has(`archives/${userId}/${id}/state.tar.gz`));
    assert.ok(!h.blobs.objects.has(`snapshots/${id}/state.tar.gz`));
  }));

test("a failed snapshot leaves the task running; a failed archive stops destroy unless forced", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    const id = await createTask(h, alice);
    const s = await fakeSession(h, id);
    h.machines.failSnapshot = "disk full";
    await call(h, c, "POST", `/api/tasks/${id}/pause`);
    await h.jarvis.settle();
    let t = await get(h, alice, id);
    assert.equal(t.state, "running");
    assert.match(t.error, /pause failed.*disk full/);
    assert.equal(h.machines.machines.size, 1);

    await call(h, c, "DELETE", `/api/tasks/${id}`);
    await h.jarvis.settle();
    t = await get(h, alice, id);
    assert.equal(t.state, "running");
    assert.match(t.error, /archive failed/);
    assert.equal(h.machines.machines.size, 1);

    await call(h, c, "DELETE", `/api/tasks/${id}?force=1`);
    await h.jarvis.settle();
    t = await get(h, alice, id);
    assert.equal(t.state, "archived");
    assert.match(t.error, /without an archive/);
    assert.equal(h.machines.machines.size, 0);
    s.ws.close();
  }));

test("a machine that can't be created: task failed with a notice; only destroy remains", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    h.machines.failCreate = "no capacity in region";
    const r = await call(h, c, "POST", "/api/tasks", { prompt: "x" });
    await h.jarvis.settle();
    const t = await get(h, alice, r.body.id);
    assert.equal(t.state, "failed");
    assert.match(t.error, /no capacity/);
    const n = await call(h, c, "GET", "/api/notices");
    assert.equal(n.body.notices[0].kind, "task_failed");
    assert.equal((await call(h, c, "POST", `/api/tasks/${r.body.id}/pause`)).status, 409);
    assert.equal((await call(h, c, "POST", `/api/tasks/${r.body.id}/resume`)).status, 409);
    await call(h, c, "DELETE", `/api/tasks/${r.body.id}`);
    await h.jarvis.settle();
    assert.equal((await get(h, alice, r.body.id)).state, "archived");
  }));

test("a create that fails after the provider made the machine leaves no machine behind", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    h.machines.failCreateAfterMaking = "Fly POST /apps/x/machines -> 408: ";
    const r = await call(h, c, "POST", "/api/tasks", { prompt: "x" });
    await h.jarvis.settle();
    const t = await get(h, alice, r.body.id);
    assert.equal(t.state, "failed");
    assert.match(t.error, /408/);
    assert.equal(h.machines.machines.size, 0);
    assert.equal(h.machines.destroyed.length, 1);
  }));

test("a resume whose machine can't be created goes back to paused with the error", () =>
  withAlice(async (h, alice) => {
    const c = await asEmail(h, alice);
    const id = await createTask(h, alice);
    await call(h, c, "POST", `/api/tasks/${id}/pause`);
    await h.jarvis.settle();
    h.machines.failCreate = "quota";
    await call(h, c, "POST", `/api/tasks/${id}/resume`);
    await h.jarvis.settle();
    const t = await get(h, alice, id);
    assert.equal(t.state, "paused");
    assert.match(t.error, /could not resume: quota/);
  }));

test("tasks list shows only the caller's own tasks, newest first", () =>
  withAlice(async (h, alice) => {
    const a1 = await createTask(h, alice, "one");
    h.clock.advance(1000);
    const a2 = await createTask(h, alice, "two");
    await createTask(h, "bob@example.org", "bob's");
    const list = await call(h, await asEmail(h, alice), "GET", "/api/tasks");
    assert.deepEqual(
      list.body.tasks.map((t: { id: string }) => t.id),
      [a2, a1],
    );
  }));

// ---- chats: rename, messages from the app, last activity -------------------------------------------

test("rename: owner only (admins get the 404 too), 1..120 characters, session titles ignored afterwards", () =>
  run3(async (h, u) => {
    const id = await createTask(h, u.alice);
    const s = await fakeSession(h, id);
    const sess = await asService(h, GATE, s.token);
    const alice = await asEmail(h, u.alice);
    assert.equal((await call(h, sess, "POST", "/api/session/status", { activity: "idle", title: "Agent title" })).body.title, "Agent title");
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.titleSetByUser, false);
    for (const who of [u.bob, u.admin]) assert.equal((await call(h, await asEmail(h, who), "PATCH", `/api/tasks/${id}`, { title: "Mine now" })).status, 404, who);
    assert.equal((await call(h, alice, "PATCH", `/api/tasks/${id}`, { title: "   " })).status, 400);
    assert.equal((await call(h, alice, "PATCH", `/api/tasks/${id}`, { title: "x".repeat(121) })).status, 400);
    assert.equal((await call(h, alice, "PATCH", `/api/tasks/nope`, { title: "x" })).status, 404);
    const r = await call(h, alice, "PATCH", `/api/tasks/${id}`, { title: "  Quarterly numbers  " });
    assert.equal(r.status, 200);
    assert.equal(r.body.title, "Quarterly numbers");
    assert.equal(r.body.titleSetByUser, true);
    // Paseo's agent title no longer overwrites the user's name
    assert.equal((await call(h, sess, "POST", "/api/session/status", { activity: "busy", title: "Another agent title" })).body.title, "Quarterly numbers");
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.title, "Quarterly numbers");
    s.ws.close();
    // an archived task can't be renamed
    await call(h, alice, "DELETE", `/api/tasks/${id}`);
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "PATCH", `/api/tasks/${id}`, { title: "Late" })).status, 409);
  }));

async function run3(fn: (h: Harness, u: Awaited<ReturnType<typeof seedUsers>>) => Promise<void>) {
  const h = await harness();
  try {
    await fn(h, await seedUsers(h));
  } finally {
    await h.jarvis.settle();
    await h.close();
  }
}

test("messages: a live task queues the text as written; the session gets it from its inbox; requestId is idempotent", () =>
  run3(async (h, u) => {
    const id = await createTask(h, u.alice);
    const s = await fakeSession(h, id);
    const sess = await asService(h, GATE, s.token);
    const alice = await asEmail(h, u.alice);
    const created = (await call(h, alice, "GET", `/api/tasks/${id}`)).body.lastActivityAt;
    for (const who of [u.bob, u.admin]) assert.equal((await call(h, await asEmail(h, who), "POST", `/api/tasks/${id}/messages`, { text: "hi" })).status, 404, who);
    assert.equal((await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text: "" })).status, 400);
    assert.equal((await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text: "x".repeat(16001) })).status, 400);
    assert.equal((await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text: "x", requestId: "no spaces" })).status, 400);
    h.clock.advance(60_000);
    const text = "Line one\n\n  and the rest, exactly as typed  ";
    const a = await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text, requestId: "m-1" });
    assert.equal(a.status, 202, JSON.stringify(a.body));
    assert.equal(a.body.task.state, "running");
    assert.ok(a.body.messageId);
    assert.ok(a.body.task.lastActivityAt > created, "a message moves lastActivityAt");
    const b = await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text, requestId: "m-1" });
    assert.equal(b.status, 202);
    assert.equal(b.body.messageId, a.body.messageId);
    const inbox = (await call(h, sess, "GET", "/api/session/inbox")).body.messages;
    assert.equal(inbox.length, 1, "the repeat queued nothing");
    assert.equal(inbox[0].source, "user");
    assert.equal(inbox[0].text, text);
    // a pending message keeps the task from idle-pausing
    await call(h, sess, "POST", "/api/session/status", { activity: "idle" });
    h.clock.advance(2 * 3_600_000);
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal((await call(h, await asEmail(h, u.alice), "GET", `/api/tasks/${id}`)).body.state, "idle");
    s.ws.close();
  }));

test("messages: a paused task resumes; a cap refuses with nothing queued; failed/archived tasks refuse", () =>
  run3(async (h, u) => {
    const id = await createTask(h, u.alice);
    const alice = await asEmail(h, u.alice);
    await call(h, alice, "POST", `/api/tasks/${id}/pause`);
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.state, "paused");
    const lastActivity = (await call(h, alice, "GET", `/api/tasks/${id}`)).body.lastActivityAt;
    assert.equal(lastActivity, (await call(h, alice, "GET", `/api/tasks/${id}`)).body.createdAt, "pausing doesn't move lastActivityAt");
    // a cap: 429 and nothing queued
    const aliceId = (await call(h, alice, "GET", "/api/me")).body.user.id;
    await call(h, await asEmail(h, u.admin), "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: 0 });
    const capped = await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text: "are you there?" });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.error.code, "machine_hours_cap");
    assert.equal(h.jarvis.ctx.db.prepare("SELECT count(*) AS n FROM inbox WHERE task_id = ?").get(id)!.n, 0);
    await call(h, await asEmail(h, u.admin), "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: null });
    // resumed by the message
    const r = await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text: "are you there?" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.task.state, "starting");
    assert.equal(r.body.task.busy?.kind, "resuming");
    await h.jarvis.settle();
    const s = await fakeSession(h, id);
    const inbox = (await call(h, await asService(h, GATE, s.token), "GET", "/api/session/inbox")).body.messages;
    assert.deepEqual(inbox.map((m: { text: string }) => m.text), ["are you there?"]);
    s.ws.close();
    // failed: 409
    h.machines.failCreate = "no capacity";
    const f = (await call(h, alice, "POST", "/api/tasks", { prompt: "doomed" })).body.id;
    await h.jarvis.settle();
    h.machines.failCreate = null;
    assert.equal((await call(h, alice, "GET", `/api/tasks/${f}`)).body.state, "failed");
    assert.equal((await call(h, alice, "POST", `/api/tasks/${f}/messages`, { text: "hello?" })).status, 409);
    const fn = (await call(h, alice, "GET", "/api/notices")).body.notices.find((n: { kind: string; taskId: string }) => n.kind === "task_failed" && n.taskId === f);
    assert.equal(fn.text, 'Chat "doomed" could not start.');
    // archived: 409
    await call(h, alice, "DELETE", `/api/tasks/${id}?force=1`);
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text: "hello?" })).status, 409);
  }));

test("messages: one queued while the task is pausing resumes it once the pause finishes", () =>
  run3(async (h, u) => {
    const id = await createTask(h, u.alice);
    const s = await fakeSession(h, id);
    const alice = await asEmail(h, u.alice);
    let release!: () => void;
    h.machines.hold = new Promise<void>((r) => (release = r));
    assert.equal((await call(h, alice, "POST", `/api/tasks/${id}/pause`)).status, 202);
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.state, "pausing");
    const r = await call(h, alice, "POST", `/api/tasks/${id}/messages`, { text: "one more thing" });
    assert.equal(r.status, 202);
    assert.equal(r.body.task.state, "pausing");
    h.machines.hold = null;
    release();
    s.ws.close();
    await h.jarvis.settle();
    const t = (await call(h, alice, "GET", `/api/tasks/${id}`)).body;
    assert.equal(t.state, "starting", `resumed after the pause: ${JSON.stringify(t)}`);
    assert.equal(h.jarvis.ctx.db.prepare("SELECT count(*) AS n FROM inbox WHERE task_id = ? AND delivered_at IS NULL").get(id)!.n, 1);
  }));

test("lastActivityAt: the transcript's newest entry moves it forward (never back, never into the future); state changes don't", () =>
  run3(async (h, u) => {
    const id = await createTask(h, u.alice);
    const s = await fakeSession(h, id);
    const sess = await asService(h, GATE, s.token);
    const alice = await asEmail(h, u.alice);
    const t0 = (await call(h, alice, "GET", `/api/tasks/${id}`)).body.lastActivityAt;
    h.clock.advance(10 * 60_000);
    await call(h, sess, "POST", "/api/session/status", { activity: "idle" });
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.lastActivityAt, t0, "a status report doesn't move it");
    const at = new Date(h.clock.now() - 60_000).toISOString();
    const ing = await call(h, sess, "POST", "/api/session/transcript", { agentId: "a1", epoch: "e1", entries: [{ seq: 0, role: "user", text: "hi", at }, { seq: 1, role: "assistant", text: "hello", at }] });
    assert.equal(ing.status, 200, JSON.stringify(ing.body));
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.lastActivityAt, at);
    // an older entry (a re-sent epoch) doesn't move it back; a future one is clamped to now
    await call(h, sess, "POST", "/api/session/transcript", { agentId: "a2", epoch: "e1", entries: [{ seq: 0, role: "user", text: "old", at: new Date(Date.parse(t0) - 1000).toISOString() }] });
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.lastActivityAt, at);
    await call(h, sess, "POST", "/api/session/transcript", { agentId: "a3", epoch: "e1", entries: [{ seq: 0, role: "user", text: "later", at: new Date(h.clock.now() + 3_600_000).toISOString() }] });
    assert.equal((await call(h, alice, "GET", `/api/tasks/${id}`)).body.lastActivityAt, new Date(h.clock.now()).toISOString());
    s.ws.close();
  }));
