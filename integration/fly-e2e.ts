// The real-Fly end-to-end run: the instance server in this process with the Fly MachineProvider
// pointed at a real Fly app, the published session image, and one real OpenRouter model.
//
//   New task -> Fly machine boots -> layers load -> first prompt answered by the model -> chat
//   through the server's daemon proxy -> pause (snapshot, machine destroyed) -> resume (same
//   conversation) -> destroy (archive) -> no machine left.
//
// What stands in for the rest of an instance (all local, all torn down at the end):
//   - Cloudflare Access: test-signed JWTs for the user, and the session gate's service-token headers
//     turned into a gate JWT in front of the server (as in stack.ts);
//   - the bucket: versitygw (an S3 gateway on a temp dir);
//   - the public hostname: two Cloudflare quick tunnels (trycloudflare.com, no account), one for the
//     server (the sessions' JARVIS_URL), one for the bucket (the presigned snapshot URLs);
//   - the org-env repo: a local bare repo.
// Real: Fly Machines (create/start/exec/list/destroy) in an existing app (left in place; only this
// run's machines are touched), the session image from GHCR, OpenRouter (the server mints the user's
// key with the management key, limit E2E_KEY_LIMIT_USD; deleted at the end).
//
// Run with fly-e2e.sh (docs/FLY-E2E.md). Prints no secret.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { AwsClient } from "aws4fetch";
import { WebSocket } from "ws";
import { createPaseoClient, type PaseoClient } from "@getpaseo/client";
import { createJarvis, type Jarvis } from "../server/src/app.ts";
import { validateConfig } from "../server/src/config.ts";
import { openDb } from "../server/src/db.ts";
import { FlyMachines } from "../server/src/fly.ts";
import { S3BlobStore } from "../server/src/s3.ts";
import { OpenRouterKeys } from "../server/src/openrouter.ts";
import { StaticDirectory } from "../server/src/directory-google.ts";
import { GitOrgEnv } from "../server/src/orgenv-git.ts";
import { FakeDeviceTokens } from "../server/src/fakes/devices.ts";
import { hourlyMachineCostUSD } from "../server/src/spend.ts";
import { keyRow, revokeKey } from "../server/src/userkeys.ts";
import { makeOrgRepo } from "./stack.ts";

const need = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const FLY_TOKEN = need("FLY_API_TOKEN");
const OR_MGMT = need("OPENROUTER_MANAGEMENT_KEY");
const IMAGE = need("SESSION_IMAGE");
if (/:main$/.test(IMAGE) || !/:[0-9a-f]{7,40}$|@sha256:/.test(IMAGE)) throw new Error("SESSION_IMAGE must be pinned to a commit tag or digest, not :main");
const ORG = need("FLY_ORG");
const APP = need("FLY_APP");
const REGION = process.env.E2E_FLY_REGION || "lhr";
const MODEL = process.env.E2E_MODEL || "google/gemini-2.5-flash-lite";
const KEY_LIMIT = Number(process.env.E2E_KEY_LIMIT_USD || 1);
const REPORT = process.env.E2E_REPORT || "";
const GUEST = { cpu_kind: "shared" as const, cpus: 2, memory_mb: 2048 };
const BOOT_MS = 6 * 60_000;
const TURN_MS = 4 * 60_000;

const INSTANCE = "flye2e";
const TEAM = "flye2e.cloudflareaccess.example.org";
const AUD = "flye2e-audience";
const GATE_ID = "flye2e-session-gate.access";
const USER = "e2e@example.org";
const WORD = `MANGO${randomBytes(2).toString("hex").toUpperCase()}`;

const t0 = Date.now();
const secs = (ms: number) => Math.round(ms / 100) / 10;
const log = (m: string) => console.log(`[${secs(Date.now() - t0).toFixed(1)}s] ${m}`);

// ---- small helpers -----------------------------------------------------------------------------

const children: ChildProcess[] = [];
function launch(cmd: string, args: string[], name: string): ChildProcess {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(p);
  p.on("exit", (code) => log(`(${name} exited ${code})`));
  return p;
}

