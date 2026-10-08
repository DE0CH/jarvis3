// PLAN section 5 "Integration": the whole chain without a browser, against the real session image.
//
//   New task -> machine boots -> layers in the right order -> daemon dials in -> chat over the
//   proxied WebSocket (Paseo's own client SDK) -> "remember" lands in the personal layer ->
//   pause (snapshot in MinIO, machine gone) -> resume (same conversation) -> destroy (archive in
//   MinIO). Another user gets 404 on the task and on the daemon socket.
//
// Needs Docker and the session image: SESSION_IMAGE (default jarvis3-session:test), built from
// session-image/. Run: npm test (in integration/).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { startStack, MODEL, type Stack } from "./stack.ts";

const IMAGE = process.env.SESSION_IMAGE || "jarvis3-session:test";
const BOOT_MS = Number(process.env.BOOT_TIMEOUT_MS || 240_000);
const TURN_MS = Number(process.env.TURN_TIMEOUT_MS || 240_000);

let s: Stack;
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

before(async () => {
  s = await startStack({ image: IMAGE, log });
});
after(async () => {
  await s?.close();
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
    const r = await call(ALICE, "POST", "/api/tasks", { prompt: "Hello from alice FIRST-PROMPT", requestId: "itest-1" });
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
    assert.deepEqual(skills, ["personal-search", "report", "role-report", "search"]);
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
});
