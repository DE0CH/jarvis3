// Push notifications (docs/API.md section 16): who gets which push, per-kind opt-out, no private
// content in a push, subscriptions and their isolation, and cleanup on revoke and offboarding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, asService, createTask, fakeSession, sessionTokenOf, GATE, type Harness, type Cred } from "./helpers.ts";
import { FakePush } from "../src/fakes/push.ts";
import { addNotice } from "../src/ctx.ts";

const WEB = (n: number) => `https://fcm.googleapis.com/fcm/send/endpoint-${n}`;
const P256DH = Buffer.alloc(65, 4).toString("base64url");
const AUTH = Buffer.alloc(16, 7).toString("base64url");
const TOKEN = (c: string) => c.repeat(64);

async function setup() {
  const push = new FakePush();
  const h = await harness({ push });
  const u = await seedUsers(h);
  const id = async (email: string) => (await call(h, await asEmail(h, email), "GET", "/api/me")).body.user.id as string;
  return { h, u, push, ids: { alice: await id(u.alice), bob: await id(u.bob), admin: await id(u.admin) } };
}

async function pairDevice(h: Harness, email: string): Promise<{ id: string; cred: Cred }> {
  h.clock.advance(31_000);
  const r = await call(h, await asEmail(h, email), "GET", "/api/devices/pair?state=abcdefghijklmnop1234&name=phone");
  const loc = new URL(r.headers.get("location")!);
  return { id: loc.searchParams.get("id")!, cred: await asService(h, loc.searchParams.get("clientId")!) };
}

const subscribeWeb = (h: Harness, cred: Cred, n: number) => call(h, cred, "POST", "/api/push/subscriptions", { kind: "web", endpoint: WEB(n), keys: { p256dh: P256DH, auth: AUTH }, label: "Chrome" });

