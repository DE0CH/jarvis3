// Scheduled tasks, wakeups (with the task inbox) and channels against the fake provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, createTask, fakeSession, machineOf, GATE, type Harness, type Cred } from "./helpers.ts";
import type { CheckResponse, HttpChecker } from "../src/providers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

class FakeChecker implements HttpChecker {
  next: CheckResponse | Error = { status: 200, body: "" };
  calls: string[] = [];
  async get(url: string): Promise<CheckResponse> {
    this.calls.push(url);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

// the tests move the clock by days: credentials that outlive that
const YEAR_S = 365 * 86400;
const longEmail = async (h: Harness, email: string): Promise<Cred> => ({
  jwt: await h.signer.sign({ email, sub: `sub-${email}`, type: "app" }, { exp: Math.floor(h.clock.now() / 1000) + YEAR_S }),
});
const longSession = async (h: Harness, token: string): Promise<Cred> => ({
  jwt: await h.signer.sign({ common_name: GATE, sub: "", type: "app" }, { exp: Math.floor(h.clock.now() / 1000) + YEAR_S }),
  bearer: token,
});

interface World {
  h: Harness;
  checker: FakeChecker;
  alice: Cred;
  bob: Cred;
  admin: Cred;
  aliceId: string;
}

async function world(fn: (w: World) => Promise<void>, config: Parameters<typeof harness>[0] = {}): Promise<void> {
  const checker = new FakeChecker();
  const h = await harness({ checker, ...config });
  try {
    const u = await seedUsers(h);
    const alice = await longEmail(h, u.alice);
    const me = await call(h, alice, "GET", "/api/me");
    await fn({ h, checker, alice, bob: await longEmail(h, u.bob), admin: await longEmail(h, u.admin), aliceId: me.body.user.id });
  } finally {
    await h.close();
  }
}

/** A task of alice's with its fake session connected; returns the task id and a session credential. */
async function liveTask(w: World, prompt = "Do the thing"): Promise<{ id: string; session: Cred }> {
  const id = await createTask(w.h, "alice@example.org", prompt);
  const s = await fakeSession(w.h, id);
  return { id, session: await longSession(w.h, s.token) };
}

async function pauseAndWait(w: World, id: string): Promise<void> {
  assert.equal((await call(w.h, w.alice, "POST", `/api/tasks/${id}/pause`)).status, 202);
  await w.h.jarvis.settle();
  assert.equal((await call(w.h, w.alice, "GET", `/api/tasks/${id}`)).body.state, "paused");
}

// ---- scheduled tasks ----------------------------------------------------------------------------------

const NO_CAP = { roles: { admin: { openrouterMonthlyUsd: 100, machineHoursPerMonth: null, admin: true }, staff: { openrouterMonthlyUsd: 20, machineHoursPerMonth: null } } };
const DAILY = { title: "Morning digest", prompt: "Summarise yesterday's tickets", cron: "0 9 * * *", timeZone: "Europe/London" };

test("schedules: validation, preview and the per-person limit", () =>
  world(async ({ h, alice }) => {
    const bad = async (body: object, re: RegExp) => {
      const r = await call(h, alice, "POST", "/api/schedules", body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error.message, re);
    };
    await bad({ ...DAILY, cron: "0 9 * *" }, /five fields/);
    await bad({ ...DAILY, timeZone: "Mars/Base" }, /IANA/);
    await bad({ ...DAILY, cron: "*/5 * * * *" }, /at most every 60 minutes/);
    await bad({ ...DAILY, model: "someone/else" }, /model/);
    await bad({ ...DAILY, prompt: "" }, /prompt/);
    await bad({ ...DAILY, cron: "0 0 31 2 *" }, /never runs/);
    const p = await call(h, alice, "POST", "/api/schedules/preview", { cron: "0 9 * * 1-5", timeZone: "Europe/London" });
    assert.equal(p.body.ok, true);
    assert.equal(p.body.next.length, 5);
    assert.equal(p.body.next[0].at, "2026-10-09T08:00:00.000Z");
    assert.equal(p.body.next[0].local, "Fri 9 Oct 09:00");
    const pBad = await call(h, alice, "POST", "/api/schedules/preview", { cron: "nope", timeZone: "UTC" });
    assert.equal(pBad.body.ok, false);
    assert.match(pBad.body.error, /five fields/);
  }, { config: { schedules: { maxPerUser: 2 } } }).then(() =>
    world(async ({ h, alice }) => {
      for (let i = 0; i < 2; i++) assert.equal((await call(h, alice, "POST", "/api/schedules", DAILY)).status, 201);
      const third = await call(h, alice, "POST", "/api/schedules", DAILY);
      assert.equal(third.status, 429);
    }, { config: { schedules: { maxPerUser: 2 } } }),
  ));

test("schedules: a firing starts a new task of the owner with the prompt; one run at a time; caps and the budget skip", () =>
  world(async ({ h, alice, bob, admin, aliceId }) => {
    const c = await call(h, alice, "POST", "/api/schedules", DAILY);
    assert.equal(c.status, 201);
    const sid = c.body.id;
    assert.equal(c.body.nextRunAt, "2026-10-09T08:00:00.000Z");
    assert.equal(c.body.enabled, true);
    // not due yet
    await h.jarvis.tick();
    assert.equal((await call(h, alice, "GET", "/api/tasks")).body.tasks.length, 0);
    // due: Fri 09:00 London
    h.clock.t = Date.UTC(2026, 9, 9, 8, 0, 30);
    await h.jarvis.tick();
    await h.jarvis.settle();
    const tasks = (await call(h, alice, "GET", "/api/tasks")).body.tasks;
    assert.equal(tasks.length, 1);
    const run1 = tasks[0];
    assert.equal(run1.scheduleId, sid);
    assert.equal(run1.title, "Morning digest · 9 Oct 09:00");
    const m = machineOf(h, run1.id)!;
    assert.match(m.env.JARVIS_FIRST_PROMPT!, /^\[Scheduled task "Morning digest", run by its schedule \(0 9 \* \* \*\), Friday,? 9 October 2026 at 09:00 \(Europe\/London\)\./);
    assert.ok(m.env.JARVIS_FIRST_PROMPT!.endsWith("\n\nSummarise yesterday's tickets"));
    let d = (await call(h, alice, "GET", `/api/schedules/${sid}`)).body;
    assert.equal(d.nextRunAt, "2026-10-10T08:00:00.000Z");
    assert.equal(d.runs[0].result, "started");
    assert.equal(d.runs[0].taskId, run1.id);
    assert.equal(d.lastRun.result, "started");
    // the next day the first run is still live: skipped, the owner is told once
    h.clock.t = Date.UTC(2026, 9, 10, 8, 0, 10);
    await h.jarvis.tick();
    h.clock.t = Date.UTC(2026, 9, 11, 8, 0, 10);
    await h.jarvis.tick();
    d = (await call(h, alice, "GET", `/api/schedules/${sid}`)).body;
    assert.deepEqual(d.runs.slice(0, 2).map((r: { result: string }) => r.result), ["skipped_overlap", "skipped_overlap"]);
    let notices = (await call(h, alice, "GET", "/api/notices")).body.notices.filter((n: { kind: string }) => n.kind === "schedule_skipped");
    assert.equal(notices.length, 1, "one notice for a run of the same outcome");
    assert.match(notices[0].text, /previous run is still going/);
    // the run ends (archived): the next firing starts again
    assert.equal((await call(h, alice, "DELETE", `/api/tasks/${run1.id}`)).status, 202);
    await h.jarvis.settle();
    // machine-hour cap reached: skipped_cap
    h.jarvis.ctx.db.prepare("UPDATE users SET machine_hours_override = 0, machine_hours_override_set = 1 WHERE id = ?").run(aliceId);
    h.clock.t = Date.UTC(2026, 9, 12, 8, 0, 10);
    await h.jarvis.tick();
    d = (await call(h, alice, "GET", `/api/schedules/${sid}`)).body;
    assert.equal(d.runs[0].result, "skipped_cap");
    // the instance budget: skipped_budget (it comes first)
    h.jarvis.ctx.db.prepare("UPDATE users SET machine_hours_override = NULL, machine_hours_override_set = 0 WHERE id = ?").run(aliceId);
    await call(h, admin, "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: null });
    const { saveBudget, budgetState } = await import("../src/spend.ts");
    saveBudget(h.jarvis.ctx, { ...budgetState(h.jarvis.ctx), month: "2026-10", spentUsd: 1000, capped: true });
    h.clock.t = Date.UTC(2026, 9, 13, 8, 0, 10);
    await h.jarvis.tick();
    d = (await call(h, alice, "GET", `/api/schedules/${sid}`)).body;
    assert.equal(d.runs[0].result, "skipped_budget");
    notices = (await call(h, alice, "GET", "/api/notices")).body.notices.filter((n: { kind: string }) => n.kind === "schedule_skipped");
    assert.equal(notices.length, 3);
    // other people never see it; the admin does
    assert.equal((await call(h, bob, "GET", `/api/schedules/${sid}`)).status, 404);
    assert.equal((await call(h, bob, "GET", "/api/schedules")).body.schedules.length, 0);
    assert.equal((await call(h, bob, "POST", `/api/schedules/${sid}/run`)).status, 404);
    assert.equal((await call(h, admin, "GET", "/api/schedules?all=1")).body.schedules.length, 1);
    assert.equal((await call(h, admin, "GET", `/api/schedules?userId=${aliceId}`)).body.schedules.length, 1);
  }, { config: NO_CAP }));

test("schedules: missed firings, run now, disable, change and delete", () =>
  world(async ({ h, alice }) => {
    const sid = (await call(h, alice, "POST", "/api/schedules", DAILY)).body.id;
    // the server was down from before 09:00 until 12:00: recorded as missed, planned for tomorrow
    h.clock.t = Date.UTC(2026, 9, 9, 11, 0, 0);
    await h.jarvis.tick();
    let d = (await call(h, alice, "GET", `/api/schedules/${sid}`)).body;
    assert.equal(d.runs[0].result, "missed");
    assert.equal(d.nextRunAt, "2026-10-10T08:00:00.000Z");
    assert.equal((await call(h, alice, "GET", "/api/tasks")).body.tasks.length, 0);
    // run now
    const now = await call(h, alice, "POST", `/api/schedules/${sid}/run`);
    assert.equal(now.status, 201);
    assert.equal(now.body.run.manual, true);
    assert.equal(now.body.task.scheduleId, sid);
    await h.jarvis.settle();
    assert.match(machineOf(h, now.body.task.id)!.env.JARVIS_FIRST_PROMPT!, /started by hand from its schedule/);
    // again while it runs: one run at a time
    const again = await call(h, alice, "POST", `/api/schedules/${sid}/run`);
    assert.equal(again.status, 200);
    assert.equal(again.body.run.result, "skipped_overlap");
    assert.equal(again.body.task, null);
    // disabled: no next run, the tick leaves it alone
    let p = await call(h, alice, "PATCH", `/api/schedules/${sid}`, { enabled: false });
    assert.equal(p.body.enabled, false);
    assert.equal(p.body.nextRunAt, null);
    // re-enabled with a new time: re-planned
    p = await call(h, alice, "PATCH", `/api/schedules/${sid}`, { enabled: true, cron: "30 7 * * MON", timeZone: "Asia/Shanghai", prompt: "Weekly plan" });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.nextRunAt, "2026-10-11T23:30:00.000Z");
    assert.equal(p.body.prompt, "Weekly plan");
    assert.equal((await call(h, alice, "PATCH", `/api/schedules/${sid}`, { cron: "* * * * *" })).status, 400);
    // delete: the schedule goes, its task stays
    assert.equal((await call(h, alice, "DELETE", `/api/schedules/${sid}`)).status, 200);
    assert.equal((await call(h, alice, "GET", `/api/schedules/${sid}`)).status, 404);
    assert.equal((await call(h, alice, "GET", `/api/tasks/${now.body.task.id}`)).status, 200);
  }));

test("schedules: an offboarded owner's schedules don't fire", () =>
  world(async ({ h, alice }) => {
    await call(h, alice, "POST", "/api/schedules", DAILY);
    h.directory.set("alice@example.org", { suspended: true });
    await h.jarvis.syncDirectory();
    await h.jarvis.settle();
    h.clock.t = Date.UTC(2026, 9, 9, 8, 0, 30);
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal(h.machines.machines.size, 0);
  }));

// ---- wakeups -------------------------------------------------------------------------------------------

test("wakeups: a timed wakeup resumes a paused task and the prompt lands in its inbox", () =>
  world(async (w) => {
    const { h, alice, bob, admin } = w;
    const t = await liveTask(w);
    const arm = await call(h, t.session, "POST", "/api/session/wakeups", { name: "check-invoice", inSeconds: 600, prompt: "Check whether the invoice was paid" });
    assert.equal(arm.status, 201, JSON.stringify(arm.body));
    assert.equal(arm.body.kind, "time");
    assert.equal(arm.body.state, "armed");
    assert.equal(arm.body.at, new Date(h.clock.now() + 600_000).toISOString());
    // listed for the owner and the admin; another person sees nothing and can't cancel it
    assert.equal((await call(h, alice, "GET", "/api/wakeups")).body.wakeups.length, 1);
    assert.equal((await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups[0].name, "check-invoice");
    assert.equal((await call(h, admin, "GET", "/api/wakeups?all=1")).body.wakeups.length, 1);
    assert.equal((await call(h, bob, "GET", "/api/wakeups")).body.wakeups.length, 0);
    assert.equal((await call(h, bob, "GET", `/api/wakeups?taskId=${t.id}`)).status, 404);
    assert.equal((await call(h, bob, "DELETE", `/api/wakeups/${arm.body.id}`)).status, 404);
    await pauseAndWait(w, t.id);
    const first = machineOf(h, t.id);
    assert.equal(first, null, "paused: no machine");
    // not due yet
    await h.jarvis.tick();
    assert.equal((await call(h, alice, "GET", `/api/tasks/${t.id}`)).body.state, "paused");
    h.clock.advance(601_000);
    await h.jarvis.tick();
    await h.jarvis.settle();
    const resumed = (await call(h, alice, "GET", `/api/tasks/${t.id}`)).body;
    assert.equal(resumed.state, "starting", "the wakeup resumed the task");
    const m = machineOf(h, t.id)!;
    assert.ok(m.env.JARVIS_RESTORE_URL, "from its snapshot");
    assert.equal(m.env.JARVIS_FIRST_PROMPT, undefined, "the prompt comes through the inbox, not as a new first prompt");
    const fired = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups[0];
    assert.equal(fired.state, "fired");
    // the new machine's session reads its inbox
    const s2 = await fakeSession(h, t.id);
    const sess = await longSession(h, s2.token);
    const ib = await call(h, sess, "GET", "/api/session/inbox");
    assert.equal(ib.body.messages.length, 1);
    const msg = ib.body.messages[0];
    assert.equal(msg.source, "wakeup");
    assert.equal(msg.sourceId, arm.body.id);
    assert.match(msg.text, /^\[Jarvis wakeup "check-invoice" \(timed\), set earlier by this task; now 2026-10-08T12:\d\d:\d\d.\d+Z\]\nCheck whether the invoice was paid$/);
    assert.equal((await call(h, sess, "POST", `/api/session/inbox/${msg.id}/ack`)).status, 200);
    assert.equal((await call(h, sess, "POST", `/api/session/inbox/${msg.id}/ack`)).status, 200, "acking twice is fine");
    assert.equal((await call(h, sess, "GET", "/api/session/inbox")).body.messages.length, 0);
    // another task's session can't ack it
    const other = await liveTask(w, "other");
    assert.equal((await call(h, other.session, "POST", `/api/session/inbox/${msg.id}/ack`)).status, 404);
  }));

test("wakeups: a running task gets the message at once (long poll); idle auto-pause waits for delivery", () =>
  world(async (w) => {
    const { h } = w;
    const t = await liveTask(w);
    await call(h, t.session, "POST", "/api/session/wakeups", { inSeconds: 60, prompt: "Look again" });
    // the session waits on its inbox
    const poll = call(h, t.session, "GET", "/api/session/inbox?wait=20");
    await new Promise((r) => setTimeout(r, 50));
    h.clock.advance(61_000);
    await h.jarvis.tick();
    const got = await poll;
    assert.equal(got.body.messages.length, 1);
    assert.match(got.body.messages[0].text, /Look again$/);
    // reported idle long ago, but a message is waiting: no auto-pause until it is acked
    await call(h, t.session, "POST", "/api/session/status", { activity: "idle" });
    h.clock.advance(2 * HOUR);
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal((await call(h, w.alice, "GET", `/api/tasks/${t.id}`)).body.state, "idle");
    await call(h, t.session, "POST", `/api/session/inbox/${got.body.messages[0].id}/ack`);
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal((await call(h, w.alice, "GET", `/api/tasks/${t.id}`)).body.state, "paused");
  }));

test("wakeups: recurring (cron) re-arms; same name replaces; limits; cancel; destroy cancels", () =>
  world(async (w) => {
    const { h, alice } = w;
    const t = await liveTask(w);
    const bad = async (body: object, re: RegExp, status = 400) => {
      const r = await call(h, t.session, "POST", "/api/session/wakeups", body);
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.match(r.body.error.message, re);
    };
    await bad({ prompt: "x" }, /exactly one of/);
    await bad({ prompt: "x", inSeconds: 5, at: "2026-10-09T00:00:00Z" }, /exactly one of/);
    await bad({ prompt: "", inSeconds: 5 }, /prompt/);
    await bad({ prompt: "x", at: "2026-10-01T00:00:00Z" }, /past/);
    await bad({ prompt: "x", inSeconds: 400 * 86400 }, /365 days/);
    await bad({ prompt: "x", cron: "*/5 * * * *" }, /every 15 minutes/);
    await bad({ prompt: "x", name: "bad name!", inSeconds: 5 }, /name/);
    await bad({ prompt: "x", check: { url: "https://127.0.0.1/" } }, /public address/);
    await bad({ prompt: "x", check: { url: "https://example.org/" } }, /needs a condition/);
    await bad({ prompt: "x", check: { url: "https://example.org/", status: 200 }, intervalSeconds: 10 }, /intervalSeconds/);
    await bad({ prompt: "x", inSeconds: 5, failPrompt: "y" }, /only for check/);
    // the user's own zone (from the app's header) is the default for cron wakeups
    await call(h, { ...alice }, "GET", "/api/me");
    await fetch(h.base + "/api/me", { headers: { "cf-access-jwt-assertion": alice.jwt!, "x-time-zone": "Asia/Tokyo" } });
    const cron = await call(h, t.session, "POST", "/api/session/wakeups", { name: "daily", cron: "0 9 * * *", prompt: "Morning check", until: "2026-10-10T12:00:00Z" });
    assert.equal(cron.status, 201, JSON.stringify(cron.body));
    assert.equal(cron.body.timeZone, "Asia/Tokyo");
    assert.equal(cron.body.at, "2026-10-09T00:00:00.000Z");
    h.clock.t = Date.UTC(2026, 9, 9, 0, 0, 30);
    await h.jarvis.tick();
    let v = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups[0];
    assert.equal(v.state, "armed");
    assert.equal(v.at, "2026-10-10T00:00:00.000Z");
    h.clock.t = Date.UTC(2026, 9, 10, 0, 0, 30);
    await h.jarvis.tick();
    v = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups.find((x: { name: string }) => x.name === "daily");
    assert.equal(v.state, "fired", "the next firing is after `until`");
    assert.equal((await call(h, t.session, "GET", "/api/session/inbox")).body.messages.length, 2);
    // the same name replaces
    const a = await call(h, t.session, "POST", "/api/session/wakeups", { name: "n", inSeconds: 100, prompt: "one" });
    const b = await call(h, t.session, "POST", "/api/session/wakeups", { name: "n", inSeconds: 200, prompt: "two" });
    const list = (await call(h, t.session, "GET", "/api/session/wakeups")).body.wakeups;
    assert.equal(list.find((x: { id: string }) => x.id === a.body.id).state, "cancelled");
    assert.equal(list.find((x: { id: string }) => x.id === b.body.id).state, "armed");
    // the session cancels by name; the owner cancels by id
    assert.equal((await call(h, t.session, "DELETE", "/api/session/wakeups/n")).body.state, "cancelled");
    assert.equal((await call(h, t.session, "DELETE", "/api/session/wakeups/n")).status, 404);
    const c = await call(h, t.session, "POST", "/api/session/wakeups", { name: "c", inSeconds: 100, prompt: "c" });
    assert.equal((await call(h, alice, "DELETE", `/api/wakeups/${c.body.id}`)).body.state, "cancelled");
    assert.equal((await call(h, alice, "DELETE", `/api/wakeups/${c.body.id}`)).status, 409);
    // at most maxPerTask armed
    for (let i = 0; i < 3; i++) assert.equal((await call(h, t.session, "POST", "/api/session/wakeups", { name: `w${i}`, inSeconds: 1000, prompt: "p" })).status, 201);
    await bad({ name: "w9", inSeconds: 1000, prompt: "p" }, /at most 3/, 429);
    // destroying the task cancels its wakeups
    await call(h, alice, "DELETE", `/api/tasks/${t.id}`);
    await h.jarvis.settle();
    const after = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups;
    assert.ok(after.every((x: { state: string }) => x.state !== "armed"), JSON.stringify(after.map((x: { state: string }) => x.state)));
  }, {
    // the clock moves two days with the machine running: no machine-hour cap in the way
    config: { ...NO_CAP, wakeups: { maxPerTask: 3 } },
  }));

test("wakeups from the app: the owner wakes their task at a time; checks, limits and who may", () =>
  world(async (w) => {
    const { h, alice, bob, admin } = w;
    const t = await liveTask(w);
    const path = `/api/tasks/${t.id}/wakeups`;
    const at = new Date(h.clock.now() + 2 * HOUR).toISOString();
    const bad = async (body: object, re: RegExp, status = 400) => {
      const r = await call(h, alice, "POST", path, body);
      assert.equal(r.status, status, JSON.stringify(r.body));
      assert.match(r.body.error.message, re);
    };
    await bad({}, /at is required/);
    await bad({ at: "tomorrow" }, /ISO-8601/);
    await bad({ at: new Date(h.clock.now() - MIN).toISOString() }, /in the past/);
    await bad({ at: new Date(h.clock.now() + 366 * 24 * HOUR).toISOString() }, /365 days/);
    await bad({ at, cron: "0 9 * * *" }, /only at and prompt/);
    await bad({ at, check: { url: "https://example.org", changed: true } }, /only at and prompt/);
    await bad({ at, prompt: "x".repeat(4001) }, /prompt must be/);
    // someone else, and an admin, get the same 404 as a missing task
    const missing = await call(h, alice, "POST", "/api/tasks/ffffffffffffffff/wakeups", { at });
    for (const who of [bob, admin]) {
      const r = await call(h, who, "POST", path, { at });
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, missing.body);
    }

    // the owner arms two: each its own name, never replacing the agent's or each other
    const agents = await call(h, t.session, "POST", "/api/session/wakeups", { inSeconds: 9000, prompt: "the agent's" });
    const first = await call(h, alice, "POST", path, { at });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.setBy, "owner");
    assert.equal(first.body.kind, "time");
    assert.equal(first.body.at, at);
    assert.match(first.body.name, /^app-[0-9a-f]{6}$/);
    assert.match(first.body.prompt, /asked, from the app, for this task to be woken/);
    const second = await call(h, alice, "POST", path, { at: new Date(h.clock.now() + 3 * HOUR).toISOString(), prompt: "  Send me the draft  " });
    assert.equal(second.body.prompt, "Send me the draft");
    assert.notEqual(second.body.name, first.body.name);
    const list = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups;
    assert.deepEqual(list.map((x: { state: string; setBy: string }) => [x.state, x.setBy]), [["armed", "owner"], ["armed", "task"], ["armed", "owner"]], "soonest first");
    assert.equal(agents.body.setBy, "task");
    // the same cap as the agent's: at most maxPerTask armed on the task
    await bad({ at }, /at most 3 armed wakeups/, 429);
    assert.equal((await call(h, alice, "DELETE", `/api/wakeups/${second.body.id}`)).body.state, "cancelled");

    // it fires like any timed wakeup: resumes the paused task, the message names the owner
    await pauseAndWait(w, t.id);
    h.clock.advance(2 * HOUR + MIN);
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "GET", `/api/tasks/${t.id}`)).body.state, "starting", "the owner's wakeup resumed the task");
    const s2 = await fakeSession(h, t.id);
    const ib = await call(h, await longSession(h, s2.token), "GET", "/api/session/inbox");
    assert.equal(ib.body.messages.length, 1);
    assert.match(ib.body.messages[0].text, new RegExp(`^\\[Jarvis wakeup "${first.body.name}" \\(timed\\), set by your user from the app; now .+\\]\\nYour user asked`));

    // an ended task can't be woken
    await call(h, alice, "DELETE", `/api/tasks/${t.id}`);
    await h.jarvis.settle();
    await bad({ at: new Date(h.clock.now() + HOUR).toISOString() }, /archived/, 409);
  }, { config: { ...NO_CAP, wakeups: { maxPerTask: 3 } } }));

