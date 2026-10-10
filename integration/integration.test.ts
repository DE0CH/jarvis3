// PLAN section 5 "Integration": the whole chain without a browser, against the real session image.
//
//   New task -> machine boots -> layers in the right order -> daemon dials in -> chat over the
//   proxied WebSocket (Paseo's own client SDK) -> "remember" lands in the personal layer ->
//   pause (snapshot in MinIO, machine gone) -> resume (same conversation) -> destroy (archive in
//   MinIO). Another user gets 404 on the task and on the daemon socket. The task carries its main
//   agent's id, and the HTTP relay reaches the daemon.
//
// The user's files reach the machine (~/files), the first prompt's attachments are in the workspace
// and named in the first message (an image also inline), jarvis-files saves a file back, and the
// conversation is searchable (from the app and with jarvis-search), by its owner only, also once
// the task is archived.
//
// Then actions and approvals (DESIGN "Actions and approvals") through the real OpenCode policy
// plugin: self-confirm, admin approval, denial (of an action and of a guarded tool call), and a
// Tier 3 change signed by the owner with a software passkey.
//
// Then the Tier 0 tools (docs/TOOLS.md) through the real image against stand-in providers: the
// agent's web_search / web_fetch tools and the jarvis-web command (metered by the server with the
// organisation's keys, which never reach the machine), the local proxy relayed through the server,
// the hard monthly cap, and who sees whose usage.
//
// Then scheduled tasks, wakeups and channels (docs/API.md section 15): a schedule's "Run now"
// starts a task with the schedule's prompt; the agent posts to the task's channel (plugin tool); a
// wakeup reaches the running task as a new message; a wakeup armed from the shell resumes the
// paused task and its prompt arrives in the restored conversation; destroy cancels wakeups.
//
// Needs Docker and the session image: SESSION_IMAGE (default jarvis3-session:test), built from
// session-image/. Run: npm test (in integration/).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { SMTPServer } from "smtp-server";
import type { AddressInfo } from "node:net";
import { startStack, MODEL, type Stack } from "./stack.ts";
import { SoftAuthenticator } from "../server/src/fakes/soft-authenticator.ts";
import { StubProviders } from "./stub-providers.ts";

const IMAGE = process.env.SESSION_IMAGE || "jarvis3-session:test";
const BOOT_MS = Number(process.env.BOOT_TIMEOUT_MS || 240_000);
const TURN_MS = Number(process.env.TURN_TIMEOUT_MS || 240_000);

let s: Stack;
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

// the company mailbox the broker's smtp.send actions use (the server talks to it, never a machine)
const SMTP_PASS = "itest-smtp-" + Math.random().toString(36).slice(2);
const mails: { to: string[]; data: string }[] = [];
const smtp = new SMTPServer({
  authOptional: false,
  allowInsecureAuth: true,
  disabledCommands: ["STARTTLS"],
  logger: false,
  onAuth: (a, _s, cb) => (a.username === "support@example.org" && a.password === SMTP_PASS ? cb(null, { user: a.username }) : cb(new Error("bad login"))),
  onData(stream, session, cb) {
    let data = "";
    stream.on("data", (c) => (data += c));
    stream.on("end", () => {
      mails.push({ to: session.envelope.rcptTo.map((r) => r.address), data });
      cb();
    });
  },
});

const stubs = new StubProviders();

before(async () => {
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", () => r()));
  await stubs.start();
  const smtpSettings = { host: "127.0.0.1", port: (smtp.server.address() as AddressInfo).port, security: "none", from: "support@example.org" };
  const creds = { user: "ITEST_SMTP_USER", password: "ITEST_SMTP_PASS" };
  s = await startStack({
    image: IMAGE,
    log,
    config: {
      owner: "admin@example.org",
      actions: {
        desk_email: { type: "smtp.send", label: "Email from your desk address", roles: ["staff"], approval: "self", settings: smtpSettings, credentials: creds },
        company_email: { type: "smtp.send", label: "Email from the support mailbox", roles: ["*"], approval: "admin", auto: { allowList: ["*@example.org"] }, settings: smtpSettings, credentials: creds },
        set_budget: { type: "instance.set_budget", label: "Change the instance budget", roles: ["admin"] },
      },
      roles: {
        admin: { openrouterMonthlyUsd: 5, machineHoursPerMonth: null, admin: true, toolsMonthlyUsd: 1, proxyMonthlyGb: 1 },
        // 0.02: two searches (0.007 each) and a rendered fetch fit, a third search does not
        staff: { openrouterMonthlyUsd: 1, machineHoursPerMonth: 10, toolsMonthlyUsd: 0.02, proxyMonthlyGb: 1 },
      },
      tools: {
        search: { provider: "exa", credential: "ITEST_EXA_KEY", baseUrl: `http://127.0.0.1:${stubs.apiPort}` },
        fetch: { provider: "scrapingbee", credential: "ITEST_SB_KEY", baseUrl: `http://127.0.0.1:${stubs.apiPort}` },
        proxy: { provider: "http", credential: "ITEST_PROXY_LOGIN", settings: { host: "127.0.0.1", port: stubs.proxyPort, targeting: { field: "password", country: "_country-{c}" } }, pricing: { perGbUsd: 1 } },
      },
    },
    toolSecrets: { search: stubs.searchKey, fetch: stubs.fetchKey, proxy: `${stubs.proxyLogin.username}:${stubs.proxyLogin.password}` },
    actionSecrets: { desk_email: { user: "support@example.org", password: SMTP_PASS }, company_email: { user: "support@example.org", password: SMTP_PASS }, set_budget: {} },
  });
});
after(async () => {
  await s?.close();
  await stubs.close();
  await new Promise<void>((r) => smtp.close(() => r()));
});

