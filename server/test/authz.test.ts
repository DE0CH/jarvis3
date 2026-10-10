// The full authorisation matrix: every route and the daemon proxy, as
//   owner (identity login), owner (paired device), another staff member, admin,
//   a suspended user, an unknown email, a revoked device, a session token,
//   the session-gate token without a session token, and no credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  harness,
  seedUsers,
  call,
  asEmail,
  asService,
  createTask,
  fakeSession,
  openWs,
  nextMessage,
  GATE,
  type Harness,
  type Cred,
} from "./helpers.ts";
import { FakeFetch, FakeRelayProxy, FakeSearch } from "../src/fakes/tools.ts";
import { enqueue } from "../src/inbox.ts";

type Who = "owner" | "ownerDevice" | "other" | "admin" | "suspended" | "unknown" | "revokedDevice" | "session" | "gate" | "none";
const WHO: Who[] = ["owner", "ownerDevice", "other", "admin", "suspended", "unknown", "revokedDevice", "session", "gate", "none"];

/** Route classes: who may call them. `ownerOnly`: the owner, not even an admin. */
type Kind = "member" | "owned" | "ownerOnly" | "admin" | "session";

interface R {
  kind: Kind;
  method: string;
  path: (ids: Ids) => string;
  body?: unknown;
}
interface Ids {
  task: string; // alice's task
  alice: string; // alice's user id
  device: string; // alice's active device
  note: string; // a note in alice's layer
  approval: string; // a question from alice's task
  schedule: string; // alice's schedule
  wakeup: string; // a wakeup of alice's task
  inbox: string; // a message in alice's task's inbox
}

