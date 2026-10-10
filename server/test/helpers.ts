// A Jarvis instance on fakes, a test Access signer, and a small HTTP/WebSocket client.
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createJarvis, type Jarvis } from "../src/app.ts";
import type { Config } from "../src/config.ts";
import { validateConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { FakeMachines } from "../src/fakes/machines.ts";
import { FakeBlobStore } from "../src/fakes/blobs.ts";
import { FakeKeys } from "../src/fakes/keys.ts";
import { FakeDirectory } from "../src/fakes/directory.ts";
import { FakeDeviceTokens } from "../src/fakes/devices.ts";
import { FakeOrgEnv } from "../src/fakes/orgenv.ts";
import { WebApp } from "../src/web.ts";
import type { Clock } from "../src/clock.ts";
import type { OrgEnvForge } from "../src/providers.ts";

export const TEAM = "example.cloudflareaccess.com";
export const AUD = "test-audience-tag";
export const GATE = "session-gate.access";

export const ORG_FILES: Record<string, string> = {
  "AGENTS.md": "Org: be helpful to Example Org staff.",
  "skills/search/SKILL.md": "org search skill",
  "skills/report/SKILL.md": "org report skill",
  "roles/staff/AGENTS.md": "Staff role instructions.",
  "roles/staff/skills/report/SKILL.md": "staff report (clashes with org)",
  "roles/staff/skills/crm/SKILL.md": "staff crm",
  "roles/admin/AGENTS.md": "Admin role instructions.",
  "policy/AGENTS.md": "Never send money.",
  "policy/skills/send-mail/SKILL.md": "locked send-mail",
  "policy/deny.json": JSON.stringify([{ permission: "bash", pattern: "rm -rf /*" }]),
};

export function testConfig(over: Partial<Config> = {}): Config {
  return validateConfig({
    instanceName: "example",
    publicUrl: "https://jarvis.example.org",
    access: { teamDomain: TEAM, audience: AUD, sessionGateClientId: GATE },
    directory: { kind: "google", domain: "example.org", subject: "it-admin@example.org", groupRoles: { "jarvis-admin@example.org": "admin", "jarvis-staff@example.org": "staff" } },
    bootstrapAdmins: [],
    roles: {
      admin: { openrouterMonthlyUsd: 100, machineHoursPerMonth: null, admin: true },
      staff: { openrouterMonthlyUsd: 20, machineHoursPerMonth: 10 },
    },
    models: [
      { id: "anthropic/claude-test", label: "Claude (test)" },
      { id: "openai/gpt-test", label: "GPT (test)" },
    ],
    defaultModel: "anthropic/claude-test",
    machines: { kind: "fly", app: "example-sessions", org: "example", region: "ams", image: "ghcr.io/example/session:test", guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 } },
    storage: { kind: "s3", endpoint: "https://s3.example.org", region: "eu", bucket: "example" },
    orgEnv: { mirrorPath: "/nonexistent", commit: "0".repeat(40) },
    daemonPath: "/ws",
    idleMinutes: 60,
    budget: { monthlyUsd: 50 },
    devices: { appScheme: "jarvis3", cloudflareAccountId: "acct" },
    ...over,
  });
}

export class TestClock implements Clock {
  t: number;
  constructor(t = Date.UTC(2026, 9, 8, 12, 0, 0)) {
    this.t = t;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Signer {
  jwks: { keys: JWK[] };
  sign(claims: Record<string, unknown>, o?: { aud?: string; iss?: string; exp?: number; iat?: number; kid?: string }): Promise<string>;
}

let cachedSigner: Promise<{ priv: Parameters<SignJWT["sign"]>[0]; jwk: JWK }> | null = null;
export async function makeSigner(clock: Clock): Promise<Signer> {
  cachedSigner ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    return { priv: privateKey, jwk };
  })();
  const { priv, jwk } = await cachedSigner;
  return {
    jwks: { keys: [jwk] },
    async sign(claims, o = {}) {
      const now = Math.floor(clock.now() / 1000);
      return new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: o.kid ?? "test-key" })
        .setIssuer(o.iss ?? `https://${TEAM}`)
        .setAudience(o.aud ?? AUD)
        .setIssuedAt(o.iat ?? now)
        .setExpirationTime(o.exp ?? now + 3600)
        .sign(priv);
    },
  };
}