async function call(email: string, method: string, path: string, body?: unknown) {
  const r = await fetch(s.base + path, {
    method,
    headers: { "cf-access-jwt-assertion": await s.jwt(email), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number, every = 1000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      if ((e as { fatal?: boolean }).fatal) throw e;
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    await new Promise((r) => setTimeout(r, every));
  }
}

async function put(email: string, path: string, data: Uint8Array, type: string) {
  const r = await fetch(s.base + path, { method: "PUT", headers: { "cf-access-jwt-assertion": await s.jwt(email), "content-type": type }, body: data });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
// a 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

const taskOf = (email: string, id: string) => call(email, "GET", `/api/tasks/${id}`).then((r) => r.body);

/** Paseo's own client SDK, connected through the server's daemon proxy as `email`. */
async function paseoAs(email: string, taskId: string): Promise<PaseoClient> {
  const jwt = await s.jwt(email);
  const client = createPaseoClient({
    url: `${s.wsBase}/api/tasks/${taskId}/daemon`,
    reconnect: { enabled: false },
    // the app never holds the daemon password: the server adds it on the way
    webSocketFactory: (url: string, o?: { headers?: Record<string, string>; protocols?: string[] }) =>
      new WebSocket(url, o?.protocols ?? [], { headers: { ...(o?.headers ?? {}), "cf-access-jwt-assertion": jwt } }),
  } as Parameters<typeof createPaseoClient>[0]);
  await client.connect();
  return client;
}

function wsStatus(email: string | null, path: string): Promise<number> {
  return (async () => {
    const headers: Record<string, string> = email ? { "cf-access-jwt-assertion": await s.jwt(email) } : {};
    return new Promise<number>((resolve) => {
      const ws = new WebSocket(s.wsBase + path, [], { headers });
      ws.once("open", () => {
        ws.close();
        resolve(101);
      });
      ws.once("unexpected-response", (_q, res) => {
        resolve(res.statusCode || 0);
        ws.terminate();
      });
      ws.once("error", () => resolve(-1));
    });
  })();
}

async function exec(machineId: string, script: string): Promise<string> {
  const r = await s.machines.exec(machineId, ["sh", "-c", script], 30);
  if (r.exitCode !== 0) throw new Error(`exec failed (${r.exitCode}): ${r.stderr}`);
  return r.stdout.trim();
}

async function machineOf(taskId: string): Promise<string> {
  const ms = (await s.machines.list()).filter((m) => m.metadata.jarvisTask === taskId && m.state === "started");
  assert.equal(ms.length, 1, `one machine for task ${taskId}`);
  return ms[0]!.id;
}

const s3exists = async (key: string) => (await s.s3.fetch(`${s.bucketUrl}/${key}`, { method: "HEAD" })).ok;

/** On a failure: what the model was asked, and the session machines' own logs. */
function diagnose(): void {
  for (const c of s.openrouter.chats) log(`[model] ${JSON.stringify({ key: c.key.slice(-6), tools: c.tools.length, lastRole: c.lastRole, lastUser: c.lastUser.slice(-120), reply: c.reply })}`);
  try {
    const ids = execFileSync("docker", ["ps", "-aq", "--filter", `label=jarvis3.instance=itest`], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const id of ids) {
      const out = execFileSync("docker", ["logs", "--tail", "400", id], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const lines = out.split("\n").filter((l) => !/"level":(20|30)\b/.test(l)).slice(-80);
      log(`[machine ${id}]\n${lines.map((l) => l.slice(0, 400)).join("\n")}`);
    }
  } catch (e) {
    log(`(no machine logs: ${(e as Error).message})`);
  }
}

const ALICE = "alice@example.org";
const BOB = "bob@example.org";
const ADMIN = "admin@example.org";

test("a task end to end on the real session image", { timeout: 20 * 60_000 }, async (t) => {
  let taskId = "";
  let aliceUserId = "";
  let agentId = "";
  // the steps build on each other: after the first failure, skip the rest
  let broken = false;
  const step = (name: string, fn: () => Promise<void>) =>
    t.test(name, { skip: broken ? "an earlier step failed" : false }, async () => {
      try {
        await fn();
      } catch (e) {
        broken = true;
        diagnose();
        throw e;
      }
    });

  await step("alice's personal layer, then New task", async () => {
    const me = await call(ALICE, "GET", "/api/me");
    aliceUserId = me.body.user.id;
    assert.equal((await call(ALICE, "PUT", "/api/users/me/layer/instructions", { text: "PERSONAL-MARK: answer briefly." })).status, 200);
    assert.equal((await call(ALICE, "PUT", "/api/users/me/layer/skills/search", { files: { "SKILL.md": "---\nname: search\ndescription: My own search\n---\nPersonal search." } })).status, 200);
    assert.equal((await put(ALICE, "/api/users/me/files/notes/brief.md", Buffer.from("# BRIEF-MARK\n"), "text/markdown")).status, 201);
    assert.equal((await put(ALICE, "/api/users/me/files/attachments/itest-1/order.txt", Buffer.from("ORDER-MARK 42\n"), "text/plain")).status, 201);
    assert.equal((await put(ALICE, "/api/users/me/files/attachments/itest-1/photo.png", PNG, "image/png")).status, 201);
    assert.equal((await put(BOB, "/api/users/me/files/bob-only.txt", Buffer.from("BOB-MARK"), "text/plain")).status, 201);
    const r = await call(ALICE, "POST", "/api/tasks", {
      prompt: "Hello from alice FIRST-PROMPT",
      requestId: "itest-1",
      attachments: ["attachments/itest-1/order.txt", "attachments/itest-1/photo.png"],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    taskId = r.body.id;
    assert.equal(r.body.state, "starting");
    assert.equal(r.body.model, MODEL);
    assert.equal(s.openrouter.liveKeys().length, 1, "alice's OpenRouter key was minted");
  });

  await step("the machine boots and the daemon dials in", async () => {
    const task = await waitFor(
      "the task to be running and connected",
      async () => {
        const v = await taskOf(ALICE, taskId);
        if (v.state === "failed") throw Object.assign(new Error(`task failed: ${v.error}`), { fatal: true });
        return v.connected && (v.state === "running" || v.state === "idle") ? v : null;
      },
      BOOT_MS,
      2000,
    );
    log(`task ${taskId} is ${task.state}`);
  });

  await step("the layers are in the machine, in the right order, policy last", async () => {
    const m = await machineOf(taskId);
    const ins = await exec(m, "cat /home/jarvis/.jarvis/instructions.md");
    const marks = ["# Jarvis session", "ORG-MARK", "ROLE-MARK: staff", "PERSONAL-MARK", "POLICY-MARK"].map((k) => ins.indexOf(k));
    assert.ok(marks.every((i) => i >= 0), `all layers present:\n${ins}`);
    assert.deepEqual([...marks].sort((a, b) => a - b), marks, "org -> role -> personal -> policy");
    assert.ok(!ins.includes("admins run the instance"), "only alice's role");

    const skills = (await exec(m, "cd /home/jarvis/.jarvis/skills && ls -1")).split("\n").sort();
    assert.deepEqual(skills, ["jarvis-web", "personal-search", "report", "role-report", "search"]); // jarvis-web: the built-in web-tools skill
    assert.match(await exec(m, "head -3 /home/jarvis/.jarvis/skills/role-report/SKILL.md"), /name: role-report/);

    const cfg = JSON.parse(await exec(m, "cat /home/jarvis/.config/opencode/opencode.json"));
    assert.equal(cfg.model, `openrouter/${MODEL}`);
    assert.deepEqual(cfg.permission, { "*": "allow", bash: { "*": "allow", "rm -rf /*": "deny" } });
    assert.ok(!JSON.stringify(cfg).includes("sk-or-"), "no key in the config file");

    // the org-env tree is there, read-only for the agent's user
    assert.equal((await exec(m, "cat /home/jarvis/org/scripts/hello.sh")).includes("hello from the org"), true);
    assert.equal(await exec(m, "su jarvis -s /bin/sh -c 'touch /home/jarvis/org/x 2>/dev/null && echo writable || echo read-only'"), "read-only");
    // the session token and the gate secret are not in the daemon's (and so the agent's) env
    // (every process of the agent's user: the daemon, OpenCode, the shells it runs)
    // (read as `jarvis` itself, from a clean env: root in a container lacks CAP_SYS_PTRACE for another
    // uid's environ, and an exec inherits the container env, which has the token)
    const denv = await exec(m, "env -i /bin/su jarvis -s /bin/sh -c 'for p in $(pgrep -u jarvis); do tr \"\\\\000\" \"\\\\n\" < /proc/$p/environ 2>/dev/null; echo; done' | cut -d= -f1 | sort -u");
    assert.ok(denv.includes("OPENROUTER_API_KEY"), denv);
    assert.ok(!denv.includes("JARVIS_SESSION_TOKEN") && !denv.includes("CF_ACCESS_CLIENT_SECRET"), denv);
  });

  await step("the first prompt reached the model with alice's key and the layered system prompt", async () => {
    const chat = await waitFor("the first prompt at the model", async () => s.openrouter.chats.find((c) => c.lastUser.includes("FIRST-PROMPT") && c.tools.length), TURN_MS);
    assert.equal(chat.key, s.openrouter.liveKeys()[0], "alice's own capped key");
    assert.equal(chat.model, MODEL);
    const at = ["ORG-MARK", "ROLE-MARK", "PERSONAL-MARK", "POLICY-MARK"].map((k) => chat.system.indexOf(k));
    assert.ok(at.every((i) => i >= 0), "the layers are in the model's system prompt");
    assert.deepEqual([...at].sort((a, b) => a - b), at);
    assert.ok(chat.tools.includes("bash"));
  });

  await step("alice's files are in ~/files; the attachments are in the workspace and named in the first message", async () => {
    const m = await machineOf(taskId);
    assert.equal(await exec(m, "cat /home/jarvis/files/notes/brief.md"), "# BRIEF-MARK");
    assert.equal(await exec(m, "stat -c %U /home/jarvis/files/notes/brief.md"), "jarvis");
    assert.equal(await exec(m, "test -e /home/jarvis/files/bob-only.txt && echo leaked || echo absent"), "absent");
    assert.equal(await exec(m, "cat /home/jarvis/workspace/attachments/order.txt"), "ORDER-MARK 42");
    assert.equal(await exec(m, "stat -c %s /home/jarvis/workspace/attachments/photo.png"), String(PNG.length));
    const chat = s.openrouter.chats.find((c) => c.lastUser.includes("FIRST-PROMPT"))!;
    assert.match(chat.lastUser, /attached 2 files[\s\S]*\/home\/jarvis\/workspace\/attachments\/order\.txt[\s\S]*photo\.png/);
    log(`the first message carried ${chat.images} inline image part(s)`);
    assert.ok(chat.images >= 1, "the attached image reached the model inline");
  });

  await step("chat round-trips through the server's daemon proxy (Paseo client SDK)", async () => {
    const client = await paseoAs(ALICE, taskId);
    try {
      const list = await client.agents.list();
      const agents = list.entries.map((e: any) => e.agent ?? e);
      assert.equal(agents.length, 1, "the first prompt made the main agent");
      agentId = agents[0].id;
      const agent = client.agents.ref(agentId);
      await agent.waitForFinish(TURN_MS);
      const r = await agent.run("ping-ITEST-123", { timeoutMs: TURN_MS });
      assert.equal(r.status, "idle", JSON.stringify(r));
      assert.match(String(r.lastMessage), /ECHO: ping-ITEST-123/);
    } finally {
      await client.close();
    }
  });

  await step("the session reports the main agent's id in the task", async () => {
    await waitFor("agentId in TaskView", async () => (await taskOf(ALICE, taskId)).agentId === agentId, 30_000);
  });

  await step("the HTTP relay reaches the daemon with the server's bearer; another user gets 404", async () => {
    const relay = async (email: string) =>
      fetch(`${s.base}/api/tasks/${taskId}/daemon/http/api/status`, { headers: { "cf-access-jwt-assertion": await s.jwt(email) } });
    const r = await relay(ALICE);
    assert.equal(r.status, 200, "the daemon's /api/status needs its password, which only the server adds");
    assert.equal(((await r.json()) as { status: string }).status, "server_info");
    assert.equal(r.headers.get("content-disposition"), "attachment");
    assert.equal((await relay(BOB)).status, 404);
  });

  await step("'remember' runs jarvis-remember and lands in alice's personal layer", async () => {
    const client = await paseoAs(ALICE, taskId);
    try {
      const r = await client.agents.ref(agentId).run("Please remember: My manager is Dana", { timeoutMs: TURN_MS });
      assert.equal(r.status, "idle", JSON.stringify(r));
      assert.match(String(r.lastMessage), /TOOL RESULT: Saved for future tasks: My manager is Dana/);
    } finally {
      await client.close();
    }
    const layer = (await call(ALICE, "GET", "/api/users/me/layer")).body;
    const note = layer.notes.find((n: { text: string }) => n.text === "My manager is Dana");
    assert.ok(note, JSON.stringify(layer.notes));
    assert.equal(note.source, "session");
    assert.equal(note.taskId, taskId);
  });

  await step("jarvis-files saves a file into alice's files; jarvis-files list sees hers only", async () => {
    const client = await paseoAs(ALICE, taskId);
    try {
      const agent = client.agents.ref(agentId);
      const r = await agent.run("run: printf 'REPORT-MARK\\n' > /tmp/report.txt && jarvis-files save /tmp/report.txt reports/weekly.txt", { timeoutMs: TURN_MS });
      assert.match(String(r.lastMessage), /TOOL RESULT: Saved to the user's files as "reports\/weekly\.txt"/, JSON.stringify(r));
      const l = await agent.run("run: jarvis-files list | grep -c bob-only; jarvis-files list | head -1", { timeoutMs: TURN_MS });
      assert.match(String(l.lastMessage), /TOOL RESULT: 0/, "bob's file is not listed");
    } finally {
      await client.close();
    }
    const files = (await call(ALICE, "GET", "/api/users/me/files")).body.files;
    const saved = files.find((f: { path: string }) => f.path === "reports/weekly.txt");
    assert.ok(saved, JSON.stringify(files));
    assert.equal(saved.source, "session");
    assert.equal(saved.taskId, taskId);
    const dl = await fetch(s.base + "/api/users/me/files/reports/weekly.txt?link=1", { headers: { "cf-access-jwt-assertion": await s.jwt(ALICE) } });
    assert.equal(await (await fetch(((await dl.json()) as { url: string }).url)).text(), "REPORT-MARK\n");
    assert.equal((await call(BOB, "GET", `/api/users/${aliceUserId}/files`)).status, 404);
  });

  await step("the conversation is searchable by alice (app and jarvis-search), not by bob", async () => {
    const hits = await waitFor(
      "the chat in the search index",
      async () => {
        const r = await call(ALICE, "GET", "/api/search?q=ping-ITEST-123");
        return r.body.hits.length ? r.body.hits : null;
      },
      90_000,
      2000,
    );
    assert.ok(hits.every((h: { taskId: string }) => h.taskId === taskId));
    assert.ok(hits.some((h: { role: string }) => h.role === "user") && hits.some((h: { role: string }) => h.role === "assistant"), JSON.stringify(hits));
    assert.equal((await call(BOB, "GET", "/api/search?q=ping-ITEST-123")).body.hits.length, 0);
    assert.equal((await call(BOB, "GET", `/api/tasks/${taskId}/transcript`)).status, 404);
    assert.ok((await call(ADMIN, "GET", "/api/search?q=ping-ITEST-123&all=1")).body.hits.length > 0);
    const page = (await call(ALICE, "GET", `/api/tasks/${taskId}/transcript?around=${hits[0].seq}&limit=10`)).body;
    assert.ok(page.entries.some((e: { text: string }) => e.text.includes("ping-ITEST-123")));
    // the tool call that saved the report is indexed too
    await waitFor("the tool call in the index", async () => (await call(ALICE, "GET", "/api/search?q=jarvis-files save")).body.hits.some((h: { role: string }) => h.role === "tool"), 90_000, 2000);
    const client = await paseoAs(ALICE, taskId);
    try {
      const r = await client.agents.ref(agentId).run("run: jarvis-search ping-ITEST-123 -n 1 | head -1", { timeoutMs: TURN_MS });
      assert.match(String(r.lastMessage), /TOOL RESULT: .*\(task [0-9a-f]+, (running|idle)\)/, JSON.stringify(r));
    } finally {
      await client.close();
    }
  });

  await step("another user gets 404 on the task and on the daemon socket; the admin sees it", async () => {
    assert.equal((await call(BOB, "GET", `/api/tasks/${taskId}`)).status, 404);
    assert.equal((await call(BOB, "POST", `/api/tasks/${taskId}/pause`)).status, 404);
    assert.equal(await wsStatus(BOB, `/api/tasks/${taskId}/daemon`), 404);
    assert.equal(await wsStatus(null, `/api/tasks/${taskId}/daemon`), 401);
    assert.ok(!(await call(BOB, "GET", "/api/tasks")).body.tasks.some((x: { id: string }) => x.id === taskId));
    assert.equal((await call(ADMIN, "GET", `/api/tasks/${taskId}`)).status, 200);
    assert.equal((await call(BOB, "GET", `/api/users/${aliceUserId}/layer`)).status, 404);
  });

  await step("the task reports idle when the agent is done", async () => {
    await waitFor("idle", async () => (await taskOf(ALICE, taskId)).state === "idle", 30_000);
  });

  await step("pause: snapshot in the bucket, machine gone", async () => {
    const r = await call(ALICE, "POST", `/api/tasks/${taskId}/pause`);
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const v = await waitFor("paused", async () => {
      const x = await taskOf(ALICE, taskId);
      if (x.state !== "pausing" && x.state !== "paused") throw Object.assign(new Error(`pause failed: ${x.state} ${x.error}`), { fatal: true });
      return x.state === "paused" && !x.busy ? x : null;
    }, 5 * 60_000);
    assert.equal(v.pausedReason, "user");
    assert.equal(v.error, null);
    assert.ok(await s3exists(`snapshots/${taskId}/state.tar.gz`));
    assert.equal((await s.machines.list()).filter((m) => m.metadata.jarvisTask === taskId).length, 0);
    assert.equal(await wsStatus(ALICE, `/api/tasks/${taskId}/daemon`), 503);
  });

  await step("resume: a new machine, the same conversation", async () => {
    assert.equal((await call(ALICE, "POST", `/api/tasks/${taskId}/resume`)).status, 202);
    await waitFor("running again", async () => {
      const x = await taskOf(ALICE, taskId);
      if (x.state === "paused" && !x.busy) throw Object.assign(new Error(`resume failed: ${x.error}`), { fatal: true });
      return x.connected && (x.state === "running" || x.state === "idle") ? x : null;
    }, BOOT_MS, 2000);
    const m = await machineOf(taskId);
    // the remembered note is part of the layers the resumed machine loaded
    assert.match(await exec(m, "cat /home/jarvis/.jarvis/instructions.md"), /- My manager is Dana/);

    const client = await paseoAs(ALICE, taskId);
    try {
      const agents = (await client.agents.list()).entries.map((e: any) => e.agent ?? e);
      assert.deepEqual(agents.map((a: { id: string }) => a.id), [agentId], "the same agent came back");
      const before = s.openrouter.chats.length;
      const r = await client.agents.ref(agentId).run("after-RESUME", { timeoutMs: TURN_MS });
      assert.equal(r.status, "idle", JSON.stringify(r));
      assert.match(String(r.lastMessage), /ECHO: after-RESUME/);
      const chat = s.openrouter.chats.slice(before).find((c) => c.lastUser.includes("after-RESUME"));
      assert.ok(chat, "the model saw the new message");
      assert.ok(chat.transcript.includes("ping-ITEST-123") && chat.transcript.includes("FIRST-PROMPT"), "the model got the earlier conversation too");
    } finally {
      await client.close();
    }
  });

  await step("destroy: archive in the bucket, machine gone, task archived", async () => {
    assert.equal((await call(ALICE, "DELETE", `/api/tasks/${taskId}`)).status, 202);
    const v = await waitFor("archived", async () => {
      const x = await taskOf(ALICE, taskId);
      if (!["destroying", "archived"].includes(x.state)) throw Object.assign(new Error(`destroy failed: ${x.state} ${x.error}`), { fatal: true });
      return x.state === "archived" && !x.busy ? x : null;
    }, 5 * 60_000);
    assert.equal(v.error, null);
    assert.ok(await s3exists(`archives/${aliceUserId}/${taskId}/state.tar.gz`));
    const meta = (await (await s.s3.fetch(`${s.bucketUrl}/archives/${aliceUserId}/${taskId}/task.json`)).json()) as { id: string };
    assert.equal(meta.id, taskId);
    assert.equal(await s3exists(`snapshots/${taskId}/state.tar.gz`), false);
    assert.equal((await s.machines.list()).length, 0);
  });

  await step("the archived task is still searchable and readable", async () => {
    const hits = (await call(ALICE, "GET", "/api/search?q=after-RESUME")).body.hits;
    assert.ok(hits.length > 0, "the conversation after the resume was indexed before the machine went");
    assert.ok(hits.every((h: { taskState: string }) => h.taskState === "archived"));
    assert.ok((await call(ALICE, "GET", `/api/tasks/${taskId}/transcript`)).body.entries.length > 0);
  });
});

test("actions and approvals through the real policy plugin", { timeout: 20 * 60_000 }, async (t) => {
  let broken = false;
  const step = (name: string, fn: () => Promise<void>) =>
    t.test(name, { skip: broken ? "an earlier step failed" : false }, async () => {
      try {
        await fn();
      } catch (e) {
        broken = true;
        diagnose();
        throw e;
      }
    });
  const tasks: Record<string, { id: string; agent: string }> = {};

  /** A task for `email` with its main agent idle. */
  const startTask = async (email: string) => {
    const r = await call(email, "POST", "/api/tasks", { prompt: `Hello from ${email}`, requestId: `itest-approvals-${email.split("@")[0]}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await waitFor(`${email}'s task running`, async () => {
      const v = await taskOf(email, r.body.id);
      if (v.state === "failed") throw Object.assign(new Error(`task failed: ${v.error}`), { fatal: true });
      return v.connected && (v.state === "running" || v.state === "idle") ? v : null;
    }, BOOT_MS, 2000);
    const client = await paseoAs(email, r.body.id);
    try {
      const agents = await waitFor(
        "the main agent",
        async () => {
          const list = (await client.agents.list()).entries.map((e: any) => e.agent ?? e);
          return list.length ? list : null;
        },
        TURN_MS,
      );
      await client.agents.ref(agents[0].id).waitForFinish(TURN_MS);
      return { id: r.body.id as string, agent: agents[0].id as string };
    } finally {
      await client.close();
    }
  };

  /** Send a message and, while the agent waits on the tool, act on the request it filed. */
  const turn = async (email: string, text: string, onRequest: (a: any) => Promise<void>, as: string) => {
    const task = tasks[email]!;
    const client = await paseoAs(email, task.id);
    try {
      const before = new Set(((await call(as, "GET", `/api/approvals?taskId=${task.id}`)).body?.approvals ?? []).map((a: { id: string }) => a.id));
      const running = client.agents.ref(task.agent).run(text, { timeoutMs: TURN_MS });
      const a = await waitFor("the request in the queue", async () => {
        const list = (await call(as, "GET", "/api/approvals?pending=1")).body.approvals as any[];
        return list.find((x) => x.taskId === task.id && !before.has(x.id));
      }, TURN_MS);
      await onRequest(a);
      const r = await running;
      assert.equal(r.status, "idle", JSON.stringify(r));
      return { request: a, reply: String(r.lastMessage) };
    } finally {
      await client.close();
    }
  };

  await step("tasks for alice (staff) and the admin (the owner)", async () => {
    tasks[ALICE] = await startTask(ALICE);
    tasks[ADMIN] = await startTask(ADMIN);
    const m = await machineOf(tasks[ALICE]!.id);
    const cfg = JSON.parse(await exec(m, "cat /home/jarvis/.config/opencode/opencode.json"));
    assert.deepEqual(cfg.plugin, ["file:///usr/local/lib/jarvis/lib/opencode-plugin.mjs"]);
    assert.equal(await exec(m, "stat -c %U /usr/local/lib/jarvis/lib/opencode-plugin.mjs"), "root");
    const chat = s.openrouter.chats.findLast((c) => c.tools.length)!;
    for (const name of ["jarvis_actions", "jarvis_action", "jarvis_request_access", "jarvis_ask_boss"]) assert.ok(chat.tools.includes(name), `the model is offered ${name}: ${chat.tools}`);
  });

  await step("self-confirm: alice sees exactly what will be sent, taps, and the agent gets the result", async () => {
    const { request, reply } = await turn(
      ALICE,
      `call: jarvis_action {"action":"desk_email","params":{"to":["client@example.net"],"subject":"Your quote","text":"Dear client,\\nthe quote is attached."},"reason":"the user asked"}`,
      async (a) => {
        assert.equal(a.approver, "self");
        assert.equal(a.kind, "action");
        assert.equal(a.preview.summary, "Send an email to client@example.net from support@example.org");
        assert.deepEqual(a.preview.fields.map((f: { label: string }) => f.label), ["From", "To", "Subject"]);
        assert.equal(a.preview.body, "Dear client,\nthe quote is attached.");
        assert.equal((await call(ADMIN, "GET", `/api/approvals/${a.id}`)).body.canDecide, false, "only alice confirms her own");
        assert.equal((await call(BOB, "GET", `/api/approvals/${a.id}`)).status, 404);
        const d = await call(ALICE, "POST", `/api/approvals/${a.id}/decide`, { decision: "approve" });
        assert.equal(d.status, 200, JSON.stringify(d.body));
      },
      ALICE,
    );
    assert.match(reply, /TOOL RESULT: Done: Send an email to client@example.net/);
    assert.ok(mails.some((m) => m.to.includes("client@example.net") && m.data.includes("the quote is attached")));
    assert.equal((await call(ALICE, "GET", `/api/approvals/${request.id}`)).body.state, "done");
  });

  await step("admin approval: mail leaving the company waits for an admin", async () => {
    const { reply } = await turn(
      ALICE,
      `call: jarvis_action {"action":"company_email","params":{"to":["partner@example.net"],"subject":"Update","text":"Hello partner"}}`,
      async (a) => {
        assert.equal(a.approver, "admin");
        assert.equal((await call(ALICE, "POST", `/api/approvals/${a.id}/decide`, { decision: "approve" })).status, 403, "staff can't approve it");
        assert.equal((await call(ADMIN, "POST", `/api/approvals/${a.id}/decide`, { decision: "approve" })).status, 200);
      },
      ADMIN,
    );
    assert.match(reply, /TOOL RESULT: Done: Send an email to partner@example.net/);
    assert.ok(mails.some((m) => m.to.includes("partner@example.net")));
  });

  await step("denial: the admin refuses with a reason; nothing is sent and the agent is told", async () => {
    const { reply } = await turn(
      ALICE,
      `call: jarvis_action {"action":"company_email","params":{"to":["press@example.net"],"subject":"Leak","text":"Secret plans"}}`,
      async (a) => {
        assert.equal((await call(ADMIN, "POST", `/api/approvals/${a.id}/decide`, { decision: "deny", note: "not to the press" })).status, 200);
      },
      ADMIN,
    );
    assert.match(reply, /TOOL RESULT: Denied by Admin: Send an email to press@example.net.*not to the press/);
    assert.ok(!mails.some((m) => m.to.includes("press@example.net")));
  });

  await step("a guarded tool call stops until alice confirms it; a denied one never runs", async () => {
    const ok = await turn(
      ALICE,
      "run: echo gmail-send would go out now",
      async (a) => {
        assert.equal(a.kind, "guard");
        assert.equal(a.approver, "self");
        assert.equal(a.preview.summary, "Send an email from your own mailbox");
        assert.equal(a.preview.body, "echo gmail-send would go out now");
        assert.equal((await call(ALICE, "POST", `/api/approvals/${a.id}/decide`, { decision: "approve" })).status, 200);
      },
      ALICE,
    );
    assert.match(ok.reply, /TOOL RESULT: gmail-send would go out now/);
    const m = await machineOf(tasks[ALICE]!.id);
    const no = await turn(
      ALICE,
      "run: echo gmail-send > /tmp/guard-ran",
      async (a) => {
        assert.equal((await call(ALICE, "POST", `/api/approvals/${a.id}/decide`, { decision: "deny", note: "wrong recipient" })).status, 200);
      },
      ALICE,
    );
    assert.match(no.reply, /locked policy \(Send an email from your own mailbox\)/);
    assert.equal(await exec(m, "test -e /tmp/guard-ran && echo ran || echo not-run"), "not-run");
  });

  await step("Tier 3: the owner signs exactly the change with a user-verified passkey", async () => {
    const auth = new SoftAuthenticator();
    const ro = await call(ADMIN, "POST", "/api/passkeys/register/options");
    assert.equal(ro.status, 200, JSON.stringify(ro.body));
    const reg = await call(ADMIN, "POST", "/api/passkeys/register", { response: auth.create(ro.body), name: "itest phone" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const { reply } = await turn(
      ADMIN,
      `call: jarvis_action {"action":"set_budget","params":{"monthlyUsd":75},"reason":"more sessions this month"}`,
      async (a) => {
        assert.equal(a.approver, "owner");
        assert.equal(a.decideWith, "passkey");
        assert.equal(a.preview.summary, "Change the instance's monthly machine budget from no cap to USD 75.00 a month");
        assert.equal((await call(ADMIN, "POST", `/api/approvals/${a.id}/decide`, { decision: "approve" })).status, 400, "a tap is not enough");
        const o = await call(ADMIN, "POST", `/api/approvals/${a.id}/passkey/options`);
        assert.equal(o.body.changeHash, a.changeHash);
        auth.o.uv = false;
        assert.equal((await call(ADMIN, "POST", `/api/approvals/${a.id}/passkey`, { response: auth.get(o.body.options) })).status, 400, "no Face ID, no approval");
        auth.o.uv = true;
        const o2 = await call(ADMIN, "POST", `/api/approvals/${a.id}/passkey/options`);
        const r = await call(ADMIN, "POST", `/api/approvals/${a.id}/passkey`, { response: auth.get(o2.body.options) });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.decision.passkey, true);
      },
      ADMIN,
    );
    assert.match(reply, /TOOL RESULT: Done: Change the instance's monthly machine budget/);
    assert.equal((await call(ADMIN, "GET", "/api/admin/budget")).body.capUsd, 75);
  });

  await step("clean up: destroy both tasks", async () => {
    for (const email of [ALICE, ADMIN]) assert.equal((await call(email, "DELETE", `/api/tasks/${tasks[email]!.id}`)).status, 202);
    await waitFor("both archived", async () => {
      for (const email of [ALICE, ADMIN]) if ((await taskOf(email, tasks[email]!.id)).state !== "archived") return false;
      return true;
    }, 5 * 60_000, 2000);
  });
});

test("Tier 0 tools through the real session image", { timeout: 20 * 60_000 }, async (t) => {
  let broken = false;
  const step = (name: string, fn: () => Promise<void>) =>
    t.test(name, { skip: broken ? "an earlier step failed" : false }, async () => {
      try {
        await fn();
      } catch (e) {
        broken = true;
        diagnose();
        throw e;
      }
    });
  let taskId = "";
  let agentId = "";
  let machine = "";

  /** One turn of alice's main agent; the model's reply text. */
  const say = async (text: string): Promise<string> => {
    const client = await paseoAs(ALICE, taskId);
    try {
      const r = await client.agents.ref(agentId).run(text, { timeoutMs: TURN_MS });
      assert.equal(r.status, "idle", JSON.stringify(r));
      return String(r.lastMessage);
    } finally {
      await client.close();
    }
  };

  await step("a task for alice; the model is offered the web tools and told about them", async () => {
    const r = await call(ALICE, "POST", "/api/tasks", { prompt: "Hello, tools", requestId: "itest-tools-alice" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    taskId = r.body.id;
    await waitFor("alice's tools task running", async () => {
      const v = await taskOf(ALICE, taskId);
      if (v.state === "failed") throw Object.assign(new Error(`task failed: ${v.error}`), { fatal: true });
      return v.connected && (v.state === "running" || v.state === "idle") && v.agentId ? v : null;
    }, BOOT_MS, 2000);
    agentId = (await taskOf(ALICE, taskId)).agentId;
    const client = await paseoAs(ALICE, taskId);
    try {
      await client.agents.ref(agentId).waitForFinish(TURN_MS);
    } finally {
      await client.close();
    }
    machine = await machineOf(taskId);
    const chat = s.openrouter.chats.findLast((c) => c.tools.includes("web_search"));
    assert.ok(chat, "the model is offered web_search");
    assert.ok(chat!.tools.includes("web_fetch"));
    assert.match(chat!.system, /use web_search \(a real search engine, current results\) and web_fetch/);
    assert.match(chat!.system, /A proxy is available at http:\/\/127\.0\.0\.1:3128/);
    assert.match(await exec(machine, "cat /home/jarvis/.jarvis/skills/jarvis-web/SKILL.md"), /## Search[\s\S]*## Fetch[\s\S]*## Proxy/);
  });

  await step("web_search: the server searches with the org key and charges alice", async () => {
    const reply = await say('call: web_search {"query":"jarvis itest"}');
    assert.match(reply, /TOOL RESULT: 1\. ITEST-RESULT for jarvis itest \(2026-10-09\)/);
    const last = stubs.searches.at(-1)!;
    assert.equal(last.key, stubs.searchKey);
    assert.equal(last.body.query, "jarvis itest");
  });

  await step("web_fetch: rendered, saved in the workspace", async () => {
    const reply = await say('call: web_fetch {"url":"https://news.example/one","render":true}');
    assert.match(reply, /TOOL RESULT: HTTP 200 text\/html/);
    assert.deepEqual(stubs.fetches.at(-1), { key: stubs.fetchKey, url: "https://news.example/one", render: "true" });
    assert.match(await exec(machine, "cat /home/jarvis/workspace/.web/news.example-*.html"), /ITEST-PAGE/);
  });

  await step("jarvis-web from the shell", async () => {
    const reply = await say('run: jarvis-web search "from a script" --n 3');
    assert.match(reply, /TOOL RESULT: 1\. ITEST-RESULT for from a script/);
    assert.equal(stubs.searches.at(-1)!.body.numResults, 3);
  });

  await step("the local proxy: plain http and a country, relayed and metered by the server", async () => {
    const reply = await say('run: curl -s -x "$JARVIS_PROXY_URL" http://site.example/hello');
    assert.match(reply, /TOOL RESULT: STUB-PAGE site\.example \/hello/);
    assert.deepEqual(stubs.tunnels.at(-1), { target: "site.example:80", auth: `${stubs.proxyLogin.username}:${stubs.proxyLogin.password}` });
    const de = await say("run: curl -s -x http://country-de:x@127.0.0.1:3128 http://site.example/de");
    assert.match(de, /TOOL RESULT: STUB-PAGE site\.example \/de/);
    assert.ok(stubs.tunnels.at(-1)!.auth.endsWith("_country-de"));
  });

  await step("usage: alice sees hers, the admin sees it, bob doesn't", async () => {
    const me = (await call(ALICE, "GET", "/api/me")).body;
    assert.equal(me.tools.web.calls, 3);
    assert.ok(Math.abs(me.tools.web.spentUsd - (0.007 + 0.007 + 5 * (49 / 250_000))) < 1e-4, String(me.tools.web.spentUsd));
    assert.equal(me.tools.proxy.mode, "relay");
    assert.ok(me.tools.proxy.usedGb > 0);
    assert.equal((await call(BOB, "GET", `/api/users/${me.user.id}`)).status, 404);
    assert.equal((await call(BOB, "GET", "/api/admin/tools")).status, 404);
    const adminView = (await call(ADMIN, "GET", `/api/users/${me.user.id}`)).body;
    assert.equal(adminView.tools.web.calls, 3);
    const totals = (await call(ADMIN, "GET", "/api/admin/tools")).body;
    assert.deepEqual([totals.search.provider, totals.fetch.provider, totals.proxy.mode], ["exa", "scrapingbee", "relay"]);
  });

  await step("the cap is hard: the next search is refused and the agent is told", async () => {
    const before = stubs.searches.length;
    const reply = await say('call: web_search {"query":"one too many"}');
    assert.match(reply, /allowance|used up|Not done/i);
    assert.equal(stubs.searches.length, before, "the provider was never called");
    const notices = (await call(ALICE, "GET", "/api/notices")).body.notices;
    assert.ok(notices.some((n: { kind: string }) => n.kind === "tools_cap"));
  });

  await step("no organisation key or proxy login anywhere in the machine", async () => {
    const secrets = [stubs.searchKey, stubs.fetchKey, stubs.proxyLogin.password];
    const found = await exec(machine, `for f in /proc/[0-9]*/environ; do cat "$f" 2>/dev/null | tr '\\0' '\\n'; done | grep -c -e ${secrets.join(" -e ")} || true; grep -rl -e ${secrets.join(" -e ")} /home/jarvis /usr/local/lib/jarvis /tmp 2>/dev/null | head -3; true`);
    assert.equal(found.split("\n")[0], "0", `found: ${found}`);
    assert.equal(found.split("\n").length, 1, `files: ${found}`);
  });
});

test("scheduled tasks, wakeups and channels on the real session image", { timeout: 20 * 60_000 }, async (t) => {
  let broken = false;
  const step = (name: string, fn: () => Promise<void>) =>
    t.test(name, { skip: broken ? "an earlier step failed" : false }, async () => {
      try {
        await fn();
      } catch (e) {
        broken = true;
        diagnose();
        throw e;
      }
    });
  let scheduleId = "";
  let taskId = "";
  let agentId = "";
  // The agent turn, not the title request (no tools) that carries the same first prompt.
  const seenChat = (mark: string, since: number) => () => Promise.resolve(s.openrouter.chats.slice(since).find((c) => c.lastUser.includes(mark) && c.tools.length > 0));
  /** One turn of alice's main agent, through the server's daemon proxy. */
  const turn = async (text: string) => {
    const client = await paseoAs(ALICE, taskId);
    try {
      const r = await client.agents.ref(agentId).run(text, { timeoutMs: TURN_MS });
      assert.equal(r.status, "idle", JSON.stringify(r));
      return String(r.lastMessage);
    } finally {
      await client.close();
    }
  };
  const idle = () => waitFor("idle", async () => (await taskOf(ALICE, taskId)).state === "idle", 60_000);

  await step("a schedule's 'Run now' starts a task whose first prompt is the schedule's", async () => {
    const before = s.openrouter.chats.length;
    const c = await call(ALICE, "POST", "/api/schedules", { title: "Weekly digest", prompt: "SCHEDULED-MARK summarise the week", cron: "0 9 * * MON", timeZone: "Europe/London" });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    scheduleId = c.body.id;
    assert.ok(c.body.nextRunAt);
    const r = await call(ALICE, "POST", `/api/schedules/${scheduleId}/run`);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.run.result, "started");
    taskId = r.body.task.id;
    assert.equal(r.body.task.scheduleId, scheduleId);
    await waitFor("the run's task running", async () => {
      const v = await taskOf(ALICE, taskId);
      if (v.state === "failed") throw Object.assign(new Error(`task failed: ${v.error}`), { fatal: true });
      return v.connected && (v.state === "running" || v.state === "idle") && v.agentId ? v : null;
    }, BOOT_MS, 2000);
    agentId = (await taskOf(ALICE, taskId)).agentId;
    const chat = await waitFor("the scheduled prompt at the model", seenChat("SCHEDULED-MARK", before), TURN_MS);
    assert.match(chat.lastUser, /^\[Scheduled task "Weekly digest", started by hand from its schedule/);
    assert.ok(chat.tools.includes("jarvis_wakeup") && chat.tools.includes("jarvis_post") && chat.tools.includes("jarvis_wakeups"), `${chat.tools}`);
    assert.match(chat.system, /jarvis_wakeup/);
    // bob can't see or run it
    assert.equal((await call(BOB, "GET", `/api/schedules/${scheduleId}`)).status, 404);
    assert.equal((await call(BOB, "POST", `/api/schedules/${scheduleId}/run`)).status, 404);
    await idle();
  });

  await step("the agent posts to the task's channel (plugin tool); alice is told; bob sees nothing", async () => {
    const reply = await turn('call: jarvis_post {"title": "ITEST report", "text": "CHANNEL-MARK all good"}');
    assert.match(reply, /TOOL RESULT: Posted to the task's channel: ITEST report/);
    const posts = (await call(ALICE, "GET", `/api/tasks/${taskId}/posts`)).body.posts;
    assert.equal(posts.length, 1);
    assert.equal(posts[0].text, "CHANNEL-MARK all good");
    const me = (await call(ALICE, "GET", "/api/me")).body;
    assert.equal(me.unreadPosts, 1);
    const ch = (await call(ALICE, "GET", "/api/channels")).body.channels;
    assert.equal(ch[0].taskId, taskId);
    assert.equal(ch[0].scheduleId, scheduleId);
    assert.ok((await call(ALICE, "GET", "/api/notices")).body.notices.some((n: { kind: string; taskId: string }) => n.kind === "channel_post" && n.taskId === taskId));
    assert.equal((await call(BOB, "GET", `/api/tasks/${taskId}/posts`)).status, 404);
    assert.equal((await call(BOB, "GET", "/api/channels")).body.channels.length, 0);
    assert.equal((await call(ADMIN, "GET", "/api/channels?all=1")).body.channels.length, 1);
    await idle();
  });

  await step("a wakeup on the running task: the prompt arrives as a new message", async () => {
    const reply = await turn('call: jarvis_wakeup {"name": "live", "in": "1s", "prompt": "WAKEUP-LIVE-MARK look again"}');
    assert.match(reply, /TOOL RESULT: Wakeup armed\. live \[armed\]/);
    const w = (await call(ALICE, "GET", `/api/wakeups?taskId=${taskId}`)).body.wakeups;
    assert.equal(w.length, 1);
    assert.equal(w[0].state, "armed");
    await idle();
    const before = s.openrouter.chats.length;
    await new Promise((r) => setTimeout(r, 1500));
    await s.jarvis.tick();
    const chat = await waitFor("the wakeup prompt at the model", seenChat("WAKEUP-LIVE-MARK", before), TURN_MS);
    assert.match(chat.lastUser, /^\[Jarvis wakeup "live" \(timed\), set earlier by this task; now /);
    assert.ok(chat.transcript.includes("SCHEDULED-MARK"), "in the same conversation");
    await waitFor("the message acked", async () => !s.jarvis.ctx.db.prepare("SELECT 1 FROM inbox WHERE task_id = ? AND delivered_at IS NULL").get(taskId), 60_000);
    assert.equal((await call(ALICE, "GET", `/api/wakeups?taskId=${taskId}`)).body.wakeups[0].state, "fired");
    await idle();
  });

  await step("a wakeup resumes the paused task and the prompt arrives (jarvis-wakeup in the shell)", async () => {
    const reply = await turn("run: jarvis-wakeup --name later --in 3s WAKEUP-PAUSED-MARK check the invoice");
    assert.match(reply, /TOOL RESULT: Wakeup armed: later \[armed\]/);
    await idle();
    assert.equal((await call(ALICE, "POST", `/api/tasks/${taskId}/pause`)).status, 202);
    await waitFor("paused", async () => {
      const x = await taskOf(ALICE, taskId);
      if (x.state !== "pausing" && x.state !== "paused") throw Object.assign(new Error(`pause failed: ${x.state} ${x.error}`), { fatal: true });
      return x.state === "paused" && !x.busy ? x : null;
    }, 5 * 60_000);
    assert.equal((await s.machines.list()).filter((m) => m.metadata.jarvisTask === taskId).length, 0);
    const before = s.openrouter.chats.length;
    await new Promise((r) => setTimeout(r, 3000));
    await s.jarvis.tick();
    const v = await taskOf(ALICE, taskId);
    assert.ok(["starting", "running"].includes(v.state), `resumed by the wakeup: ${v.state} ${v.error}`);
    await waitFor("running again", async () => {
      const x = await taskOf(ALICE, taskId);
      if (x.state === "paused" && !x.busy) throw Object.assign(new Error(`resume failed: ${x.error}`), { fatal: true });
      return x.connected ? x : null;
    }, BOOT_MS, 2000);
    const chat = await waitFor("the wakeup prompt at the model after the resume", seenChat("WAKEUP-PAUSED-MARK", before), TURN_MS);
    assert.match(chat.lastUser, /^\[Jarvis wakeup "later" \(timed\)/);
    assert.ok(chat.transcript.includes("WAKEUP-LIVE-MARK") && chat.transcript.includes("SCHEDULED-MARK"), "the restored conversation continued");
    const m = await machineOf(taskId);
    assert.match(await exec(m, "cat /home/jarvis/.jarvis/inbox-delivered"), /\S/);
    await waitFor("acked", async () => !s.jarvis.ctx.db.prepare("SELECT 1 FROM inbox WHERE task_id = ? AND delivered_at IS NULL").get(taskId), 60_000);
    const later = (await call(ALICE, "GET", `/api/wakeups?taskId=${taskId}`)).body.wakeups.find((x: { name: string }) => x.name === "later");
    assert.equal(later.state, "fired");
  });

  await step("clean up: destroying the task cancels its wakeups; the schedule goes", async () => {
    await idle();
    const reply = await turn("run: jarvis-wakeup --name tomorrow --in 1d tomorrow");
    assert.match(reply, /Wakeup armed/);
    assert.equal((await call(ALICE, "DELETE", `/api/tasks/${taskId}`)).status, 202);
    await waitFor("archived", async () => (await taskOf(ALICE, taskId)).state === "archived", 5 * 60_000);
    const ws = (await call(ALICE, "GET", `/api/wakeups?taskId=${taskId}`)).body.wakeups;
    assert.ok(ws.every((x: { state: string }) => x.state !== "armed"));
    assert.equal((await call(ALICE, "GET", `/api/tasks/${taskId}/posts`)).body.posts.length, 1, "the channel outlives the machine");
    assert.equal((await call(ALICE, "DELETE", `/api/schedules/${scheduleId}`)).status, 200);
  });
});
