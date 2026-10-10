// The locked-policy plugin against a stand-in jarvis-agent socket: guards stop matching tool calls
// until approved, a denial fails the call, and the jarvis_* tools file requests and wait.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchGuard, outcome, settled } from "../lib/policy.mjs";

const dir = mkdtempSync(join(tmpdir(), "jarvis-policy-"));
const sock = join(dir, "agent.sock");
process.env.JARVIS_AGENT_SOCKET = sock;

const GUARDS = [
  { id: "own-mail", tool: "bash", match: "gmail-send", approval: "self", label: "Send an email from your own mailbox" },
  { id: "public-post", tool: "*", match: "api\\.social\\.example", approval: "admin", label: "Post publicly" },
];

// the stand-in agent: requests are filed pending; the test decides them
const requests = [];
const decisions = new Map(); // id -> final view
let polls = 0;
let srv;
const view = (id, body, state = "pending", extra = {}) => ({
  id,
  kind: body.kind,
  approver: body.kind === "guard" ? GUARDS.find((g) => g.id === body.rule).approval : "admin",
  state,
  action: body.action ?? body.rule ?? null,
  preview: { summary: body.kind === "question" ? body.question : `do ${body.action ?? body.rule}`, fields: [], body: null },
  decision: null,
  result: null,
  error: null,
  ...extra,
});

