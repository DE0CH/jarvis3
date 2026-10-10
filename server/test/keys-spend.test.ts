// Per-user OpenRouter keys (minting, limits, revocation) and spend caps (machine hours, budget).
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, createTask, fakeSession, type Harness } from "./helpers.ts";
import { OpenRouterKeys } from "../src/openrouter.ts";
import { applySample, hourlyMachineCostUSD, MAX_DELTA_H } from "../src/spend.ts";
import { addNotice } from "../src/ctx.ts";

async function run(fn: (h: Harness, u: Awaited<ReturnType<typeof seedUsers>>) => Promise<void>, o?: Parameters<typeof harness>[0]) {
  const h = await harness(o);
  try {
    await fn(h, await seedUsers(h));
  } finally {
    await h.close();
  }
}

// ---- keys ------------------------------------------------------------------------------------

test("a key is minted on the first task only, with the role's monthly limit, and reused after", () =>
  run(async (h, u) => {
    assert.equal(h.keys.keys.size, 0, "directory sync mints nothing");
    const c = await asEmail(h, u.alice);
    assert.equal((await call(h, c, "GET", "/api/me")).body.usage.openrouterKey, false);
    // two first tasks at once still mint one key
    const [a, b] = await Promise.all([call(h, c, "POST", "/api/tasks", { prompt: "a" }), call(h, c, "POST", "/api/tasks", { prompt: "b" })]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    await h.jarvis.settle();
    assert.equal(h.keys.keys.size, 1);
    const [k] = [...h.keys.keys.values()];
    assert.equal(k!.limit, 20);
    assert.equal(k!.reset, "monthly");
    assert.equal(k!.name, `example: ${u.alice}`);
    await createTask(h, u.alice);
    assert.equal(h.keys.keys.size, 1);
    const envKeys = new Set([...h.machines.machines.values()].map((m) => m.env.OPENROUTER_API_KEY));
    assert.deepEqual([...envKeys], [k!.key]);
    assert.equal((await call(h, c, "GET", "/api/me")).body.usage.openrouterKey, true);
  }));

test("the key is stored sealed: the database never holds it in clear", () =>
  run(async (h, u) => {
    await createTask(h, u.alice);
    const [k] = [...h.keys.keys.values()];
    const rows = h.jarvis.ctx.db.prepare("SELECT * FROM openrouter_keys").all();
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(k!.key));
    assert.match(dump, /"key_sealed":"v1:/);
  }));

test("an admin override changes the limit at OpenRouter; null goes back to the role default", () =>
  run(async (h, u) => {
    await createTask(h, u.alice);
    const admin = await asEmail(h, u.admin);
    const aliceId = (await call(h, await asEmail(h, u.alice), "GET", "/api/me")).body.user.id;
    const r = await call(h, admin, "PATCH", `/api/users/${aliceId}/limits`, { openrouterMonthlyUsd: 75 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.limits, { openrouterMonthlyUsd: 75, openrouterOverride: true, machineHoursPerMonth: 10, machineHoursOverride: false });
    const [k] = [...h.keys.keys.values()];
    assert.equal(k!.limit, 75);
    await call(h, admin, "PATCH", `/api/users/${aliceId}/limits`, { openrouterMonthlyUsd: null });
    assert.equal(k!.limit, 20);
    assert.equal((await call(h, admin, "PATCH", `/api/users/${aliceId}/limits`, { openrouterMonthlyUsd: -1 })).status, 400);
    assert.equal((await call(h, admin, "PATCH", `/api/users/${aliceId}/limits`, {})).status, 400);
    // an override set before the first task is used when minting
    const bobId = (await call(h, await asEmail(h, u.bob), "GET", "/api/me")).body.user.id;
    await call(h, admin, "PATCH", `/api/users/${bobId}/limits`, { openrouterMonthlyUsd: 5 });
    await createTask(h, u.bob);
    assert.ok([...h.keys.keys.values()].some((x) => x.name.endsWith(u.bob) && x.limit === 5));
  }));

test("an OpenRouter failure fails the create with 502 and leaves no task", () =>
  run(async (h, u) => {
    h.keys.fail = "OpenRouter down";
    const c = await asEmail(h, u.alice);
    const r = await call(h, c, "POST", "/api/tasks", { prompt: "x" });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, "upstream");
    assert.equal((await call(h, c, "GET", "/api/tasks")).body.tasks.length, 0);
  }));

test("OpenRouterKeys speaks the management API: create with monthly reset, PATCH limit, DELETE", async () => {
  const seen: { method: string; path: string; body: unknown; auth: string }[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    seen.push({ method: init!.method!, path: u.pathname, body: init!.body ? JSON.parse(String(init!.body)) : null, auth: (init!.headers as Record<string, string>).Authorization! });
    if (init!.method === "POST") return new Response(JSON.stringify({ data: { hash: "h1", limit: 20 }, key: "sk-or-v1-x" }), { status: 201 });
    if (init!.method === "DELETE" && u.pathname.endsWith("/gone")) return new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 });
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  const k = new OpenRouterKeys("mgmt-key", { fetch: f });
  assert.deepEqual(await k.create("example: a@example.org", 20), { hash: "h1", key: "sk-or-v1-x" });
  await k.setLimit("h1", 50);
  await k.setLimit("h1", null);
  await k.delete("h1");
  await k.delete("gone"); // already deleted: fine
  assert.deepEqual(
    seen.map((s) => [s.method, s.path, s.body]),
    [
      ["POST", "/api/v1/keys", { name: "example: a@example.org", limit: 20, limit_reset: "monthly", include_byok_in_limit: true }],
      ["PATCH", "/api/v1/keys/h1", { limit: 50, limit_reset: "monthly" }],
      ["PATCH", "/api/v1/keys/h1", { limit: null, limit_reset: null }],
      ["DELETE", "/api/v1/keys/h1", null],
      ["DELETE", "/api/v1/keys/gone", null],
    ],
  );
  assert.ok(seen.every((s) => s.auth === "Bearer mgmt-key"));
  const bad = new OpenRouterKeys("k", { fetch: (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch });
  await assert.rejects(bad.create("x", 1), /403/);
});

// ---- machine hours ------------------------------------------------------------------------------

test("machine hours count per user per calendar month; at the cap tasks pause and creates are refused", () =>
  run(async (h, u) => {
    const fresh = () => asEmail(h, u.alice); // tokens expire as the clock moves
    const id = await createTask(h, u.alice);
    const s = await fakeSession(h, id);
    h.clock.advance(4 * 3_600_000);
    assert.equal((await call(h, await fresh(), "GET", "/api/me")).body.usage.machineHours, 4);
    await h.jarvis.tick();
    assert.equal((await call(h, await fresh(), "GET", `/api/tasks/${id}`)).body.state, "running");
    h.clock.advance(6 * 3_600_000 + 1000);
    await h.jarvis.tick();
    await h.jarvis.settle();
    const t = (await call(h, await fresh(), "GET", `/api/tasks/${id}`)).body;
    assert.equal(t.state, "paused");
    assert.equal(t.pausedReason, "machine_hours_cap");
    const me = (await call(h, await fresh(), "GET", "/api/me")).body;
    assert.equal(me.usage.machineHoursCapReached, true);
    const created = await call(h, await fresh(), "POST", "/api/tasks", { prompt: "more" });
    assert.equal(created.status, 429);
    assert.equal(created.body.error.code, "machine_hours_cap");
    assert.equal((await call(h, await fresh(), "POST", `/api/tasks/${id}/resume`)).body.error.code, "machine_hours_cap");
    const notices = (await call(h, await fresh(), "GET", "/api/notices")).body.notices;
    assert.equal(notices.filter((n: { kind: string }) => n.kind === "machine_hours_cap").length, 1);
    await h.jarvis.tick();
    assert.equal((await call(h, await fresh(), "GET", "/api/notices")).body.notices.length, notices.length, "told once per month");
    const adminNotices = (await call(h, await asEmail(h, u.admin), "GET", "/api/notices")).body.notices;
    assert.ok(adminNotices.some((n: { text: string }) => n.text.includes(u.alice)));
    // bob is unaffected
    assert.equal((await call(h, await asEmail(h, u.bob), "POST", "/api/tasks", { prompt: "b" })).status, 201);
    // an admin raises alice's cap: she can resume
    const aliceId = me.user.id;
    await call(h, await asEmail(h, u.admin), "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: 40 });
    assert.equal((await call(h, await fresh(), "POST", `/api/tasks/${id}/resume`)).status, 202);
    s.ws.close();
  }));

test("machine-hour cap: a lowered override pauses at once; a raised cap reached again is told again", () =>
  run(async (h, u) => {
    const fresh = () => asEmail(h, u.alice);
    const id = await createTask(h, u.alice);
    const s = await fakeSession(h, id);
    const aliceId = (await call(h, await fresh(), "GET", "/api/me")).body.user.id;
    h.clock.advance(2 * 3_600_000);
    // the admin lowers alice's cap below what she used: her task pauses without waiting for the tick
    const patched = await call(h, await asEmail(h, u.admin), "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: 1 });
    assert.equal(patched.body.usage.machineHoursCapReached, true);
    await h.jarvis.settle();
    assert.equal((await call(h, await fresh(), "GET", `/api/tasks/${id}`)).body.pausedReason, "machine_hours_cap");
    const capNotices = async (email: string) =>
      (await call(h, await asEmail(h, email), "GET", "/api/notices")).body.notices.filter((n: { kind: string }) => n.kind === "machine_hours_cap");
    assert.equal((await capNotices(u.alice)).length, 1);
    assert.match((await capNotices(u.admin))[0].text, /\(1 h\)/);
    // raised to 3 h: she resumes, uses it up, and both are told again
    await call(h, await asEmail(h, u.admin), "PATCH", `/api/users/${aliceId}/limits`, { machineHoursPerMonth: 3 });
    assert.equal((await call(h, await fresh(), "POST", `/api/tasks/${id}/resume`)).status, 202);
    await h.jarvis.settle();
    h.clock.advance(3_600_000 + 1000);
    await h.jarvis.tick();
    await h.jarvis.settle();
    assert.equal((await call(h, await fresh(), "GET", `/api/tasks/${id}`)).body.state, "paused");
    assert.equal((await capNotices(u.alice)).length, 2);
    assert.equal((await capNotices(u.admin)).length, 2);
    // the admin's Users page shows the cap state
    const list = (await call(h, await asEmail(h, u.admin), "GET", "/api/users")).body.users;
    const a = list.find((x: { user: { id: string } }) => x.user.id === aliceId);
    assert.deepEqual([a.limits.machineHoursPerMonth, a.limits.machineHoursOverride, a.usage.machineHoursCapReached], [3, true, true]);
    s.ws.close();
  }));

test("machine hours reset with the calendar month (a run across midnight on the 1st is split)", () =>
  run(async (h, u) => {
    h.clock.t = Date.UTC(2026, 9, 31, 22, 0, 0);
    await createTask(h, u.alice);
    h.clock.t = Date.UTC(2026, 10, 1, 3, 0, 0);
    const me = (await call(h, await asEmail(h, u.alice), "GET", "/api/me")).body;
    assert.equal(me.usage.month, "2026-11");
    assert.equal(me.usage.machineHours, 3);
  }));

// ---- instance budget ------------------------------------------------------------------------------

test("budget arithmetic: rates, Riemann sum on the previous rate, gap cap, month reset", () => {
  assert.equal(hourlyMachineCostUSD({ cpu_kind: "shared", cpus: 2, memory_mb: 2048 }), 2 * 0.0015 + 2 * (5 / 730));
  const t0 = Date.UTC(2026, 9, 8, 0, 0, 0);
  let r = applySample(null, { nowMs: t0, ratePerHour: 1, capUsd: 16, warnUsd: 8 });
  assert.equal(r.state.spentUsd, 0);
  r = applySample(r.state, { nowMs: t0 + 3 * 3_600_000, ratePerHour: 2, capUsd: 16, warnUsd: 8 });
  assert.equal(r.state.spentUsd, 3);
  r = applySample(r.state, { nowMs: t0 + 100 * 3_600_000, ratePerHour: 2, capUsd: 16, warnUsd: 8 });
  assert.equal(r.state.spentUsd, 3 + 2 * MAX_DELTA_H, "a long gap bills at most MAX_DELTA_H");
  assert.equal(r.warnNotice, true);
  assert.equal(r.enforce, false);
  r = applySample(r.state, { nowMs: t0 + 101 * 3_600_000, ratePerHour: 0, capUsd: 16, warnUsd: 8 });
  assert.equal(r.enforce, true);
  assert.equal(r.capNotice, true);
  assert.equal(r.warnNotice, false);
  r = applySample(r.state, { nowMs: t0 + 102 * 3_600_000, ratePerHour: 0, capUsd: 16, warnUsd: 8 });
  assert.equal(r.enforce, true);
  assert.equal(r.capNotice, false, "the cap notice is sent once");
  r = applySample(r.state, { nowMs: Date.UTC(2026, 10, 1, 0, 1), ratePerHour: 0, capUsd: 16, warnUsd: 8 });
  assert.equal(r.state.month, "2026-11");
  assert.equal(r.state.spentUsd, 0);
  assert.equal(r.enforce, false);
});

test("instance budget: at the cap every task pauses, creates are refused, admins are told", () =>
  run(
    async (h, u) => {
      const a = await createTask(h, u.alice);
      const b = await createTask(h, u.bob);
      await h.jarvis.tick(); // first sample
      // two shared-2x/2GB machines ≈ USD 0.0304/h; one more hour crosses the USD 0.02 cap
      h.clock.advance(3_600_000);
      await h.jarvis.tick();
      await h.jarvis.settle();
      const admin = await asEmail(h, u.admin);
      for (const id of [a, b]) {
        const t = (await call(h, admin, "GET", `/api/tasks/${id}`)).body;
        assert.equal(t.state, "paused");
        assert.equal(t.pausedReason, "instance_budget");
      }
      const budget = (await call(h, admin, "GET", "/api/admin/budget")).body;
      assert.equal(budget.capped, true);
      assert.ok(budget.spentUsd > 0.02);
      const r = await call(h, await asEmail(h, u.alice), "POST", "/api/tasks", { prompt: "x" });
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, "instance_budget");
      assert.ok((await call(h, admin, "GET", "/api/notices")).body.notices.some((n: { kind: string }) => n.kind === "instance_budget"));
      assert.ok((await call(h, await asEmail(h, u.alice), "GET", "/api/notices")).body.notices.some((n: { kind: string }) => n.kind === "instance_budget"));
      // next month: allowed again
      h.clock.t = Date.UTC(2026, 10, 1, 0, 5);
      await h.jarvis.tick();
      assert.equal((await call(h, await asEmail(h, u.alice), "POST", "/api/tasks", { prompt: "x" })).status, 201);
    },
    { config: { budget: { monthlyUsd: 0.02 } } },
  ));

// ---- notices ---------------------------------------------------------------------------------

test("notices: unread count in /api/me, read flags, mark read up to a notice or all; only the caller's own", () =>
  run(async (h, u) => {
    const c = await asEmail(h, u.alice);
    const me = async () => (await call(h, c, "GET", "/api/me")).body;
    const aliceId = (await me()).user.id;
    const bobId = (await call(h, await asEmail(h, u.bob), "GET", "/api/me")).body.user.id;
    assert.equal((await me()).unreadNotices, 0);
    for (const text of ["one", "two", "three"]) {
      addNotice(h.jarvis.ctx, aliceId, "task_failed", text);
      h.clock.advance(1000);
    }
    addNotice(h.jarvis.ctx, bobId, "task_failed", "bob's");
    assert.equal((await me()).unreadNotices, 3);
    const list = (await call(h, c, "GET", "/api/notices")).body.notices;
    assert.deepEqual(list.map((n: { text: string }) => n.text), ["three", "two", "one"]);
    assert.ok(list.every((n: { read: boolean }) => n.read === false));
    // up to "two": one and two are read
    const r = await call(h, c, "POST", "/api/notices/read", { upTo: list[1].id });
    assert.equal(r.body.unreadNotices, 1);
    const after = (await call(h, c, "GET", "/api/notices")).body.notices;
    assert.deepEqual(after.map((n: { read: boolean }) => n.read), [false, true, true]);
    // bob's notice id is not alice's to mark
    const bobNotice = (await call(h, await asEmail(h, u.bob), "GET", "/api/notices")).body.notices[0].id;
    assert.equal((await call(h, c, "POST", "/api/notices/read", { upTo: bobNotice })).status, 404);
    assert.equal((await call(h, c, "POST", "/api/notices/read", {})).body.unreadNotices, 0);
    assert.equal((await me()).unreadNotices, 0);
    assert.equal((await call(h, await asEmail(h, u.bob), "GET", "/api/me")).body.unreadNotices, 1, "bob's stays unread");
  }));
