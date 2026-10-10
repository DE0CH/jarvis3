// jarvis-agent: the session machine's supervisor, run as root by jarvis-boot (after a restore).
//
//   1. layers   GET /api/session/bundle + /api/session/org-env.tar -> ~/org (read-only), the
//               instructions file, skills and opencode.json (lib/assemble.mjs)
//   2. daemon   the Paseo daemon as the unprivileged user `jarvis`, in a restart loop, with only
//               what it needs in its env (no session token, no gate secret)
//   3. channel  the reverse channel to the server, relaying the app's sockets to the daemon
//   4. prompt   the first prompt (create only) becomes the task's main agent
//   5. status   busy / idle (+ the main agent's id and title) to POST /api/session/status on change
//   6. local    a unix socket for in-machine helpers: jarvis-remember posts notes through it, so
//               the session token never enters the agent's shell
//
// Config comes from the env the server sets (docs/API.md section 10).
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import WebSocket from "ws";
import { writeLayers } from "./assemble.mjs";
import { startChannel, VERSION } from "./channel.mjs";

const env = process.env;
const need = (k) => {
  if (!env[k]) {
    log(`missing env ${k}`);
    process.exit(2);
  }
  return env[k];
};
function log(msg, extra = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));
}

const HOME = env.JARVIS_HOME || "/home/jarvis";
const USER = env.JARVIS_USER || "jarvis";
const RUN = env.JARVIS_RUN_DIR || "/run/jarvis";
const P = {
  workspace: join(HOME, "workspace"),
  org: join(HOME, "org"),
  jarvis: join(HOME, ".jarvis"),
  paseo: join(HOME, ".paseo"),
  opencodeConfig: join(HOME, ".config", "opencode", "opencode.json"),
  socket: join(RUN, "agent.sock"),
};
const DAEMON_PORT = Number(env.JARVIS_DAEMON_PORT || 6767);
const DAEMON_HTTP = `http://127.0.0.1:${DAEMON_PORT}`;

const SERVER = need("JARVIS_URL").replace(/\/$/, "");
const TOKEN = need("JARVIS_SESSION_TOKEN");
const MODEL = need("JARVIS_MODEL");
const PASSWORD = need("PASEO_PASSWORD");
const DAEMON_PATH = env.JARVIS_DAEMON_PATH || "/ws";
const serverHeaders = {
  "CF-Access-Client-Id": need("CF_ACCESS_CLIENT_ID"),
  "CF-Access-Client-Secret": need("CF_ACCESS_CLIENT_SECRET"),
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": VERSION,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ids = () => {
  const r = spawnSync("id", ["-u", USER]);
  const g = spawnSync("id", ["-g", USER]);
  return { uid: Number(r.stdout.toString().trim()), gid: Number(g.stdout.toString().trim()) };
};
const chownR = (p) => spawnSync("chown", ["-R", `${USER}:${USER}`, p]);

// ---- server calls ------------------------------------------------------------------------------