test("wakeups: condition checks pass, notice changes, and give up with the fail prompt or a notice", () =>
  world(async (w) => {
    const { h, alice, checker } = w;
    const t = await liveTask(w);
    const arm = await call(h, t.session, "POST", "/api/session/wakeups", { name: "ci", check: { url: "https://ci.example.org/run/1", contains: '"status":"completed"' }, intervalSeconds: 120, prompt: "CI finished: read the result" });
    assert.equal(arm.status, 201, JSON.stringify(arm.body));
    assert.equal(arm.body.expiresAt, new Date(h.clock.now() + 7 * 86400_000).toISOString());
    checker.next = { status: 200, body: '{"status":"in_progress"}' };
    await h.jarvis.tick();
    assert.deepEqual(checker.calls, ["https://ci.example.org/run/1"]);
    let v = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups[0];
    assert.equal(v.checks, 1);
    assert.equal(v.at, new Date(h.clock.now() + 120_000).toISOString());
    // not due again within the interval
    await h.jarvis.tick();
    assert.equal(checker.calls.length, 1);
    // a failed request is recorded and retried
    h.clock.advance(121_000);
    checker.next = new Error("connect ETIMEDOUT");
    await h.jarvis.tick();
    v = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups[0];
    assert.match(v.lastError, /ETIMEDOUT/);
    h.clock.advance(121_000);
    checker.next = { status: 200, body: '{"status":"completed","conclusion":"success"}' };
    await h.jarvis.tick();
    v = (await call(h, alice, "GET", `/api/wakeups?taskId=${t.id}`)).body.wakeups[0];
    assert.equal(v.state, "fired");
    const msgs = (await call(h, t.session, "GET", "/api/session/inbox")).body.messages;
    assert.match(msgs[0].text, /condition met: GET https:\/\/ci\.example\.org\/run\/1 answered HTTP 200\)/);
    // "changed": the first body is the baseline
    await call(h, t.session, "POST", "/api/session/wakeups", { name: "page", check: { url: "https://shop.example.org/item", changed: true }, prompt: "The page changed" });
    checker.next = { status: 200, body: "price 10" };
    await h.jarvis.tick();
    h.clock.advance(301_000);
    await h.jarvis.tick();
    let page = (await call(h, t.session, "GET", "/api/session/wakeups")).body.wakeups.find((x: { name: string }) => x.name === "page");
    assert.equal(page.state, "armed");
    h.clock.advance(301_000);
    checker.next = { status: 200, body: "price 9" };
    await h.jarvis.tick();
    page = (await call(h, t.session, "GET", "/api/session/wakeups")).body.wakeups.find((x: { name: string }) => x.name === "page");
    assert.equal(page.state, "fired");
    // giving up: with a fail prompt it is delivered; without, the owner gets a notice
    await call(h, t.session, "POST", "/api/session/wakeups", { name: "g1", check: { url: "https://x.example.org/", status: 204 }, prompt: "p", failPrompt: "It never happened; tell the user", until: new Date(h.clock.now() + HOUR).toISOString() });
    await call(h, t.session, "POST", "/api/session/wakeups", { name: "g2", check: { url: "https://x.example.org/", absent: "queued" }, prompt: "p", until: new Date(h.clock.now() + HOUR).toISOString() });
    checker.next = { status: 200, body: "queued" };
    h.clock.advance(HOUR + 1000);
    await h.jarvis.tick();
    const all = (await call(h, t.session, "GET", "/api/session/wakeups")).body.wakeups;
    assert.equal(all.find((x: { name: string }) => x.name === "g1").state, "expired");
    assert.equal(all.find((x: { name: string }) => x.name === "g2").state, "expired");
    const inbox = (await call(h, t.session, "GET", "/api/session/inbox")).body.messages.map((m: { text: string }) => m.text);
    assert.ok(inbox.some((x: string) => /gave up after \d+ checks/.test(x) && x.endsWith("It never happened; tell the user")), JSON.stringify(inbox));
    const notices = (await call(h, alice, "GET", "/api/notices")).body.notices.filter((n: { kind: string }) => n.kind === "wakeup");
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /"g2".*gave up/);
  }));