export interface Harness {
  jarvis: Jarvis;
  clock: TestClock;
  signer: Signer;
  machines: FakeMachines;
  blobs: FakeBlobStore;
  keys: FakeKeys;
  directory: FakeDirectory;
  deviceTokens: FakeDeviceTokens;
  base: string;
  wsBase: string;
  logs: string[];
  close(): Promise<void>;
}

export async function harness(o: { config?: Partial<Config>; orgFiles?: Record<string, string>; webDir?: string; forge?: OrgEnvForge; actionSecrets?: Record<string, Record<string, string>> } = {}): Promise<Harness> {
  const clock = new TestClock();
  const signer = await makeSigner(clock);
  const machines = new FakeMachines();
  const blobs = new FakeBlobStore();
  machines.upload = (url) => blobs.acceptPut(url);
  const keys = new FakeKeys();
  const directory = new FakeDirectory();
  const deviceTokens = new FakeDeviceTokens();
  const logs: string[] = [];
  const jarvis = createJarvis({
    config: testConfig(o.config),
    db: openDb(":memory:"),
    providers: { machines, blobs, keys, directory, deviceTokens, orgEnv: new FakeOrgEnv(o.orgFiles ?? ORG_FILES), forge: o.forge ?? null },
    dbKey: randomBytes(32).toString("base64"),
    sessionGateClientSecret: "gate-secret",
    clock,
    log: (m, e) => logs.push(`${m} ${JSON.stringify(e ?? {})}`),
    accessJwks: signer.jwks,
    snapshotPollMs: 1,
    snapshotTimeoutMs: 60_000,
    web: o.webDir ? new WebApp(o.webDir) : null,
    actionSecrets: o.actionSecrets ?? {},
  });
  await new Promise<void>((r) => jarvis.server.listen(0, "127.0.0.1", () => r()));
  const port = (jarvis.server.address() as AddressInfo).port;
  return {
    jarvis,
    clock,
    signer,
    machines,
    blobs,
    keys,
    directory,
    deviceTokens,
    logs,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    close: async () => {
      await jarvis.settle();
      await jarvis.close();
    },
  };
}

/** Standard cast: admin, two staff, a suspended staff member. Returns their emails. */
export async function seedUsers(h: Harness) {
  const admin = "admin@example.org", alice = "alice@example.org", bob = "bob@example.org", sus = "sam@example.org";
  h.directory.set(admin, { name: "Admin", groups: ["jarvis-admin@example.org"] });
  h.directory.set(alice, { name: "Alice", groups: ["jarvis-staff@example.org"] });
  h.directory.set(bob, { name: "Bob", groups: ["jarvis-staff@example.org"] });
  h.directory.set(sus, { name: "Sam", groups: ["jarvis-staff@example.org"] });
  const r = await h.jarvis.syncDirectory();
  if (!r.ok) throw new Error(r.error || "sync failed");
  return { admin, alice, bob, sus };
}

export interface Cred {
  jwt?: string;
  bearer?: string;
}

export async function asEmail(h: Harness, email: string): Promise<Cred> {
  return { jwt: await h.signer.sign({ email, sub: `sub-${email}`, type: "app" }) };
}
export async function asService(h: Harness, clientId: string, bearer?: string): Promise<Cred> {
  return { jwt: await h.signer.sign({ common_name: clientId, sub: "", type: "app" }), ...(bearer ? { bearer } : {}) };
}