async function server(method, path, body, { retries = 0, raw = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(SERVER + path, {
        method,
        headers: { ...serverHeaders, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (r.ok) return raw ? Buffer.from(await r.arrayBuffer()) : await r.json();
      const text = await r.text();
      const err = Object.assign(new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 200)}`), { status: r.status, body: text });
      if (attempt >= retries || (r.status >= 400 && r.status < 500 && r.status !== 429)) throw err;
      log("server call failed; retrying", { error: err.message });
    } catch (e) {
      if (e.status || attempt >= retries) throw e;
      log("server unreachable; retrying", { path, error: e.message });
    }
    await sleep(Math.min(2000 * 2 ** attempt, 30_000));
  }
}

// ---- 1. layers ---------------------------------------------------------------------------------

async function loadLayers() {
  const bundle = await server("GET", "/api/session/bundle", undefined, { retries: 8 });
  const tar = await server("GET", "/api/session/org-env.tar", undefined, { retries: 8, raw: true });
  rmSync(P.org, { recursive: true, force: true });
  mkdirSync(P.org, { recursive: true });
  const x = spawnSync("tar", ["-x", "--no-same-owner", "--no-same-permissions", "-C", P.org], { input: tar });
  if (x.status !== 0) throw new Error(`org-env tar: ${x.stderr.toString().slice(0, 200)}`);
  spawnSync("chmod", ["-R", "a+rX,go-w,u-w", P.org]); // readable by the agent, writable by nobody but root
  for (const d of [P.workspace, P.jarvis, P.paseo]) mkdirSync(d, { recursive: true });
  const out = writeLayers(bundle, {
    jarvisDir: P.jarvis,
    workspace: P.workspace,
    orgDir: P.org,
    model: MODEL,
    baseUrl: env.OPENROUTER_BASE_URL || "",
    opencodeConfigPath: P.opencodeConfig,
  });
  chownR(P.jarvis);
  chownR(join(HOME, ".config"));
  chownR(P.workspace);
  chownR(P.paseo);
  log("layers written", { commit: bundle.orgEnvCommit, role: bundle.role, instructions: bundle.instructions.map((i) => `${i.layer}:${i.source}`), skills: bundle.skills.map((s) => s.name), deny: bundle.deny.length });
  return out;
}

// ---- 2. daemon ---------------------------------------------------------------------------------

let daemon = null;
let stopping = false;
function daemonEnv() {
  return {
    HOME,
    USER,
    LOGNAME: USER,
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    SHELL: "/bin/bash",
    PASEO_HOME: P.paseo,
    PASEO_LISTEN: `127.0.0.1:${DAEMON_PORT}`,
    PASEO_PASSWORD: PASSWORD,
    PASEO_RELAY_ENABLED: "false",
    PASEO_WEB_UI_ENABLED: "false",
    PASEO_DICTATION_ENABLED: "false",
    PASEO_VOICE_MODE_ENABLED: "false",
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY || "",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    ...(env.OPENROUTER_BASE_URL ? { OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL } : {}),
  };
}
/**
 * OpenCode's first start in a fresh home does one-off setup (its database, caches) and Paseo gives
 * an OpenCode server only 30 s to come up; on a slow shared CPU the first start can miss that. One
 * throwaway run before the daemon starts takes the one-off cost out of the daemon's path.
 */
function warmOpencode() {
  const { uid, gid } = ids();
  const t = Date.now();
  const r = spawnSync("opencode", ["debug", "config"], { cwd: P.workspace, uid, gid, env: daemonEnv(), stdio: "ignore", timeout: 180_000 });
  log("OpenCode warmed up", { ms: Date.now() - t, status: r.status });
}

function runDaemon() {
  const { uid, gid } = ids();
  // A restored snapshot carries the old machine's pid lock; its pid can be alive here as another
  // process, and the daemon then exits as "already running".
  rmSync(join(P.paseo, "paseo.pid"), { force: true });
  const start = () => {
    if (stopping) return;
    log("starting the Paseo daemon");
    daemon = spawn("paseo", ["daemon", "run", "--home", P.paseo], { cwd: P.workspace, uid, gid, env: daemonEnv(), stdio: ["ignore", "inherit", "inherit"] });
    daemon.on("exit", (code, sig) => {
      daemon = null;
      if (stopping) return;
      log("Paseo daemon exited; restarting", { code, sig });
      setTimeout(start, 3000);
    });
  };
  start();
}
async function waitDaemon(timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(DAEMON_HTTP + "/api/health", { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {
      /* not yet */
    }
    await sleep(1000);
  }
  return false;
}

// ---- 4 + 5. first prompt and status, over one local client connection -----------------------

let client = null; // a promise of one connected client, shared by the first prompt and the status loop
function paseo() {
  client ??= (async () => {
    const c = createPaseoClient({ url: `ws://127.0.0.1:${DAEMON_PORT}${DAEMON_PATH}`, password: PASSWORD, webSocketFactory: (url, o) => new WebSocket(url, o?.protocols, { headers: o?.headers }) });
    try {
      await c.connect();
    } catch (e) {
      c.close().catch(() => {});
      throw e;
    }
    return c;
  })().catch((e) => {
    client = null;
    throw e;
  });
  return client;
}
function dropClient() {
  const p = client;
  client = null;
  p?.then((c) => c.close()).catch(() => {});
}

async function waitDaemonAccepting(timeoutMs = 240_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      await paseo();
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

const mainAgentFile = () => join(P.jarvis, "main-agent");
const mainAgent = () => (existsSync(mainAgentFile()) ? readFileSync(mainAgentFile(), "utf8").trim() : "");

async function sendFirstPrompt() {
  const prompt = env.JARVIS_FIRST_PROMPT;
  const marker = join(P.jarvis, "first-prompt-sent");
  if (!prompt || existsSync(marker)) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const c = await paseo();
      log("creating the main agent", { attempt });
      const agent = await c.agents.create({ config: { provider: `opencode/openrouter/${MODEL}` }, cwd: P.workspace, prompt });
      writeFileSync(mainAgentFile(), agent.id);
      writeFileSync(marker, new Date().toISOString());
      chownR(P.jarvis);
      log("first prompt sent", { agent: agent.id, bytes: prompt.length });
      return;
    } catch (e) {
      log("first prompt failed; retrying", { error: e.message });
      dropClient();
      await sleep(3000 * (attempt + 1));
    }
  }
  log("first prompt NOT sent");
}