// Destructive routes come last so the earlier ones see the resources intact.
const ROUTES: R[] = [
  { kind: "member", method: "GET", path: () => "/api/me" },
  { kind: "member", method: "GET", path: () => "/api/models" },
  { kind: "member", method: "GET", path: () => "/api/tasks" },
  { kind: "member", method: "GET", path: () => "/api/devices" },
  { kind: "member", method: "GET", path: () => "/api/notices" },
  { kind: "member", method: "POST", path: () => "/api/notices/read" },
  { kind: "member", method: "POST", path: () => "/api/tasks", body: { prompt: "matrix" } },
  { kind: "member", method: "GET", path: () => "/api/suggestions" },
  { kind: "owned", method: "GET", path: (i) => `/api/suggestions?userId=${i.alice}` },
  { kind: "owned", method: "POST", path: (i) => `/api/users/${i.alice}/layer/suggest`, body: { kind: "instructions" } },
  { kind: "owned", method: "GET", path: (i) => `/api/tasks/${i.task}/archive` },
  { kind: "owned", method: "GET", path: (i) => `/api/tasks/${i.task}` },
  { kind: "owned", method: "GET", path: (i) => `/api/tasks?userId=${i.alice}` },
  { kind: "owned", method: "GET", path: (i) => `/api/tasks/${i.task}/daemon/http/api/files/download?token=t` },
  { kind: "owned", method: "POST", path: (i) => `/api/tasks/${i.task}/daemon/http/api/x`, body: { a: 1 } },
  { kind: "owned", method: "GET", path: (i) => `/api/users/${i.alice}` },
  { kind: "owned", method: "GET", path: (i) => `/api/users/${i.alice}/layer` },
  { kind: "owned", method: "GET", path: (i) => `/api/users/${i.alice}/layers` },
  { kind: "owned", method: "PUT", path: (i) => `/api/users/${i.alice}/layer/instructions`, body: { text: "be brief" } },
  { kind: "owned", method: "PUT", path: (i) => `/api/users/${i.alice}/layer/skills/my-skill`, body: { files: { "SKILL.md": "x" } } },
  { kind: "owned", method: "POST", path: (i) => `/api/users/${i.alice}/layer/notes`, body: { text: "note" } },
  { kind: "owned", method: "DELETE", path: (i) => `/api/users/${i.alice}/layer/notes/${i.note}` },
  { kind: "owned", method: "DELETE", path: (i) => `/api/users/${i.alice}/layer/skills/my-skill` },
  { kind: "owned", method: "POST", path: (i) => `/api/users/${i.alice}/layer/reset` },
  { kind: "owned", method: "POST", path: (i) => `/api/users/${i.alice}/layer/undo` },
  { kind: "owned", method: "GET", path: (i) => `/api/users/${i.alice}/files` },
  { kind: "owned", method: "GET", path: (i) => `/api/users/${i.alice}/files/docs/a.txt` },
  { kind: "owned", method: "GET", path: (i) => `/api/users/${i.alice}/files/docs/a.txt?link=1` },
  { kind: "owned", method: "PUT", path: (i) => `/api/users/${i.alice}/files/docs/matrix.txt`, body: { any: "bytes" } },
  { kind: "owned", method: "POST", path: (i) => `/api/users/${i.alice}/files/move`, body: { from: "docs/matrix.txt", to: "docs/moved.txt" } },
  { kind: "member", method: "GET", path: () => "/api/search?q=matrix" },
  { kind: "owned", method: "GET", path: (i) => `/api/search?q=matrix&userId=${i.alice}` },
  { kind: "owned", method: "GET", path: (i) => `/api/search?q=matrix&taskId=${i.task}` },
  { kind: "admin", method: "GET", path: () => "/api/search?q=matrix&all=1" },
  { kind: "owned", method: "GET", path: (i) => `/api/tasks/${i.task}/transcript` },
  { kind: "member", method: "POST", path: () => "/api/tasks", body: { prompt: "matrix with a file", attachments: [] } },
  { kind: "member", method: "GET", path: () => "/api/approvals" },
  { kind: "owned", method: "GET", path: (i) => `/api/approvals/${i.approval}` },
  { kind: "owned", method: "GET", path: (i) => `/api/approvals?taskId=${i.task}` },
  { kind: "member", method: "GET", path: () => "/api/schedules" },
  { kind: "member", method: "POST", path: () => "/api/schedules", body: { prompt: "matrix", cron: "0 9 * * *", timeZone: "UTC" } },
  { kind: "member", method: "POST", path: () => "/api/schedules/preview", body: { cron: "0 9 * * *", timeZone: "UTC" } },
  { kind: "member", method: "GET", path: () => "/api/wakeups" },
  { kind: "member", method: "GET", path: () => "/api/channels" },
  { kind: "owned", method: "GET", path: (i) => `/api/schedules/${i.schedule}` },
  { kind: "owned", method: "GET", path: (i) => `/api/schedules?userId=${i.alice}` },
  { kind: "owned", method: "PATCH", path: (i) => `/api/schedules/${i.schedule}`, body: { title: "renamed" } },
  { kind: "owned", method: "POST", path: (i) => `/api/schedules/${i.schedule}/run` },
  { kind: "owned", method: "GET", path: (i) => `/api/wakeups?taskId=${i.task}` },
  { kind: "owned", method: "GET", path: (i) => `/api/wakeups?userId=${i.alice}` },
  { kind: "owned", method: "GET", path: (i) => `/api/channels?userId=${i.alice}` },
  { kind: "owned", method: "GET", path: (i) => `/api/tasks/${i.task}/posts` },
  { kind: "owned", method: "POST", path: (i) => `/api/tasks/${i.task}/posts/read` },
  { kind: "admin", method: "GET", path: () => "/api/schedules?all=1" },
  { kind: "admin", method: "GET", path: () => "/api/wakeups?all=1" },
  { kind: "admin", method: "GET", path: () => "/api/channels?all=1" },
  { kind: "admin", method: "GET", path: () => "/api/users" },
  { kind: "admin", method: "GET", path: () => "/api/suggestions?all=1" },
  { kind: "admin", method: "GET", path: () => "/api/tasks?all=1" },
  { kind: "admin", method: "GET", path: () => "/api/devices?all=1" },
  { kind: "admin", method: "PATCH", path: (i) => `/api/users/${i.alice}/limits`, body: { machineHoursPerMonth: 20 } },
  { kind: "admin", method: "GET", path: () => "/api/admin/budget" },
  { kind: "admin", method: "POST", path: () => "/api/admin/directory/sync" },
  { kind: "admin", method: "GET", path: () => "/api/admin/tools" },
  { kind: "admin", method: "PATCH", path: (i) => `/api/users/${i.alice}/limits`, body: { toolsMonthlyUsd: 3, proxyMonthlyGb: 2 } },
  { kind: "session", method: "GET", path: () => "/api/session/bundle" },
  { kind: "session", method: "GET", path: () => "/api/session/org-env.tar" },
  { kind: "session", method: "POST", path: () => "/api/session/notes", body: { text: "remember this" } },
  { kind: "session", method: "POST", path: () => "/api/session/status", body: { activity: "busy" } },
  { kind: "session", method: "GET", path: () => "/api/session/actions" },
  { kind: "session", method: "POST", path: () => "/api/session/approvals", body: { kind: "question", question: "matrix?" } },
  { kind: "session", method: "GET", path: (i) => `/api/session/approvals/${i.approval}` },
  { kind: "session", method: "GET", path: () => "/api/session/tools" },
  { kind: "session", method: "POST", path: () => "/api/session/tools/search", body: { query: "matrix" } },
  { kind: "session", method: "POST", path: () => "/api/session/tools/fetch", body: { url: "https://example.org/" } },
  { kind: "session", method: "GET", path: () => "/api/session/files" },
  { kind: "session", method: "GET", path: () => "/api/session/files/docs/a.txt" },
  { kind: "session", method: "PUT", path: () => "/api/session/files/from-session.txt", body: { saved: true } },
  { kind: "session", method: "GET", path: () => "/api/session/transcript" },
  { kind: "session", method: "POST", path: () => "/api/session/transcript", body: { agentId: "matrix-agent", epoch: "e", entries: [{ seq: 0, role: "user", text: "matrix entry", at: "2026-10-08T12:00:00.000Z" }] } },
  { kind: "session", method: "GET", path: () => "/api/session/search?q=matrix" },
  { kind: "session", method: "GET", path: (i) => `/api/session/tasks/${i.task}/transcript` },
  { kind: "owned", method: "DELETE", path: (i) => `/api/users/${i.alice}/files/docs/a.txt` },
  { kind: "session", method: "GET", path: () => "/api/session/wakeups" },
  { kind: "session", method: "POST", path: () => "/api/session/wakeups", body: { name: "matrix", inSeconds: 600, prompt: "matrix" } },
  { kind: "session", method: "DELETE", path: () => "/api/session/wakeups/matrix" },
  { kind: "session", method: "GET", path: () => "/api/session/inbox" },
  { kind: "session", method: "POST", path: (i) => `/api/session/inbox/${i.inbox}/ack` },
  { kind: "session", method: "POST", path: () => "/api/session/posts", body: { text: "matrix result" } },
  { kind: "ownerOnly", method: "POST", path: (i) => `/api/tasks/${i.task}/wakeups`, body: { at: "2026-10-09T09:00:00Z", prompt: "matrix" } },
  { kind: "owned", method: "DELETE", path: (i) => `/api/wakeups/${i.wakeup}` },
  { kind: "owned", method: "DELETE", path: (i) => `/api/schedules/${i.schedule}` },
  { kind: "owned", method: "POST", path: (i) => `/api/tasks/${i.task}/pause` },
  { kind: "owned", method: "POST", path: (i) => `/api/tasks/${i.task}/resume` },
  { kind: "owned", method: "DELETE", path: (i) => `/api/tasks/${i.task}` },
  { kind: "owned", method: "DELETE", path: (i) => `/api/devices/${i.device}` },
];

