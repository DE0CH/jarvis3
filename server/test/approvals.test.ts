// Actions and approvals: the broker's named actions and policies, the one queue, who may decide,
// access grants, "ask the boss", guards, and Tier 3 approvals signed with a passkey.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";
import { harness, seedUsers, call, asEmail, asService, createTask, fakeSession, sessionTokenOf, ORG_FILES, GATE, type Harness, type Cred } from "./helpers.ts";
import { registerActionType, type ActionType } from "../src/actions/index.ts";
import { httpError } from "../src/errors.ts";
import { SoftAuthenticator } from "../src/fakes/soft-authenticator.ts";
import { budgetCapUsd } from "../src/spend.ts";

// ---- a fake SMTP server (the company mailbox) and a fake payment type --------------------------------

const mails: { from: string; to: string[]; data: string }[] = [];
let smtp: SMTPServer;
let smtpPort = 0;
const SMTP_PASS = "smtp-secret-password-do-not-leak";

const paid: { vendor: string; amount: number }[] = [];
const fakePay: ActionType = {
  type: "test.pay",
  tier: 2,
  params: { vendor: { type: "string", required: true, description: "vendor" }, amount: { type: "number", required: true, description: "GBP" } },
  validate(p) {
    if (typeof p.vendor !== "string" || !p.vendor) throw httpError("bad_request", "vendor is required");
    if (typeof p.amount !== "number" || !(p.amount > 0)) throw httpError("bad_request", "amount must be positive");
    return { vendor: p.vendor, amount: p.amount };
  },
  amount: (p) => p.amount as number,
  subjects: (p) => [String(p.vendor)],
  preview: (p) => ({ summary: `Pay GBP ${(p.amount as number).toFixed(2)} to ${p.vendor}`, fields: [{ label: "Vendor", value: String(p.vendor) }], body: null }),
  async run({ params }) {
    paid.push({ vendor: String(params.vendor), amount: params.amount as number });
    return { paid: true };
  },
};