/** A Cloudflare quick tunnel to a local port; resolves with its https URL. */
function quickTunnel(port: number, name: string): Promise<string> {
  const p = launch("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], `tunnel ${name}`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no quick tunnel URL for ${name}`)), 60_000);
    let buf = "";
    const on = (d: Buffer) => {
      buf += d.toString();
      // the URL is printed before the edge has the tunnel; resolving its name that early gets an
      // NXDOMAIN the resolver then caches, so wait for the registered connection
      const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(buf);
      if (m && /Registered tunnel connection/.test(buf)) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    p.stderr!.on("data", on);
    p.stdout!.on("data", on);
  });
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
    if (Date.now() > end) {
      const cause = (last as { cause?: { code?: string; message?: string } } | undefined)?.cause;
      throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}${cause ? ` (${cause.code || cause.message})` : ""}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}
const fatal = (m: string) => Object.assign(new Error(m), { fatal: true });
const freePort = async (): Promise<number> => {
  const { createServer } = await import("node:net");
  return new Promise((r) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => r(port));
    });
  });
};

async function flyApi(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`https://api.machines.dev/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${FLY_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

// ---- the run -----------------------------------------------------------------------------------

interface StepResult {
  name: string;
  ok: boolean;
  seconds: number;
  note?: string;
}
const steps: StepResult[] = [];
const timings: Record<string, number> = {};
let broken = false;
async function step(name: string, fn: () => Promise<string | void>): Promise<void> {
  if (broken) {
    steps.push({ name, ok: false, seconds: 0, note: "skipped: an earlier step failed" });
    log(`SKIP ${name}`);
    return;
  }
  const s = Date.now();
  log(`---- ${name}`);
  try {
    const note = await fn();
    steps.push({ name, ok: true, seconds: secs(Date.now() - s), ...(note ? { note } : {}) });
    log(`PASS ${name} (${secs(Date.now() - s)}s)${note ? ` — ${note}` : ""}`);
  } catch (e) {
    broken = true;
    steps.push({ name, ok: false, seconds: secs(Date.now() - s), note: (e as Error).message.slice(0, 500) });
    log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

async function main(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis3-flye2e-"));
  let jarvis: Jarvis | null = null;
  let flyMachines: FlyMachines | null = null;
  const machineSeconds: Record<string, { created: number; gone?: number }> = {};
  let keyUsage: number | null = null;

  try {
    // -- the stand-ins
    const s3Key = "e2e" + randomBytes(4).toString("hex");
    const s3Secret = randomBytes(16).toString("hex");
    const s3Port = await freePort();
    mkdirSync(join(dir, "s3", "e2e"), { recursive: true });
    mkdirSync(join(dir, "vgw-meta"), { recursive: true });
    const vgw = spawn("versitygw", ["--port", `127.0.0.1:${s3Port}`, "--quiet", "posix", "--sidecar", join(dir, "vgw-meta"), join(dir, "s3")], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, ROOT_ACCESS_KEY_ID: s3Key, ROOT_SECRET_ACCESS_KEY: s3Secret },
    });
    children.push(vgw);
    let vgwErr = "";
    vgw.stderr!.on("data", (d: Buffer) => (vgwErr = (vgwErr + d.toString()).slice(-2000)));
    vgw.on("exit", (code) => code !== null && code !== 0 && log(`versitygw exited ${code}: ${vgwErr}`));
    const serverPort = await freePort();
    const [serverUrl, s3Url] = await Promise.all([quickTunnel(serverPort, "server"), quickTunnel(s3Port, "bucket")]);
    log(`tunnels: server ${serverUrl}, bucket ${s3Url}`);
    const s3 = new AwsClient({ accessKeyId: s3Key, secretAccessKey: s3Secret, region: "us-east-1", service: "s3" });
    const bucketUrl = `${s3Url}/e2e`;
    // (versitygw refuses a sidecar dir whose path merely starts with the root's, e.g. s3meta next to s3)
    // a fresh quick tunnel can take a while to answer (DNS + edge)
    await waitFor(
      "the bucket through its tunnel",
      async () => {
        const r = await s3.fetch(`${bucketUrl}/probe`, { method: "PUT", body: "x" });
        if (!r.ok) throw new Error(`PUT -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
        return true;
      },
      90_000,
      2000,
    );
    const s3exists = async (key: string) => (await s3.fetch(`${bucketUrl}/${key}`, { method: "HEAD" })).ok;

    const org = makeOrgRepo(dir);

    // -- the Fly app: one persistent app per instance (DESIGN.md), made by the operator, never by
    // the server or this run; the token may be scoped to just that app
    await step("Fly app reachable with the token", async () => {
      const r = await flyApi("GET", `/apps/${APP}/machines`);
      if (r.status !== 200) throw new Error(`GET /apps/${APP}/machines -> ${r.status}: ${JSON.stringify(r.json).slice(0, 300)}`);
      const live = (r.json as { state: string }[]).filter((m) => m.state !== "destroyed").length;
      return `${APP}: ${live} live machine(s) before the run`;
    });

    // -- the server
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "e2e", alg: "RS256" };
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "e2e" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("2h").sign(privateKey);
    const gateSecret = randomBytes(16).toString("hex");
    const gateJwt = await sign({ common_name: GATE_ID, type: "app", sub: "" });
    const config = validateConfig({
      instanceName: INSTANCE,
      publicUrl: serverUrl,
      access: { teamDomain: TEAM, audience: AUD, sessionGateClientId: GATE_ID },
      directory: { kind: "static", users: [{ email: USER, name: "E2E", role: "admin" }] },
      bootstrapAdmins: [],
      roles: { admin: { openrouterMonthlyUsd: KEY_LIMIT, machineHoursPerMonth: 1, admin: true } },
      models: [{ id: MODEL, label: MODEL }],
      defaultModel: MODEL,
      machines: { kind: "fly", app: APP, org: ORG, region: REGION, image: IMAGE, guest: GUEST },
      storage: { kind: "s3", endpoint: s3Url, region: "us-east-1", bucket: "e2e" },
      orgEnv: { mirrorPath: org.mirror, commit: org.commit },
      daemonPath: "/ws",
      idleMinutes: 0,
      budget: { monthlyUsd: 2 },
      devices: { appScheme: "jarvis3", cloudflareAccountId: "e2e" },
      presignSeconds: 3600,
    });
    flyMachines = new FlyMachines({ token: FLY_TOKEN, app: APP, region: REGION });
    const machines = flyMachines;
    jarvis = createJarvis({
      config,
      db: openDb(join(dir, "jarvis.db")),
      dbKey: randomBytes(32).toString("base64"),
      sessionGateClientSecret: gateSecret,
      accessJwks: { keys: [jwk] },
      snapshotPollMs: 2000,
      snapshotTimeoutMs: 5 * 60_000,
      log: (m, e) => log(`[jarvis] ${m} ${e ? JSON.stringify(e) : ""}`),
      providers: {
        machines,
        blobs: new S3BlobStore({ endpoint: s3Url, region: "us-east-1", bucket: "e2e", accessKeyId: s3Key, secretAccessKey: s3Secret }),
        keys: new OpenRouterKeys(OR_MGMT),
        directory: new StaticDirectory(config.directory.kind === "static" ? config.directory.users : []),
        deviceTokens: new FakeDeviceTokens(),
        orgEnv: new GitOrgEnv(org.mirror, org.commit),
      },
    });
    const j = jarvis;
    const access = (req: IncomingMessage) => {
      const id = req.headers["cf-access-client-id"];
      if (id === undefined) return;
      delete req.headers["cf-access-jwt-assertion"];
      if (id === GATE_ID && req.headers["cf-access-client-secret"] === gateSecret) req.headers["cf-access-jwt-assertion"] = gateJwt;
    };
    j.server.prependListener("request", access);
    j.server.prependListener("upgrade", access);
    await new Promise<void>((r) => j.server.listen(serverPort, "127.0.0.1", () => r()));
    const sync = await j.syncDirectory();
    if (!sync.ok) throw new Error(`directory sync: ${sync.error}`);
    await waitFor("the server through its tunnel", async () => (await fetch(`${serverUrl}/api/health`)).ok, 90_000, 2000);
    const base = `http://127.0.0.1:${serverPort}`;

    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(base + path, {
        method,
        headers: { "cf-access-jwt-assertion": await sign({ email: USER, sub: `sub-${USER}`, type: "app" }), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const taskOf = (id: string) => call("GET", `/api/tasks/${id}`).then((r) => r.body);
    // the app's path: through the server's daemon proxy (locally; the session side is over the tunnel)
    const paseo = async (taskId: string): Promise<PaseoClient> => {
      const jwt = await sign({ email: USER, sub: `sub-${USER}`, type: "app" });
      const client = createPaseoClient({
        url: `ws://127.0.0.1:${serverPort}/api/tasks/${taskId}/daemon`,
        reconnect: { enabled: false },
        webSocketFactory: (url: string, o?: { headers?: Record<string, string>; protocols?: string[] }) =>
          new WebSocket(url, o?.protocols ?? [], { headers: { ...(o?.headers ?? {}), "cf-access-jwt-assertion": jwt } }),
      } as Parameters<typeof createPaseoClient>[0]);
      await client.connect();
      return client;
    };
    const ourMachines = async (taskId: string) => (await machines.list()).filter((m) => m.metadata.jarvisTask === taskId);
    const track = async (taskId: string) => {
      for (const m of await ourMachines(taskId)) machineSeconds[m.id] ??= { created: Date.now() };
    };
    const exec = async (id: string, script: string) => {
      const r = await machines.exec(id, ["sh", "-c", script], 30);
      if (r.exitCode !== 0) throw new Error(`exec failed (${r.exitCode}): ${r.stderr.slice(0, 300)}`);
      return r.stdout.trim();
    };
    const waitLive = async (taskId: string, label: string) => {
      const start = Date.now();
      let machineAt = 0;
      await waitFor(
        `${label}: the task running and connected`,
        async () => {
          const v = await taskOf(taskId);
          if (v.state === "failed" || (v.state === "paused" && !v.busy)) throw fatal(`task ${v.state}: ${v.error}`);
          if (!machineAt) {
            const ms = await ourMachines(taskId);
            await track(taskId);
            if (ms.some((m) => m.state === "started")) machineAt = Date.now();
          }
          return v.connected && (v.state === "running" || v.state === "idle") ? v : null;
        },
        BOOT_MS,
        2000,
      );
      timings[`${label}: request -> Fly machine started (s)`] = secs((machineAt || Date.now()) - start);
      timings[`${label}: request -> session dialled in (s)`] = secs(Date.now() - start);
    };

    let taskId = "";
    let agentId = "";
    let machineId = "";

    await step("task created (OpenRouter key minted for the user)", async () => {
      assert((await call("PUT", "/api/users/me/layer/instructions", { text: "PERSONAL-MARK: answer briefly." })).status === 200, "personal layer");
      const r = await call("POST", "/api/tasks", { prompt: `Reply with only this word and nothing else: ${WORD}`, requestId: "flye2e-1" });
      assert(r.status === 201, `create -> ${r.status} ${JSON.stringify(r.body)}`);
      taskId = r.body.id;
      return `task ${taskId}, model ${MODEL}`;
    });

    await step("Fly machine boots and the session dials in through the tunnel", async () => {
      await waitLive(taskId, "create");
      const ms = (await ourMachines(taskId)).filter((m) => m.state === "started");
      assert(ms.length === 1, `one started machine, saw ${ms.length}`);
      machineId = ms[0]!.id;
      const info = await flyApi("GET", `/apps/${APP}/machines/${machineId}`);
      return `machine ${machineId} in ${info.json?.region}, ${JSON.stringify(info.json?.config?.guest)}, image ${info.json?.config?.image}`;
    });

    await step("layers are loaded in the machine (Fly exec)", async () => {
      const ins = await exec(machineId, "cat /home/jarvis/.jarvis/instructions.md");
      const marks = ["# Jarvis session", "ORG-MARK", "ROLE-MARK: admins", "PERSONAL-MARK", "POLICY-MARK"].map((k) => ins.indexOf(k));
      assert(
        marks.every((i) => i >= 0),
        `layers missing: ${marks}`,
      );
      assert(JSON.stringify([...marks].sort((a, b) => a - b)) === JSON.stringify(marks), "org -> role -> personal -> policy");
      const cfg = JSON.parse(await exec(machineId, "cat /home/jarvis/.config/opencode/opencode.json"));
      assert(cfg.model === `openrouter/${MODEL}`, `model ${cfg.model}`);
      assert(!JSON.stringify(cfg).includes("sk-or-"), "no key in the config file");
      const skills = (await exec(machineId, "ls -1 /home/jarvis/.jarvis/skills")).split("\n").sort().join(",");
      return `skills ${skills}`;
    });

    await step("first prompt answered by the real model", async () => {
      const start = Date.now();
      const client = await paseo(taskId);
      try {
        const agents = await waitFor("the main agent", async () => {
          const l = (await client.agents.list()).entries.map((e: any) => e.agent ?? e);
          return l.length ? l : null;
        }, TURN_MS, 2000);
        agentId = agents[0].id;
        const r = await client.agents.ref(agentId).waitForFinish(TURN_MS);
        assert(r.status === "idle", `status ${r.status} ${r.error ?? ""}`);
        assert(String(r.lastMessage).includes(WORD), `answer: ${String(r.lastMessage).slice(0, 200)}`);
        timings["session dialled in -> first answer seen (s)"] = secs(Date.now() - start);
        return `answer: ${JSON.stringify(String(r.lastMessage).slice(0, 80))}`;
      } finally {
        await client.close();
      }
    });

    await step("chat round-trip through the server's daemon proxy", async () => {
      const start = Date.now();
      const client = await paseo(taskId);
      try {
        const r = await client.agents.ref(agentId).run("What single word did you reply with just now? Answer with that word only.", { timeoutMs: TURN_MS });
        assert(r.status === "idle", `status ${r.status} ${r.error ?? ""}`);
        assert(String(r.lastMessage).includes(WORD), `answer: ${String(r.lastMessage).slice(0, 200)}`);
        timings["chat turn (s)"] = secs(Date.now() - start);
        return `answer: ${JSON.stringify(String(r.lastMessage).slice(0, 80))}`;
      } finally {
        await client.close();
      }
    });

    await step("task reports idle and the main agent id", async () => {
      const v = await waitFor("idle", async () => {
        const x = await taskOf(taskId);
        return x.state === "idle" ? x : null;
      }, 60_000, 2000);
      assert(v.agentId === agentId, `agentId ${v.agentId} vs ${agentId}`);
    });

    await step("pause: snapshot in the bucket, Fly machine destroyed", async () => {
      const start = Date.now();
      const r = await call("POST", `/api/tasks/${taskId}/pause`);
      assert(r.status === 202, `pause -> ${r.status} ${JSON.stringify(r.body)}`);
      const v = await waitFor("paused", async () => {
        const x = await taskOf(taskId);
        if (x.state !== "pausing" && x.state !== "paused") throw fatal(`pause failed: ${x.state} ${x.error}`);
        return x.state === "paused" && !x.busy ? x : null;
      }, 6 * 60_000, 2000);
      assert(v.error === null, `error ${v.error}`);
      assert(await s3exists(`snapshots/${taskId}/state.tar.gz`), "snapshot object");
      const head = await s3.fetch(`${bucketUrl}/snapshots/${taskId}/state.tar.gz`, { method: "HEAD" });
      const left = (await ourMachines(taskId)).filter((m) => m.state !== "destroyed");
      assert(left.length === 0, `machines left: ${JSON.stringify(left.map((m) => [m.id, m.state]))}`);
      machineSeconds[machineId]!.gone = Date.now();
      timings["pause (s)"] = secs(Date.now() - start);
      return `snapshot ${head.headers.get("content-length")} bytes`;
    });

    await step("resume: a new Fly machine, the same conversation", async () => {
      assert((await call("POST", `/api/tasks/${taskId}/resume`)).status === 202, "resume accepted");
      await waitLive(taskId, "resume");
      const ms = (await ourMachines(taskId)).filter((m) => m.state === "started");
      assert(ms.length === 1 && ms[0]!.id !== machineId, "one new machine");
      machineId = ms[0]!.id;
      const start = Date.now();
      const client = await paseo(taskId);
      try {
        const agents = (await client.agents.list()).entries.map((e: any) => e.agent ?? e);
        assert(agents.length === 1 && agents[0].id === agentId, `agents ${JSON.stringify(agents.map((a: { id: string }) => a.id))}`);
        const r = await client.agents.ref(agentId).run("Repeat, once more, the word from your very first reply. Only that word.", { timeoutMs: TURN_MS });
        assert(r.status === "idle", `status ${r.status} ${r.error ?? ""}`);
        assert(String(r.lastMessage).includes(WORD), `answer: ${String(r.lastMessage).slice(0, 200)}`);
        timings["resumed chat turn (s)"] = secs(Date.now() - start);
        return `machine ${machineId}; answer ${JSON.stringify(String(r.lastMessage).slice(0, 80))}`;
      } finally {
        await client.close();
      }
    });

    await step("delete: archive in the bucket, task archived, no Fly machine left", async () => {
      const start = Date.now();
      assert((await call("DELETE", `/api/tasks/${taskId}`)).status === 202, "delete accepted");
      const v = await waitFor("archived", async () => {
        const x = await taskOf(taskId);
        if (!["destroying", "archived"].includes(x.state)) throw fatal(`destroy failed: ${x.state} ${x.error}`);
        return x.state === "archived" && !x.busy ? x : null;
      }, 6 * 60_000, 2000);
      assert(v.error === null, `error ${v.error}`);
      const me = (await call("GET", "/api/me")).body.user.id;
      assert(await s3exists(`archives/${me}/${taskId}/state.tar.gz`), "archive object");
      assert(await s3exists(`archives/${me}/${taskId}/task.json`), "task.json");
      if (machineSeconds[machineId]) machineSeconds[machineId]!.gone = Date.now();
      const left = await waitFor("Fly to list no live machine", async () => {
        const all = (await flyApi("GET", `/apps/${APP}/machines`)).json as { id: string; state: string }[];
        return all.every((m) => m.state === "destroyed") ? all : null;
      }, 60_000, 3000);
      timings["delete (s)"] = secs(Date.now() - start);
      return `Fly lists ${left.length} machine(s) in the app, none live`;
    });

    // -- spend of this run
    const u = j.ctx.db.prepare("SELECT id FROM users WHERE email = ?").get(USER) as { id: string } | undefined;
    const k = u ? keyRow(j.ctx, u.id) : null;
    if (k) {
      const r = await fetch(`https://openrouter.ai/api/v1/keys/${encodeURIComponent(k.hash)}`, { headers: { Authorization: `Bearer ${OR_MGMT}` } });
      if (r.ok) keyUsage = ((await r.json()) as { data: { usage: number } }).data.usage;
    }
    return broken ? 1 : 0;
  } catch (e) {
    log(`ERROR ${(e as Error).stack || e}`);
    return 1;
  } finally {
    // -- cleanup: every machine of this instance, the user's OpenRouter key, the app if made here
    const cleanup: string[] = [];
    if (flyMachines) {
      try {
        const live = (await flyMachines.list()).filter((m) => m.metadata.jarvisInstance === INSTANCE);
        for (const m of live) {
          await flyMachines.destroy(m.id);
          machineSeconds[m.id] ??= { created: t0 };
          machineSeconds[m.id]!.gone ??= Date.now();
        }
        cleanup.push(`destroyed ${live.length} leftover machine(s)`);
      } catch (e) {
        if ((e as { flyStatus?: number }).flyStatus === 404) cleanup.push("no Fly app, so no machines");
        else cleanup.push(`MACHINE CLEANUP FAILED: ${(e as Error).message}`);
      }
    }
    if (jarvis) {
      const j = jarvis;
      await j.settle().catch(() => {});
      try {
        const u = j.ctx.db.prepare("SELECT id FROM users WHERE email = ?").get(USER) as { id: string } | undefined;
        if (u && (await revokeKey(j.ctx, u.id))) cleanup.push("deleted the user's OpenRouter key");
      } catch (e) {
        cleanup.push(`OPENROUTER KEY CLEANUP FAILED: ${(e as Error).message}`);
      }
      await j.close().catch(() => {});
    }
    for (const c of children) c.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
    for (const c of cleanup) log(`cleanup: ${c}`);

    let machineUsd = 0;
    let machineSecondsTotal = 0;
    for (const m of Object.values(machineSeconds)) {
      const s = ((m.gone ?? Date.now()) - m.created) / 1000;
      machineSecondsTotal += s;
      machineUsd += (s / 3600) * hourlyMachineCostUSD(GUEST);
    }
    const report = {
      when: new Date(t0).toISOString(),
      image: IMAGE,
      app: APP,
      org: ORG,
      region: REGION,
      model: MODEL,
      guest: GUEST,
      steps,
      timings,
      machineSecondsSeen: Math.round(machineSecondsTotal),
      machineUsdEstimate: Number(machineUsd.toFixed(5)),
      openrouterUsd: keyUsage,
      cleanup,
      totalSeconds: secs(Date.now() - t0),
    };
    console.log(JSON.stringify(report, null, 2));
    if (REPORT) writeFileSync(REPORT, JSON.stringify(report, null, 2));
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

process.exitCode = await main();
setTimeout(() => process.exit(), 2000).unref();