/** The expected outcome: a status, or "allowed" (anything but 401/403/404 — the handler ran). */
function expected(who: Who, kind: Kind): number | "allowed" {
  if (who === "none") return 401;
  if (who === "suspended" || who === "unknown" || who === "revokedDevice") return 403;
  if (kind === "session") return who === "session" ? "allowed" : 401;
  if (who === "session" || who === "gate") return 403;
  if (who === "admin") return kind === "ownerOnly" ? 404 : "allowed";
  if (kind === "member") return "allowed";
  if (kind === "admin") return 404;
  return who === "owner" || who === "ownerDevice" ? "allowed" : 404;
}

async function setup(): Promise<{ h: Harness; ids: Ids; creds: Record<Who, Cred | null> }> {
  // Tier 0 tools on (fakes), so their routes run for real; the relay points at a closed port
  const h = await harness({
    config: {
      roles: {
        admin: { openrouterMonthlyUsd: 100, machineHoursPerMonth: null, admin: true, toolsMonthlyUsd: 10, proxyMonthlyGb: 1 },
        staff: { openrouterMonthlyUsd: 20, machineHoursPerMonth: 10, toolsMonthlyUsd: 10, proxyMonthlyGb: 1 },
      },
      tools: { search: { provider: "fake" }, fetch: { provider: "fake" }, proxy: { provider: "fake" } },
    },
    tools: { search: new FakeSearch(), fetch: new FakeFetch(), proxy: new FakeRelayProxy({ host: "127.0.0.1", port: 9 }) },
  });
  const u = await seedUsers(h);
  const aliceCred = await asEmail(h, u.alice);
  const me = await call(h, aliceCred, "GET", "/api/me");
  const aliceId = me.body.user.id as string;
  const task = await createTask(h, u.alice);
  const s = await fakeSession(h, task);
  // alice pairs two devices; one is revoked
  const pair = async () => {
    h.clock.advance(31_000);
    const r = await call(h, aliceCred, "GET", "/api/devices/pair?state=abcdefghijklmnop1234&name=phone");
    const loc = new URL(r.headers.get("location")!);
    return { id: loc.searchParams.get("id")!, clientId: loc.searchParams.get("clientId")! };
  };
  const dev = await pair();
  const revoked = await pair();
  assert.equal((await call(h, aliceCred, "DELETE", `/api/devices/${revoked.id}`)).status, 200);
  const note = await call(h, aliceCred, "POST", `/api/users/${aliceId}/layer/notes`, { text: "seed note" });
  assert.equal((await call(h, aliceCred, "PUT", "/api/users/me/files/docs/a.txt", { seed: "file" })).status, 201);
  // suspend sam
  h.directory.set(u.sus, { suspended: true });
  await h.jarvis.syncDirectory();
  await h.jarvis.settle();
  const creds: Record<Who, Cred | null> = {
    owner: aliceCred,
    ownerDevice: await asService(h, dev.clientId),
    other: await asEmail(h, u.bob),
    admin: await asEmail(h, u.admin),
    suspended: await asEmail(h, u.sus),
    unknown: await asEmail(h, "stranger@example.net"),
    revokedDevice: await asService(h, revoked.clientId),
    session: await asService(h, GATE, s.token),
    gate: await asService(h, GATE),
    none: null,
  };
  const q = await call(h, creds.session, "POST", "/api/session/approvals", { kind: "question", question: "Which client first?" });
  const sched = await call(h, aliceCred, "POST", "/api/schedules", { prompt: "seed", cron: "0 9 * * 1", timeZone: "Europe/London" });
  const wake = await call(h, creds.session, "POST", "/api/session/wakeups", { name: "seed", inSeconds: 3000, prompt: "seed" });
  const inboxId = enqueue(h.jarvis.ctx, task, "wakeup", wake.body.id, "seed message");
  await call(h, creds.session, "POST", "/api/session/posts", { text: "seed post" });
  return {
    h,
    ids: { task, alice: aliceId, device: dev.id, note: note.body.id, approval: q.body.id, schedule: sched.body.id, wakeup: wake.body.id, inbox: inboxId },
    creds,
  };
}