before(async () => {
  srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const reply = (s, b) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/guards") return reply(200, { guards: GUARDS });
    if (url.pathname === "/actions") return reply(200, { actions: [{ name: "company_email", label: "Company mail", description: "", tier: 2, params: { to: { type: "string[]", required: true, description: "recipients" } }, available: true, approval: "admin" }] });
    if (req.method === "POST" && url.pathname === "/approvals") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.kind === "action" && body.action === "nope") return reply(400, { error: { code: "bad_request", message: "no action named nope" } });
      const id = `a${requests.length + 1}`;
      requests.push({ id, body });
      return reply(201, view(id, body));
    }
    const m = /^\/approvals\/(\w+)$/.exec(url.pathname);
    if (m) {
      polls++;
      const r = requests.find((x) => x.id === m[1]);
      if (!r) return reply(404, { error: { code: "not_found", message: "no such approval" } });
      // a short "long poll": answer pending until decided
      for (let i = 0; i < 20 && !decisions.has(r.id); i++) await new Promise((s) => setTimeout(s, 5));
      return reply(200, decisions.get(r.id) ?? view(r.id, r.body));
    }
    reply(404, { error: "no such route" });
  });
  await new Promise((r) => srv.listen(sock, r));
});
after(() => {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

const decideSoon = (pred, make) => {
  const t = setInterval(() => {
    const r = requests.find((x) => pred(x) && !decisions.has(x.id));
    if (r) {
      decisions.set(r.id, make(r));
      clearInterval(t);
    }
  }, 5);
};

test("matchGuard: bash commands by text, other tools by their JSON arguments, '*' for any tool", () => {
  assert.equal(matchGuard(GUARDS, "bash", { command: "ls -la" }), null);
  assert.equal(matchGuard(GUARDS, "bash", { command: "GMAIL-SEND --to x" }).rule.id, "own-mail");
  assert.equal(matchGuard(GUARDS, "webfetch", { url: "https://api.social.example/post" }).rule.id, "public-post");
  assert.equal(matchGuard(GUARDS, "webfetch", { url: "gmail-send" }), null, "a bash-only rule doesn't touch other tools");
  assert.equal(matchGuard([{ id: "x", tool: "*", match: "(", approval: "self", label: "bad" }], "bash", { command: "(" }), null, "a bad regex never crashes a call");
});

test("outcome texts tell the agent what happened and that a denial is final", () => {
  const base = { id: "a", kind: "action", approver: "admin", action: "pay", preview: { summary: "Pay 10", fields: [], body: null }, result: null, error: null };
  assert.equal(settled({ ...base, state: "approved" }), false, "an approved action is settled only once it ran");
  assert.equal(settled({ ...base, kind: "question", state: "approved" }), true);
  assert.match(outcome({ ...base, state: "done", result: { ok: 1 }, decision: { by: { name: "Admin" } } }), /^Done: Pay 10\. Approved by Admin\. Result: \{"ok":1\}/);
  assert.match(outcome({ ...base, state: "denied", decision: { by: { email: "a@example.org" }, note: "no" } }), /Denied by a@example.org: Pay 10\. Note: no\. Do not do this another way/);
  assert.match(outcome({ ...base, kind: "question", state: "approved", decision: { by: { name: "Admin" }, note: "10%" } }), /^Answer by Admin: 10%$/);
  assert.match(outcome({ ...base, kind: "access", state: "approved", decision: { by: null, grantScope: "role" } }), /for your role/);
});

test("the plugin: guards block until approved, denial fails the call, tools wait for decisions", async () => {
  const { JarvisPolicyPlugin } = await import("../lib/opencode-plugin.mjs");
  const mod = await import("../lib/opencode-plugin.mjs");
  assert.deepEqual(Object.keys(mod), ["JarvisPolicyPlugin"], "OpenCode loads every export as a plugin: export only the plugin");
  const hooks = await JarvisPolicyPlugin({});
  const before = hooks["tool.execute.before"];

  // an unguarded call passes without a request
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "echo hi" } });
  assert.equal(requests.length, 0);

  // a guarded call waits, then runs once approved
  decideSoon((r) => r.body.rule === "own-mail", (r) => view(r.id, r.body, "approved", { decision: { by: { name: "Alice" }, note: null } }));
  await before({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "gmail-send --to client@example.net" } });
  const g = requests.find((r) => r.body.rule === "own-mail");
  assert.deepEqual(g.body, { kind: "guard", rule: "own-mail", tool: "bash", input: "gmail-send --to client@example.net" });

  // a denied one throws, with the reason, so the tool never runs
  decideSoon((r) => r.body.rule === "public-post", (r) => view(r.id, r.body, "denied", { decision: { by: { name: "Admin" }, note: "not on brand" } }));
  await assert.rejects(before({ tool: "webfetch", sessionID: "s", callID: "c" }, { args: { url: "https://api.social.example/p" } }), /locked policy \(Post publicly\).*Denied by Admin.*not on brand/);

  // the jarvis_* tools are never guarded themselves
  await before({ tool: "jarvis_action", sessionID: "s", callID: "c" }, { args: { action: "gmail-send" } });

  const titles = [];
  const ctx = { metadata: (m) => titles.push(m.title), abort: new AbortController().signal };
  // jarvis_actions lists the catalogue
  assert.match(await hooks.tool.jarvis_actions.execute({}, ctx), /company_email: Company mail \[approval: admin\]\n {4}to \(string\[\]\): recipients/);
  // jarvis_action: waits through several polls, returns the result
  decideSoon((r) => r.body.action === "company_email", (r) => view(r.id, r.body, "done", { result: { messageId: "<m1>" }, decision: { by: { name: "Admin" }, note: null } }));
  const p0 = polls;
  const out = await hooks.tool.jarvis_action.execute({ action: "company_email", params: { to: ["x@example.net"] }, reason: "user asked" }, ctx);
  assert.match(out, /^Done: do company_email\. Approved by Admin\. Result: \{"messageId":"<m1>"\}/);
  assert.ok(polls > p0);
  assert.match(titles[0], /^Waiting for an admin to decide/);
  // a refused request fails the tool call with the server's message
  await assert.rejects(hooks.tool.jarvis_action.execute({ action: "nope", params: {} }, ctx), /no action named nope/);
  // ask the boss
  decideSoon((r) => r.body.kind === "question", (r) => view(r.id, r.body, "approved", { decision: { by: { name: "Admin" }, note: "15%" } }));
  assert.equal(await hooks.tool.jarvis_ask_boss.execute({ question: "10% or 15%?", options: ["10%", "15%"] }, ctx), "Answer by Admin: 15%");
  assert.deepEqual(requests.at(-1).body, { kind: "question", question: "10% or 15%?", options: ["10%", "15%"] });
  // access
  decideSoon((r) => r.body.kind === "access", (r) => view(r.id, r.body, "approved", { decision: { by: { name: "Admin" }, grantScope: "task", note: null } }));
  assert.match(await hooks.tool.jarvis_request_access.execute({ action: "pay_invoice", reason: "invoice" }, ctx), /Access granted by Admin \(for this task\)/);
  // a cancelled wait (the user stops the agent) stops polling
  const ac = new AbortController();
  const waiting = hooks.tool.jarvis_ask_boss.execute({ question: "never answered" }, { metadata() {}, abort: ac.signal });
  setTimeout(() => ac.abort(new Error("stopped by the user")), 30);
  await assert.rejects(waiting, /stopped by the user|abort/);
});