before(async () => {
  registerActionType(fakePay);
  smtp = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth(auth, _s, cb) {
      if (auth.username === "support@example.org" && auth.password === SMTP_PASS) cb(null, { user: auth.username });
      else cb(new Error("bad login"));
    },
    onData(stream, session, cb) {
      let data = "";
      stream.on("data", (c) => (data += c));
      stream.on("end", () => {
        mails.push({ from: String(session.envelope.mailFrom && session.envelope.mailFrom.address), to: session.envelope.rcptTo.map((r) => r.address), data });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});
after(() => new Promise<void>((r) => smtp.close(() => r())));

const GUARDS = JSON.stringify([
  { id: "own-mail", tool: "bash", match: "gmail-send", approval: "self", label: "Send an email from your own mailbox" },
  { id: "public-post", tool: "*", match: "api\\.social\\.example", approval: "admin", label: "Post publicly" },
]);

async function setup(): Promise<{ h: Harness; u: Awaited<ReturnType<typeof seedUsers>> }> {
  const smtpSettings = { host: "127.0.0.1", port: smtpPort, security: "none", from: "support@example.org" };
  const h = await harness({
    orgFiles: { ...ORG_FILES, "policy/guards.json": GUARDS },
    config: {
      owner: "admin@example.org",
      actions: {
        company_email: {
          type: "smtp.send",
          label: "Email from the support mailbox",
          roles: ["*"],
          approval: "admin",
          auto: { allowList: ["*@example.org"] },
          settings: smtpSettings,
          credentials: { user: "SMTP_USER", password: "SMTP_PASS" },
        },
        desk_email: {
          type: "smtp.send",
          label: "Email from your desk address",
          roles: ["staff"],
          approval: "self",
          settings: smtpSettings,
          credentials: { user: "SMTP_USER", password: "SMTP_PASS" },
        },
        pay_invoice: { type: "test.pay", label: "Pay an invoice", roles: ["admin"], approval: "admin", auto: { below: 100, allowList: ["acme"] } },
        set_budget: { type: "instance.set_budget", label: "Change the instance budget", roles: ["admin"] },
      },
    },
    actionSecrets: {
      company_email: { user: "support@example.org", password: SMTP_PASS },
      desk_email: { user: "support@example.org", password: SMTP_PASS },
      pay_invoice: {},
      set_budget: {},
    },
  });
  return { h, u: await seedUsers(h) };
}

const session = (h: Harness, taskId: string): Promise<Cred> => asService(h, GATE, sessionTokenOf(h, taskId));

async function waitState(h: Harness, sess: Cred, id: string, states: string[]) {
  for (let i = 0; i < 200; i++) {
    const r = await call(h, sess, "GET", `/api/session/approvals/${id}`);
    if (states.includes(r.body.state)) return r.body;
    await new Promise((res) => setTimeout(res, 5));
  }
  throw new Error(`approval ${id} never reached ${states}`);
}

test("the catalogue: what a role has, what it may ask for, Tier 3 hidden from staff", async () => {
  const { h, u } = await setup();
  try {
    const t = await createTask(h, u.alice);
    await fakeSession(h, t);
    const r = await call(h, await session(h, t), "GET", "/api/session/actions");
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.actions.map((a: { name: string }) => [a.name, a]));
    assert.deepEqual(Object.keys(by).sort(), ["company_email", "desk_email", "pay_invoice"], "set_budget (Tier 3) is not listed to staff");
    assert.equal(by.company_email.available, true);
    assert.equal(by.desk_email.approval, "self");
    assert.equal(by.pay_invoice.available, false);
    assert.ok(!JSON.stringify(r.body).includes(SMTP_PASS));
    const ta = await createTask(h, u.admin);
    await fakeSession(h, ta);
    const ra = await call(h, await session(h, ta), "GET", "/api/session/actions");
    const sb = ra.body.actions.find((a: { name: string }) => a.name === "set_budget");
    assert.equal(sb.tier, 3);
    assert.equal(sb.approval, "owner");
  } finally {
    await h.close();
  }
});

test("policy auto rule: mail inside the company goes out at once, through the server's credentials", async () => {
  const { h, u } = await setup();
  try {
    const t = await createTask(h, u.alice);
    await fakeSession(h, t);
    const sess = await session(h, t);
    const r = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "company_email", params: { to: ["bob@example.org"], subject: "Hi", text: "Inside" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.approver, "auto");
    const done = await waitState(h, sess, r.body.id, ["done", "failed"]);
    assert.equal(done.state, "done", done.error);
    assert.deepEqual(done.result.accepted, ["bob@example.org"]);
    const m = mails.find((x) => x.to.includes("bob@example.org"));
    assert.ok(m && m.data.includes("Inside"));
    assert.ok(!JSON.stringify(done).includes(SMTP_PASS), "the credential never reaches the session");
    // bad params: a clear 400 the agent can act on
    const bad = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "company_email", params: { to: ["not-an-address"], subject: "x", text: "y" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /not an email address/);
    const unknown = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "nope", params: {} });
    assert.equal(unknown.status, 400);
  } finally {
    await h.close();
  }
});

test("self-confirm: only the task's owner taps it; the session's long poll gets the result", async () => {
  const { h, u } = await setup();
  try {
    const t = await createTask(h, u.alice);
    await fakeSession(h, t);
    const sess = await session(h, t);
    const r = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "desk_email", params: { to: "client@example.net", subject: "Quote", text: "Dear client,\nhere is the quote." }, reason: "the user asked" });
    assert.equal(r.status, 201);
    assert.equal(r.body.state, "pending");
    assert.equal(r.body.approver, "self");
    assert.equal(r.body.preview.summary, "Send an email to client@example.net from support@example.org");
    assert.equal(r.body.preview.body, "Dear client,\nhere is the quote.");
    const id = r.body.id;
    const alice = await asEmail(h, u.alice);
    const me = await call(h, alice, "GET", "/api/me");
    assert.equal(me.body.pendingApprovals, 1);
    const notices = await call(h, alice, "GET", "/api/notices");
    assert.ok(notices.body.notices.some((n: { kind: string }) => n.kind === "approval_needed"));
    // the admin sees it but can't decide it; bob can't see it at all
    const admin = await asEmail(h, u.admin);
    const av = await call(h, admin, "GET", `/api/approvals/${id}`);
    assert.equal(av.body.canDecide, false);
    assert.equal((await call(h, admin, "POST", `/api/approvals/${id}/decide`, { decision: "approve" })).status, 403);
    const bob = await asEmail(h, u.bob);
    assert.equal((await call(h, bob, "GET", `/api/approvals/${id}`)).status, 404);
    assert.equal((await call(h, bob, "POST", `/api/approvals/${id}/decide`, { decision: "approve" })).status, 404);
    assert.equal((await call(h, bob, "GET", "/api/approvals")).body.approvals.length, 0);
    // the session waits; alice taps
    const waiting = call(h, sess, "GET", `/api/session/approvals/${id}?wait=10`);
    await new Promise((res) => setTimeout(res, 20));
    const d = await call(h, alice, "POST", `/api/approvals/${id}/decide`, { decision: "approve" });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const w = await waiting;
    assert.equal(w.body.state, "done", w.body.error);
    assert.ok(mails.some((m) => m.to.includes("client@example.net")));
    assert.equal((await call(h, alice, "POST", `/api/approvals/${id}/decide`, { decision: "approve" })).status, 409, "decided once");
  } finally {
    await h.close();
  }
});