let reported = { activity: "", title: "", agentId: "" };
let firstPromptPending = !!env.JARVIS_FIRST_PROMPT;
async function statusTick(force = false) {
  let agents;
  try {
    agents = (await (await paseo()).agents.list()).entries ?? [];
  } catch (e) {
    dropClient();
    return;
  }
  const list = agents.map((a) => a.agent ?? a).filter((a) => !a.archivedAt && !a.internal);
  const busy = firstPromptPending || list.some((a) => a.status === "running" || a.status === "initializing");
  const main = list.find((a) => a.id === mainAgent());
  const title = (main?.title || "").slice(0, 120);
  const agentId = mainAgent();
  const activity = busy ? "busy" : "idle";
  if (!force && activity === reported.activity && title === reported.title && agentId === reported.agentId) return;
  try {
    await server("POST", "/api/session/status", {
      activity,
      ...(title && title !== reported.title ? { title } : {}),
      ...(agentId && (force || agentId !== reported.agentId) ? { agentId } : {}),
    });
    reported = { activity, title, agentId };
    log("status reported", { activity, title, agentId });
  } catch (e) {
    log("status report failed", { error: e.message });
  }
}

// ---- 6. local helpers socket ------------------------------------------------------------------

function localApi() {
  mkdirSync(RUN, { recursive: true });
  rmSync(P.socket, { force: true });
  const srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/remember") {
      let text = "";
      try {
        text = String(JSON.parse(Buffer.concat(chunks).toString()).text || "");
      } catch {
        return reply(400, { error: "body must be {\"text\": \"…\"}" });
      }
      try {
        const note = await server("POST", "/api/session/notes", { text }, { retries: 3 });
        log("note saved", { id: note.id });
        return reply(201, note);
      } catch (e) {
        return reply(e.status || 502, { error: e.message });
      }
    }
    reply(404, { error: "no such route" });
  });
  srv.listen(P.socket, () => chmodSync(P.socket, 0o666));
  return srv;
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  log("jarvis-agent starting", { version: VERSION, task: env.JARVIS_TASK_ID, model: MODEL });
  await loadLayers();
  const local = localApi();
  warmOpencode();
  runDaemon();
  if (!(await waitDaemon())) log("the Paseo daemon did not come up in time; carrying on");
  // /api/health answers before the daemon accepts WebSockets (it restores its agents first, and
  // answers 503 meanwhile): dial in only once a client gets through, so the app's first socket
  // through the server isn't refused.
  if (!(await waitDaemonAccepting())) log("the Paseo daemon does not accept connections yet; carrying on");
  const channel = startChannel({
    url: SERVER.replace(/^http/, "ws") + "/api/session/channel",
    headers: serverHeaders,
    daemonBase: `ws://127.0.0.1:${DAEMON_PORT}`,
    log,
    onConnect: () => void statusTick(true),
  });
  await sendFirstPrompt();
  firstPromptPending = false;
  const timer = setInterval(() => void statusTick(), Number(env.JARVIS_STATUS_MS || 3000));
  await statusTick();

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    clearInterval(timer);
    channel.stop();
    local.close();
    dropClient();
    daemon?.kill("SIGTERM");
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  log("jarvis-agent failed", { error: e.message });
  process.exit(1);
});