test("wakeups: at the machine-hour cap the task isn't resumed; the message waits and the owner is told", () =>
  world(async (w) => {
    const { h, alice, admin, aliceId } = w;
    const t = await liveTask(w);
    await call(h, t.session, "POST", "/api/session/wakeups", { inSeconds: 60, prompt: "Wake up" });
    await pauseAndWait(w, t.id);
    await call(h, admin, "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: 0 });
    h.clock.advance(61_000);
    await h.jarvis.tick();
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "GET", `/api/tasks/${t.id}`)).body.state, "paused");
    const n = (await call(h, alice, "GET", "/api/notices")).body.notices.filter((x: { kind: string }) => x.kind === "wakeup");
    assert.equal(n.length, 1, "told once");
    assert.match(n[0].text, /machine hours/);
    // the cap is lifted: the next tick resumes it and the message is still there
    await call(h, admin, "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: null });
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "GET", `/api/tasks/${t.id}`)).body.state, "starting");
    const s2 = await fakeSession(h, t.id);
    const msgs = (await call(h, await longSession(h, s2.token), "GET", "/api/session/inbox")).body.messages;
    assert.equal(msgs.length, 1);
  }));

// ---- channels ----------------------------------------------------------------------------------------------

test("channels: a task posts results; only its owner (and admins) see them; reading marks them read", () =>
  world(async (w) => {
    const { h, alice, bob, admin, aliceId } = w;
    const t = await liveTask(w, "Weekly report");
    const p = await call(h, t.session, "POST", "/api/session/posts", { title: "Report ready", text: "## Week 41\n- 12 tickets closed" });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.title, "Report ready");
    const p2 = await call(h, t.session, "POST", "/api/session/posts", { text: "# Follow-up\nOne more thing" });
    assert.equal(p2.body.title, "Follow-up", "the first line is the title");
    assert.equal((await call(h, t.session, "POST", "/api/session/posts", { text: "" })).status, 400);
    assert.equal((await call(h, t.session, "POST", "/api/session/posts", { text: "x".repeat(20001) })).status, 400);
    let me = (await call(h, alice, "GET", "/api/me")).body;
    assert.equal(me.unreadPosts, 2);
    const notices = (await call(h, alice, "GET", "/api/notices")).body.notices.filter((n: { kind: string }) => n.kind === "channel_post");
    assert.equal(notices.length, 2);
    assert.equal(notices[1].text, "Weekly report: Report ready");
    assert.equal(notices[1].taskId, t.id);
    const ch = (await call(h, alice, "GET", "/api/channels")).body.channels;
    assert.equal(ch.length, 1);
    assert.equal(ch[0].taskId, t.id);
    assert.equal(ch[0].unread, 2);
    assert.equal(ch[0].lastPost.title, "Follow-up");
    // bob: nothing, and 404 on alice's channel
    assert.equal((await call(h, bob, "GET", "/api/channels")).body.channels.length, 0);
    assert.equal((await call(h, bob, "GET", `/api/tasks/${t.id}/posts`)).status, 404);
    assert.equal((await call(h, bob, "POST", `/api/tasks/${t.id}/posts/read`)).status, 404);
    assert.equal((await call(h, bob, "GET", `/api/channels?userId=${aliceId}`)).status, 404);
    // the admin reads it without marking it read for alice
    assert.equal((await call(h, admin, "GET", "/api/channels?all=1")).body.channels.length, 1);
    const forAlice = (await call(h, admin, "GET", `/api/channels?userId=${aliceId}`)).body.channels;
    assert.deepEqual(forAlice.map((c: { taskId: string }) => c.taskId), [t.id], "the admin Users page lists a person's channels");
    assert.equal((await call(h, admin, "GET", `/api/tasks/${t.id}/posts`)).body.posts.length, 2);
    await call(h, admin, "POST", `/api/tasks/${t.id}/posts/read`);
    assert.equal((await call(h, alice, "GET", "/api/me")).body.unreadPosts, 2);
    assert.ok((await call(h, admin, "GET", `/api/tasks/${t.id}/posts`)).body.posts.every((x: { read: boolean }) => !x.read));
    assert.equal((await call(h, alice, "GET", "/api/notices")).body.notices.filter((n: { kind: string; read: boolean }) => n.kind === "channel_post" && !n.read).length, 2);
    // alice reads: posts and their notices are read
    const r = await call(h, alice, "POST", `/api/tasks/${t.id}/posts/read`);
    assert.equal(r.body.unreadPosts, 0);
    me = (await call(h, alice, "GET", "/api/me")).body;
    assert.equal(me.unreadNotices, 0);
    const posts = (await call(h, alice, "GET", `/api/tasks/${t.id}/posts`)).body.posts;
    assert.ok(posts.every((x: { read: boolean }) => x.read));
    // the channel outlives the machine
    await call(h, alice, "DELETE", `/api/tasks/${t.id}`);
    await h.jarvis.settle();
    assert.equal((await call(h, alice, "GET", `/api/tasks/${t.id}/posts`)).body.posts.length, 2);
  }));

test("time zone: the app's X-Time-Zone reaches the next machine", () =>
  world(async ({ h, alice }) => {
    await fetch(h.base + "/api/me", { headers: { "cf-access-jwt-assertion": alice.jwt!, "x-time-zone": "America/New_York" } });
    await fetch(h.base + "/api/me", { headers: { "cf-access-jwt-assertion": alice.jwt!, "x-time-zone": "Not/AZone" } });
    const id = await createTask(h, "alice@example.org");
    assert.equal(machineOf(h, id)!.env.JARVIS_TIME_ZONE, "America/New_York");
  }));