test("admin approval and denial; a role without the action asks for access", async () => {
  const { h, u } = await setup();
  try {
    const t = await createTask(h, u.alice);
    await fakeSession(h, t);
    const sess = await session(h, t);
    const alice = await asEmail(h, u.alice);
    const admin = await asEmail(h, u.admin);
    // outside the company: an admin approves
    const r = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "company_email", params: { to: ["x@example.net"], subject: "S", text: "T" } });
    assert.equal(r.body.approver, "admin");
    assert.equal((await call(h, alice, "POST", `/api/approvals/${r.body.id}/decide`, { decision: "approve" })).status, 403, "staff can't approve their own admin-level request");
    const q = await call(h, admin, "GET", "/api/approvals?pending=1");
    assert.deepEqual(q.body.approvals.map((a: { id: string }) => a.id), [r.body.id]);
    assert.equal((await call(h, admin, "POST", `/api/approvals/${r.body.id}/decide`, { decision: "approve" })).status, 200);
    assert.equal((await waitState(h, sess, r.body.id, ["done", "failed"])).state, "done");
    // denial: the note reaches the session and alice gets a notice
    const r2 = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "company_email", params: { to: ["y@example.net"], subject: "S", text: "T" } });
    const den = await call(h, admin, "POST", `/api/approvals/${r2.body.id}/decide`, { decision: "deny", note: "not to this customer" });
    assert.equal(den.status, 200);
    const s2 = await call(h, sess, "GET", `/api/session/approvals/${r2.body.id}?wait=1`);
    assert.equal(s2.body.state, "denied");
    assert.equal(s2.body.decision.note, "not to this customer");
    assert.ok(!mails.some((m) => m.to.includes("y@example.net")));
    const n = await call(h, alice, "GET", "/api/notices");
    assert.ok(n.body.notices.some((x: { kind: string; text: string }) => x.kind === "approval_decided" && /Denied/.test(x.text)));
    // pay_invoice is admin-only: capability_missing, then an access request granted for this task
    const no = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "pay_invoice", params: { vendor: "acme", amount: 10 } });
    assert.equal(no.status, 403);
    assert.equal(no.body.error.code, "capability_missing");
    assert.equal((await call(h, sess, "POST", "/api/session/approvals", { kind: "access", action: "pay_invoice" })).status, 400, "a reason is required");
    const acc = await call(h, sess, "POST", "/api/session/approvals", { kind: "access", action: "pay_invoice", reason: "pay the Acme invoice" });
    assert.equal(acc.status, 201);
    assert.equal((await call(h, admin, "POST", `/api/approvals/${acc.body.id}/decide`, { decision: "approve" })).status, 400, "needs a scope");
    assert.equal((await call(h, admin, "POST", `/api/approvals/${acc.body.id}/decide`, { decision: "approve", grantScope: "task" })).status, 200);
    // now the policy applies: allow-listed vendor under the threshold goes at once, a big one needs an admin
    const small = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "pay_invoice", params: { vendor: "acme", amount: 50 } });
    assert.equal(small.body.approver, "auto");
    const big = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "pay_invoice", params: { vendor: "newco", amount: 5000 } });
    assert.equal(big.body.approver, "admin");
    assert.equal(big.body.state, "pending");
    await waitState(h, sess, small.body.id, ["done"]);
    assert.deepEqual(paid, [{ vendor: "acme", amount: 50 }]);
    // the task grant covers only this task; a role grant covers bob too
    const tb = await createTask(h, u.bob);
    await fakeSession(h, tb);
    const sb = await session(h, tb);
    assert.equal((await call(h, sb, "POST", "/api/session/approvals", { kind: "action", action: "pay_invoice", params: { vendor: "acme", amount: 5 } })).status, 403);
    const acc2 = await call(h, sb, "POST", "/api/session/approvals", { kind: "access", action: "pay_invoice", reason: "same" });
    await call(h, admin, "POST", `/api/approvals/${acc2.body.id}/decide`, { decision: "approve", grantScope: "role" });
    assert.equal((await call(h, sb, "POST", "/api/session/approvals", { kind: "action", action: "pay_invoice", params: { vendor: "acme", amount: 5 } })).status, 201);
  } finally {
    await h.close();
  }
});