for (const who of WHO) {
  test(`authorisation matrix: ${who} on every route`, async () => {
    const { h, ids, creds } = await setup();
    try {
      for (const r of ROUTES) {
        const path = r.path(ids);
        const res = await call(h, creds[who], r.method, path, r.body);
        const want = expected(who, r.kind);
        const label = `${who} ${r.method} ${path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`;
        if (process.env.MATRIX_DEBUG) console.log(label);
        if (want === "allowed") assert.ok(![401, 403, 404].includes(res.status) && res.status < 500, label);
        else assert.equal(res.status, want, label);
        if (typeof want === "number") assert.ok(res.body?.error?.code, `${label}: error body`);
        await h.jarvis.settle();
      }
      // health needs no identity at all
      assert.equal((await call(h, creds[who], "GET", "/api/health")).status, 200);
    } finally {
      await h.close();
    }
  });
}

test("authorisation matrix: daemon proxy for every caller", async () => {
  const { h, ids, creds } = await setup();
  try {
    for (const who of WHO) {
      const path = `/api/tasks/${ids.task}/daemon`;
      const want: number | "allowed" =
        who === "none" ? 401 : ["suspended", "unknown", "revokedDevice", "session", "gate"].includes(who) ? 403 : who === "other" ? 404 : "allowed";
      if (want === "allowed") {
        const ws = await openWs(h, creds[who], path);
        ws.send(`hello from ${who}`);
        assert.equal(await nextMessage(ws), `echo:hello from ${who}`, who);
        ws.close();
      } else {
        await assert.rejects(openWs(h, creds[who], path), (e: { status?: number }) => e.status === want, `${who} should get ${want}`);
      }
    }
  } finally {
    await h.close();
  }
});

test("authorisation matrix: metered proxy relay for every caller", async () => {
  const { h, creds } = await setup();
  try {
    for (const who of WHO) {
      const path = "/api/session/proxy?host=example.org&port=443";
      const want: number | "allowed" = who === "none" ? 401 : ["suspended", "unknown", "revokedDevice"].includes(who) ? 403 : who === "session" ? "allowed" : 401;
      if (want === "allowed") {
        const ws = await openWs(h, creds[who], path);
        // the upstream at port 9 refuses: the tunnel reports it and closes
        assert.equal(JSON.parse(await nextMessage(ws, 5000)).ok, false);
        ws.close();
      } else {
        await assert.rejects(openWs(h, creds[who], path), (e: { status?: number }) => e.status === want, `${who} should get ${want}`);
      }
    }
  } finally {
    await h.close();
  }
});