export interface Resp<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function call<T = any>(h: Harness, cred: Cred | null, method: string, path: string, body?: unknown): Promise<Resp<T>> {
  const headers: Record<string, string> = {};
  if (cred?.jwt) headers["cf-access-jwt-assertion"] = cred.jwt;
  if (cred?.bearer) headers.authorization = `Bearer ${cred.bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(h.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* raw */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

/** Open a WebSocket; resolves with the socket or rejects with the HTTP status of a refusal. */
export function openWs(h: Harness, cred: Cred | null, path: string, protocols: string[] = []): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (cred?.jwt) headers["cf-access-jwt-assertion"] = cred.jwt;
    if (cred?.bearer) headers.authorization = `Bearer ${cred.bearer}`;
    const ws = new WebSocket(h.wsBase + path, protocols, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => {
      reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode }));
      ws.terminate();
    });
    ws.once("error", (e) => reject(e));
  });
}

export const nextMessage = (ws: WebSocket, ms = 2000): Promise<string> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for a message")), ms);
    ws.once("message", (d) => {
      clearTimeout(t);
      resolve(d.toString());
    });
  });

export const closed = (ws: WebSocket, ms = 2000): Promise<{ code: number; reason: string }> =>
  new Promise((resolve, reject) => {
    if (ws.readyState === ws.CLOSED) return resolve({ code: 0, reason: "" });
    const t = setTimeout(() => reject(new Error("timeout waiting for close")), ms);
    ws.once("close", (code, reason) => {
      clearTimeout(t);
      resolve({ code, reason: reason.toString() });
    });
  });

/** The session token a fake machine was given (from its env). */
export function sessionTokenOf(h: Harness, taskId: string): string {
  for (const m of h.machines.machines.values()) if (m.env.JARVIS_TASK_ID === taskId) return m.env.JARVIS_SESSION_TOKEN!;
  throw new Error(`no machine for task ${taskId}`);
}
export function machineOf(h: Harness, taskId: string) {
  for (const m of h.machines.machines.values()) if (m.env.JARVIS_TASK_ID === taskId) return m;
  return null;
}

/** Create a task as `email` and wait for its machine. */
export async function createTask(h: Harness, email: string, prompt = "Do the thing"): Promise<string> {
  const r = await call(h, await asEmail(h, email), "POST", "/api/tasks", { prompt });
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
  await h.jarvis.settle();
  return r.body.id as string;
}

/**
 * A fake session: dials the channel with the task's session token and plays the channel agent,
 * connecting each ws-open to a local echo "daemon" that records what it was given.
 */
export async function fakeSession(h: Harness, taskId: string) {
  const token = sessionTokenOf(h, taskId);
  const ws = await openWs(h, await asService(h, GATE, token), "/api/session/channel");
  const opened: { path: string; protocols: string[] }[] = [];
  const http: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  const cancelled: string[] = [];
  const pw = machineOf(h, taskId)?.env.PASEO_PASSWORD;
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "http-req") {
      const body = f.body_b64 ? Buffer.from(f.body_b64, "base64").toString() : "";
      http.push({ method: f.method, path: f.path, headers: f.headers, body });
      if (f.path.startsWith("/hang")) return; // never answers
      const send = (o: object) => ws.send(JSON.stringify({ id: f.id, ...o }));
      send({ type: "http-res", status: 200, headers: { "Content-Type": "text/html", "X-Daemon-Secret": "leak", "Content-Disposition": 'inline; filename="a.html"', "Set-Cookie": "x=1" } });
      send({ type: "http-data", data_b64: Buffer.from(`${f.method} ${f.path} auth-ok=${f.headers.authorization === `Bearer ${pw}`}`).toString("base64") });
      send({ type: "http-data", data_b64: Buffer.from(` body=${body}`).toString("base64") });
      send({ type: "http-end" });
    } else if (f.type === "http-cancel") {
      cancelled.push(f.id);
    } else if (f.type === "ws-open") {
      opened.push({ path: f.path, protocols: f.protocols });
    } else if (f.type === "ws-msg") {
      if (f.data_b64) ws.send(JSON.stringify({ type: "ws-msg", id: f.id, data_b64: f.data_b64 }));
      else ws.send(JSON.stringify({ type: "ws-msg", id: f.id, text: `echo:${f.text}` }));
    }
  });
  // wait until the server has registered the channel
  for (let i = 0; i < 100 && !h.jarvis.ctx.hub.isConnected(taskId); i++) await new Promise((r) => setTimeout(r, 5));
  return { ws, token, opened, http, cancelled };
}