test("settings: feature flag, default kinds, subscription checks", async () => {
  const { h, u } = await setup();
  try {
    const alice = await asEmail(h, u.alice);
    const me = await call(h, alice, "GET", "/api/me");
    assert.deepEqual(me.body.features.push, { apns: true, webPush: true });
    const s = await call(h, alice, "GET", "/api/push");
    assert.equal(s.status, 200);
    assert.equal(s.body.webPushPublicKey.length, 87);
    assert.ok(s.body.kinds.every((k: { enabled: boolean }) => k.enabled), "every kind is on by default");
    assert.deepEqual(
      s.body.kinds.map((k: { kind: string }) => k.kind),
      ["approval_needed", "question", "approval_decided", "channel_post", "caps", "schedule_skipped", "wakeup", "task_failed", "other"],
    );
    // the server POSTs to the endpoint: only https on a known push service
    for (const endpoint of ["http://fcm.googleapis.com/x", "https://169.254.169.254/latest", "https://evil.example/fcm.googleapis.com", "https://fcm.googleapis.com.evil.example/x", "https://u:p@fcm.googleapis.com/x"]) {
      const r = await call(h, alice, "POST", "/api/push/subscriptions", { kind: "web", endpoint, keys: { p256dh: P256DH, auth: AUTH } });
      assert.equal(r.status, 400, endpoint);
    }
    assert.equal((await call(h, alice, "POST", "/api/push/subscriptions", { kind: "web", endpoint: WEB(1), keys: { p256dh: "short", auth: AUTH } })).status, 400);
    assert.equal((await call(h, alice, "POST", "/api/push/subscriptions", { kind: "web", endpoint: "https://web.push.apple.com/QF8", keys: { p256dh: P256DH, auth: AUTH } })).status, 201);
    assert.equal((await call(h, alice, "POST", "/api/push/subscriptions", { kind: "web", endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", keys: { p256dh: P256DH, auth: AUTH } })).status, 201);
    // an APNs token only from a paired device (the iOS app), never from a browser login
    assert.equal((await call(h, alice, "POST", "/api/push/subscriptions", { kind: "apns", token: TOKEN("a") })).status, 403);
    const dev = await pairDevice(h, u.alice);
    assert.equal((await call(h, dev.cred, "POST", "/api/push/subscriptions", { kind: "apns", token: "not-hex" })).status, 400);
    const a = await call(h, dev.cred, "POST", "/api/push/subscriptions", { kind: "apns", token: TOKEN("A"), environment: "sandbox", label: "Alice's iPhone" });
    assert.equal(a.status, 201);
    assert.equal(a.body.deviceId, dev.id);
    assert.equal(a.body.label, "Alice's iPhone");
    assert.equal((await call(h, alice, "PUT", "/api/push/kinds", { kinds: { made_up: false } })).status, 400);
    assert.equal((await call(h, alice, "PUT", "/api/push/kinds", { kinds: { caps: "no" } })).status, 400);
  } finally {
    await h.close();
  }
});

test("a notice is pushed only to its own user's devices, with no private content", async () => {
  const { h, u, push, ids } = await setup();
  try {
    const alice = await asEmail(h, u.alice), bob = await asEmail(h, u.bob);
    assert.equal((await subscribeWeb(h, alice, 1)).status, 201);
    assert.equal((await subscribeWeb(h, bob, 2)).status, 201);
    const aliceDev = await pairDevice(h, u.alice);
    await call(h, aliceDev.cred, "POST", "/api/push/subscriptions", { kind: "apns", token: TOKEN("b") });
    addNotice(h.jarvis.ctx, ids.alice, "task_failed", "Secret project Falcon could not start: no machine", null);
    await h.jarvis.settle();
    assert.equal(push.to(WEB(2)).length, 0, "bob gets nothing of alice's");
    const [web] = push.to(WEB(1));
    const [ios] = push.to(TOKEN("b"));
    assert.ok(web && ios);
    assert.equal(web.title, "A task failed");
    assert.doesNotMatch(JSON.stringify(push.sent), /Falcon|no machine/, "the notice text never leaves in a push");
    assert.equal(web.data.kind, "task_failed");
    assert.equal(web.badge, 1, "the badge is the unread count");
    // the app fetches the notice itself; bob can't read alice's notice
    const notices = await call(h, bob, "GET", "/api/notices");
    assert.ok(!notices.body.notices.some((n: { id: string }) => n.id === web.data.noticeId));
    const mine = await call(h, alice, "GET", "/api/notices");
    assert.ok(mine.body.notices.some((n: { id: string }) => n.id === web.data.noticeId));
    // the subscription records the delivery
    const s = await call(h, alice, "GET", "/api/push");
    assert.equal(s.body.subscriptions.length, 2);
    assert.ok(s.body.subscriptions.every((x: { lastOkAt: string | null }) => x.lastOkAt !== null));
    // bob's view lists only bob's subscription
    const sb = await call(h, bob, "GET", "/api/push");
    assert.equal(sb.body.subscriptions.length, 1);
  } finally {
    await h.close();
  }
});

test("per-kind opt-out is honoured; a question is its own kind", async () => {
  const { h, u, push, ids } = await setup();
  try {
    const alice = await asEmail(h, u.alice), admin = await asEmail(h, u.admin);
    await subscribeWeb(h, alice, 1);
    await subscribeWeb(h, admin, 3);
    const off = await call(h, alice, "PUT", "/api/push/kinds", { kinds: { channel_post: false, caps: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.kinds.find((k: { kind: string }) => k.kind === "channel_post").enabled, false);
    assert.equal(off.body.kinds.find((k: { kind: string }) => k.kind === "approval_decided").enabled, true);
    // a channel post from alice's task: no push (turned off); a cap notice: no push either
    const t = await createTask(h, u.alice);
    await fakeSession(h, t);
    const sess = await asService(h, GATE, sessionTokenOf(h, t));
    assert.equal((await call(h, sess, "POST", "/api/session/posts", { text: "Quarterly numbers are in" })).status, 201);
    addNotice(h.jarvis.ctx, ids.alice, "machine_hours_cap", "cap", null);
    await h.jarvis.settle();
    assert.equal(push.to(WEB(1)).length, 0);
    // ask the boss: the admin's push is a question, not a plain approval
    const q = await call(h, sess, "POST", "/api/session/approvals", { kind: "question", question: "Offer the client 10% or 15%?", options: ["10%", "15%"] });
    assert.equal(q.status, 201);
    await h.jarvis.settle();
    const [asked] = push.to(WEB(3));
    assert.equal(asked?.data.pushKind, "question");
    assert.equal(asked?.title, "A question for you");
    assert.equal(asked?.data.approvalId, q.body.id);
    assert.doesNotMatch(JSON.stringify(asked), /10%|client/);
    // the admin turns questions off: the next question is not pushed, an approval still is
    await call(h, admin, "PUT", "/api/push/kinds", { kinds: { question: false } });
    await call(h, sess, "POST", "/api/session/approvals", { kind: "question", question: "And the other client?" });
    await h.jarvis.settle();
    assert.equal(push.to(WEB(3)).length, 1);
    // alice gets the decision (approval_decided is on)
    await call(h, admin, "POST", `/api/approvals/${q.body.id}/decide`, { decision: "approve", note: "10%" });
    await h.jarvis.settle();
    const decided = push.to(WEB(1));
    assert.equal(decided.length, 1);
    assert.equal(decided[0]!.data.pushKind, "approval_decided");
    // channel posts back on: one push, and a burst from the same task within a minute is one push
    await call(h, alice, "PUT", "/api/push/kinds", { kinds: { channel_post: true } });
    await call(h, sess, "POST", "/api/session/posts", { text: "one" });
    await call(h, sess, "POST", "/api/session/posts", { text: "two" });
    await h.jarvis.settle();
    assert.equal(push.to(WEB(1)).filter((m) => m.data.pushKind === "channel_post").length, 1);
    h.clock.advance(61_000);
    await call(h, sess, "POST", "/api/session/posts", { text: "three" });
    await h.jarvis.settle();
    assert.equal(push.to(WEB(1)).filter((m) => m.data.pushKind === "channel_post").length, 2);
  } finally {
    await h.close();
  }
});

test("subscriptions: moving between users, someone else's is a 404, dead ones are dropped", async () => {
  const { h, u, push, ids } = await setup();
  try {
    const alice = await asEmail(h, u.alice), bob = await asEmail(h, u.bob), admin = await asEmail(h, u.admin);
    const a = await subscribeWeb(h, alice, 1);
    // bob can neither see nor delete alice's subscription
    assert.equal((await call(h, bob, "DELETE", `/api/push/subscriptions/${a.body.id}`)).status, 404);
    assert.equal((await call(h, bob, "DELETE", `/api/push/subscriptions/nope`)).status, 404);
    // the same browser registers for bob (bob signed in on it): alice's notices stop going there
    const b = await subscribeWeb(h, bob, 1);
    assert.equal(b.status, 201);
    assert.equal(b.body.id, a.body.id);
    assert.equal((await call(h, alice, "GET", "/api/push")).body.subscriptions.length, 0);
    addNotice(h.jarvis.ctx, ids.alice, "task_failed", "x");
    await h.jarvis.settle();
    assert.equal(push.to(WEB(1)).length, 0);
    addNotice(h.jarvis.ctx, ids.bob, "task_failed", "y");
    await h.jarvis.settle();
    assert.equal(push.to(WEB(1)).length, 1);
    // a failed send is recorded; a gone endpoint is removed
    push.answers.set(WEB(1), { ok: false, status: 500, error: "500: server error", gone: false });
    const t = await call(h, bob, "POST", "/api/push/test");
    assert.deepEqual(t.body.results, [{ id: b.body.id, ok: false, error: "500: server error" }]);
    assert.equal((await call(h, bob, "GET", "/api/push")).body.subscriptions[0].lastError, "500: server error");
    push.answers.set(WEB(1), { ok: false, status: 410, error: "410: gone", gone: true });
    await call(h, bob, "POST", "/api/push/test");
    assert.equal((await call(h, bob, "GET", "/api/push")).body.subscriptions.length, 0);
    // the owner deletes their own; an admin may delete anyone's
    const c = await subscribeWeb(h, bob, 5);
    const d = await subscribeWeb(h, bob, 6);
    assert.equal((await call(h, bob, "DELETE", `/api/push/subscriptions/${c.body.id}`)).status, 200);
    assert.equal((await call(h, admin, "DELETE", `/api/push/subscriptions/${d.body.id}`)).status, 200);
    assert.equal((await call(h, bob, "GET", "/api/push")).body.subscriptions.length, 0);
  } finally {
    await h.close();
  }
});

test("revoking a device and offboarding stop the pushes", async () => {
  const { h, u, push, ids } = await setup();
  try {
    const alice = await asEmail(h, u.alice);
    const dev = await pairDevice(h, u.alice);
    await call(h, dev.cred, "POST", "/api/push/subscriptions", { kind: "apns", token: TOKEN("c") });
    await subscribeWeb(h, alice, 1);
    assert.equal((await call(h, alice, "DELETE", `/api/devices/${dev.id}`)).status, 200);
    const left = (await call(h, alice, "GET", "/api/push")).body.subscriptions;
    assert.deepEqual(left.map((s: { kind: string }) => s.kind), ["web"], "the revoked device's APNs token is gone");
    // offboarding: alice leaves the directory
    h.directory.set(u.alice, { suspended: true });
    await h.jarvis.syncDirectory();
    await h.jarvis.settle();
    const before = push.sent.length;
    addNotice(h.jarvis.ctx, ids.alice, "task_failed", "after offboarding");
    await h.jarvis.settle();
    assert.equal(push.sent.length, before);
    const n = h.jarvis.ctx.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(ids.alice) as { n: number };
    assert.equal(n.n, 0);
  } finally {
    await h.close();
  }
});

test("without push keys the routes answer 409 and the feature flag is absent", async () => {
  const h = await harness();
  try {
    const u = await seedUsers(h);
    const alice = await asEmail(h, u.alice);
    assert.equal((await call(h, alice, "GET", "/api/me")).body.features.push, undefined);
    assert.equal((await call(h, alice, "GET", "/api/push")).body.webPushPublicKey, null);
    assert.equal((await subscribeWeb(h, alice, 1)).status, 409);
    assert.equal((await call(h, alice, "POST", "/api/push/test")).status, 409);
  } finally {
    await h.close();
  }
});