test("a revoked device gets its own error code; a suspended user's device gets forbidden", async () => {
  const { h, creds } = await setup();
  try {
    const r = await call(h, creds.revokedDevice, "GET", "/api/me");
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "device_revoked");
    const unknown = await call(h, await asService(h, "no-such-device.access"), "GET", "/api/me");
    assert.equal(unknown.body.error.code, "forbidden");
  } finally {
    await h.close();
  }
});

test("another user's task is indistinguishable from a missing one", async () => {
  const { h, ids, creds } = await setup();
  try {
    const theirs = await call(h, creds.other, "GET", `/api/tasks/${ids.task}`);
    const missing = await call(h, creds.other, "GET", `/api/tasks/ffffffffffffffff`);
    assert.equal(theirs.status, 404);
    assert.deepEqual(theirs.body, missing.body);
    const layer = await call(h, creds.other, "GET", `/api/users/${ids.alice}/layer`);
    const nouser = await call(h, creds.other, "GET", `/api/users/nobody/layer`);
    assert.equal(layer.status, 404);
    assert.deepEqual(layer.body, nouser.body);
    const list = await call(h, creds.other, "GET", "/api/tasks");
    assert.deepEqual(list.body.tasks, [], "bob's list does not show alice's task");
    const adminList = await call(h, creds.admin, "GET", "/api/tasks?all=1");
    assert.ok(adminList.body.tasks.some((t: { id: string }) => t.id === ids.task), "admin sees everything");
  } finally {
    await h.close();
  }
});

test("pairing needs an identity login; a device can't pair another device", async () => {
  const { h, creds } = await setup();
  try {
    h.clock.advance(60_000);
    const viaDevice = await call(h, creds.ownerDevice, "GET", "/api/devices/pair?state=abcdefghijklmnop9999");
    const loc = new URL(viaDevice.headers.get("location")!);
    assert.equal(loc.protocol, "jarvis3:");
    assert.equal(loc.searchParams.get("status"), "403");
    assert.equal(loc.searchParams.get("clientSecret"), null);
    const viaSession = await call(h, creds.session, "GET", "/api/devices/pair?state=abcdefghijklmnop9999");
    assert.equal(new URL(viaSession.headers.get("location")!).searchParams.get("status"), "403");
    const bad = await call(h, creds.owner, "GET", "/api/devices/pair?state=short");
    assert.equal(bad.status, 400);
    // rate limit: a second pairing within 30 s
    const first = await call(h, creds.owner, "GET", "/api/devices/pair?state=abcdefghijklmnop0001");
    assert.ok(new URL(first.headers.get("location")!).searchParams.get("clientSecret"));
    const second = await call(h, creds.owner, "GET", "/api/devices/pair?state=abcdefghijklmnop0002");
    assert.equal(new URL(second.headers.get("location")!).searchParams.get("status"), "429");
  } finally {
    await h.close();
  }
});

test("a session token reaches only its own task's data", async () => {
  const { h, ids, creds } = await setup();
  try {
    // bob's task + session
    const bobTask = await createTask(h, "bob@example.org");
    const bobS = await fakeSession(h, bobTask);
    const bobBundle = await call(h, await asService(h, GATE, bobS.token), "GET", "/api/session/bundle");
    assert.equal(bobBundle.status, 200);
    // alice's session writes a note: it lands in alice's layer, not bob's
    await call(h, creds.session, "POST", "/api/session/notes", { text: "alice fact" });
    const aliceLayer = await call(h, creds.owner, "GET", `/api/users/${ids.alice}/layer`);
    assert.ok(aliceLayer.body.notes.some((n: { text: string; taskId: string }) => n.text === "alice fact" && n.taskId === ids.task));
    const bobLayer = await call(h, await asEmail(h, "bob@example.org"), "GET", "/api/users/me/layer");
    assert.ok(!bobLayer.body.notes.some((n: { text: string }) => n.text === "alice fact"));
    // a session token is not accepted with a user's identity, nor a forged token with the gate
    const withUser = await call(h, { ...creds.owner!, bearer: bobS.token }, "GET", "/api/session/bundle");
    assert.equal(withUser.status, 401);
    const forged = await call(h, await asService(h, GATE, "f".repeat(64)), "GET", "/api/session/bundle");
    assert.equal(forged.status, 401);
    // a session can't open another task's daemon or channel as someone else
    await assert.rejects(openWs(h, creds.session, `/api/tasks/${bobTask}/daemon`), (e: { status?: number }) => e.status === 403);
  } finally {
    await h.close();
  }
});