test("ask the boss and guards; pending requests are cancelled when the task stops", async () => {
  const { h, u } = await setup();
  try {
    const t = await createTask(h, u.alice);
    await fakeSession(h, t);
    const sess = await session(h, t);
    const admin = await asEmail(h, u.admin);
    const qq = await call(h, sess, "POST", "/api/session/approvals", { kind: "question", question: "Offer the client 10% or 15%?", options: ["10%", "15%"] });
    assert.equal(qq.status, 201);
    assert.deepEqual(qq.body.options, ["10%", "15%"]);
    assert.equal((await call(h, admin, "POST", `/api/approvals/${qq.body.id}/decide`, { decision: "approve" })).status, 400, "an answer is required");
    await call(h, admin, "POST", `/api/approvals/${qq.body.id}/decide`, { decision: "approve", note: "10%" });
    const qa = await call(h, sess, "GET", `/api/session/approvals/${qq.body.id}`);
    assert.equal(qa.body.state, "approved");
    assert.equal(qa.body.decision.note, "10%");
    // guards: the bundle carries the rules; the rule (not the session) decides who approves
    const bundle = await call(h, sess, "GET", "/api/session/bundle");
    assert.deepEqual(bundle.body.guards.map((g: { id: string }) => g.id), ["own-mail", "public-post"]);
    const g = await call(h, sess, "POST", "/api/session/approvals", { kind: "guard", rule: "public-post", tool: "bash", input: "curl -X POST https://api.social.example/post", approver: "self" });
    assert.equal(g.body.approver, "admin");
    assert.equal(g.body.preview.body, "curl -X POST https://api.social.example/post");
    assert.equal((await call(h, sess, "POST", "/api/session/approvals", { kind: "guard", rule: "made-up", tool: "bash", input: "x" })).status, 400);
    // the task stops: the pending guard is cancelled
    const alice = await asEmail(h, u.alice);
    await call(h, alice, "POST", `/api/tasks/${t}/pause`);
    await h.jarvis.settle();
    const cancelled = await call(h, admin, "GET", `/api/approvals/${g.body.id}`);
    assert.equal(cancelled.body.state, "cancelled");
    assert.equal((await call(h, admin, "GET", "/api/approvals?pending=1")).body.approvals.length, 0);
  } finally {
    await h.close();
  }
});

test("Tier 3: only the owner, only with a user-verified passkey over exactly the change", async () => {
  const { h, u } = await setup();
  try {
    const ownerCred = await asEmail(h, u.admin);
    const alice = await asEmail(h, u.alice);
    // staff can't even ask
    const ts = await createTask(h, u.alice);
    await fakeSession(h, ts);
    const no = await call(h, await session(h, ts), "POST", "/api/session/approvals", { kind: "action", action: "set_budget", params: { monthlyUsd: 500 } });
    assert.equal(no.body.error.code, "capability_missing");
    assert.equal((await call(h, await session(h, ts), "POST", "/api/session/approvals", { kind: "access", action: "set_budget", reason: "x" })).status, 400);
    // passkey routes are the owner's only
    assert.equal((await call(h, alice, "GET", "/api/passkeys")).status, 404);
    assert.equal((await call(h, alice, "POST", "/api/passkeys/register/options")).status, 404);
    assert.equal((await call(h, alice, "GET", "/api/pages/passkeys")).status, 404);
    // the owner registers a passkey (identity login); a paired device can't
    h.clock.advance(31_000);
    const pr = await call(h, ownerCred, "GET", "/api/devices/pair?state=abcdefghijklmnop1234&name=phone");
    const dev = await asService(h, new URL(pr.headers.get("location")!).searchParams.get("clientId")!);
    assert.equal((await call(h, dev, "POST", "/api/passkeys/register/options")).status, 403);
    const page = await call(h, ownerCred, "GET", "/api/pages/passkeys?return=https://evil.example/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.ok(!String(page.body).includes("evil.example"), "an off-site return is dropped");
    const auth = new SoftAuthenticator();
    const ro = await call(h, ownerCred, "POST", "/api/passkeys/register/options");
    assert.equal(ro.body.authenticatorSelection.userVerification, "required");
    const reg = await call(h, ownerCred, "POST", "/api/passkeys/register", { response: auth.create(ro.body), name: "iPhone" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    assert.equal((await call(h, ownerCred, "GET", "/api/me")).body.isOwner, true);
    assert.equal((await call(h, alice, "GET", "/api/me")).body.isOwner, false);
    // the admin's task asks for the change
    const ta = await createTask(h, u.admin);
    await fakeSession(h, ta);
    const sess = await session(h, ta);
    const r = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "set_budget", params: { monthlyUsd: 75 }, reason: "more sessions this month" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.approver, "owner");
    assert.match(r.body.changeHash, /^[0-9a-f]{64}$/);
    assert.equal(r.body.preview.summary, "Change the instance's monthly machine budget from USD 50.00 a month to USD 75.00 a month");
    const id = r.body.id;
    const view = await call(h, ownerCred, "GET", `/api/approvals/${id}`);
    assert.equal(view.body.decideWith, "passkey");
    assert.equal((await call(h, ownerCred, "POST", `/api/approvals/${id}/decide`, { decision: "approve" })).status, 400, "a tap can't approve Tier 3");
    const sign = await call(h, ownerCred, "GET", `/api/pages/approvals/${id}`);
    assert.ok(String(sign.body).includes(r.body.changeHash), "the page shows the fingerprint it signs");
    // a valid signature without user verification (no Face ID): refused
    let o = await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey/options`);
    assert.equal(o.body.changeHash, r.body.changeHash);
    assert.equal(o.body.options.userVerification, "required");
    auth.o.uv = false;
    assert.equal((await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey`, { response: auth.get(o.body.options) })).status, 400);
    auth.o.uv = true;
    // a signature made for another origin (a phishing page): refused
    o = await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey/options`);
    auth.o.origin = "https://jarvis.evil.example";
    assert.equal((await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey`, { response: auth.get(o.body.options) })).status, 400);
    delete auth.o.origin;
    // a signature for another change (another approval's challenge): refused
    const r2 = await call(h, sess, "POST", "/api/session/approvals", { kind: "action", action: "set_budget", params: { monthlyUsd: 1000 } });
    const o2 = await call(h, ownerCred, "POST", `/api/approvals/${r2.body.id}/passkey/options`);
    o = await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey/options`);
    assert.equal((await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey`, { response: auth.get(o2.body.options) })).status, 400);
    // another admin (not the owner) can't sign
    h.directory.set("ops@example.org", { name: "Ops", groups: ["jarvis-admin@example.org"] });
    await h.jarvis.syncDirectory();
    const ops = await asEmail(h, "ops@example.org");
    assert.equal((await call(h, ops, "POST", `/api/approvals/${id}/passkey/options`)).status, 404);
    assert.equal((await call(h, ops, "GET", `/api/approvals/${id}`)).body.canDecide, false);
    // the real thing
    o = await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey/options`);
    const good = auth.get(o.body.options);
    const ok = await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey`, { response: good });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.decision.passkey, true);
    const done = await waitState(h, sess, id, ["done", "failed"]);
    assert.equal(done.state, "done", done.error);
    assert.deepEqual(done.result, { before: 50, after: 75 });
    assert.equal(budgetCapUsd(h.jarvis.ctx), 75);
    // replaying the same assertion: refused (the challenge was consumed, and the request is decided)
    assert.notEqual((await call(h, ownerCred, "POST", `/api/approvals/${id}/passkey`, { response: good })).status, 200);
    // deny is still a tap
    assert.equal((await call(h, ownerCred, "POST", `/api/approvals/${r2.body.id}/decide`, { decision: "deny", note: "too much" })).status, 200);
    assert.equal(budgetCapUsd(h.jarvis.ctx), 75);
  } finally {
    await h.close();
  }
});
