// jarvis-agent: the session machine's supervisor, run as root by jarvis-boot (after a restore).
//
//   1. layers   GET /api/session/bundle + /api/session/org-env.tar -> ~/org (read-only), the
//               instructions file, skills and opencode.json (lib/assemble.mjs)
//   2. daemon   the Paseo daemon as the unprivileged user `jarvis`, in a restart loop, with only
//               what it needs in its env (no session token, no gate secret)
//   3. channel  the reverse channel to the server, relaying the app's sockets to the daemon
//   4. prompt   the first prompt (create only) becomes the task's main agent
//   5. status   busy / idle (+ the main agent's id and title) to POST /api/session/status on change
//   6. local    a unix socket for in-machine helpers: jarvis-remember posts notes through it, jarvis-files
//               and jarvis-search reach the owner's files and transcripts through it, the
//               OpenCode policy plugin (lib/opencode-plugin.mjs) files approvals and waits on
//               them, jarvis-wakeup / jarvis-post (and the plugin's tools) arm wakeups and post
//               to the task's channel, and the web tools (web_search, web_fetch, jarvis-web) go
//               to the server's metered Tier 0 routes, so the session token never enters the
//               agent's shell
//   7. proxy    the Tier 0 local proxy on 127.0.0.1:3128 (lib/proxy.mjs), when the instance has one
//   8. files    at boot, the owner's files -> ~/files (newest first, up to JARVIS_FILES_SYNC_BYTES);
//               the first prompt's attachments -> ~/workspace/attachments/
//   9. search   the agents' timelines -> POST /api/session/transcript (lib/transcript.mjs), so the
//               owner can search this conversation from the app
//  10. inbox    wakeup prompts the server queued for this task go to the main agent as one new
//               message, once it is not mid-turn (lib/wakeups.mjs)
//
// Config comes from the env the server sets (docs/API.md section 10).
import { spawn, spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { createPaseoClient } from "@getpaseo/client";
import WebSocket from "ws";
import { writeLayers } from "./assemble.mjs";
import { startChannel, VERSION } from "./channel.mjs";
import { relayTunnel, startLocalProxy, subuserTunnel } from "./proxy.mjs";
import { syncAgent } from "./transcript.mjs";
import { InboxDelivery } from "./wakeups.mjs";

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
  files: join(HOME, "files"),
  attachments: join(HOME, "workspace", "attachments"),
  socket: join(RUN, "agent.sock"),
};
const DAEMON_PORT = Number(env.JARVIS_DAEMON_PORT || 6767);
const PROXY_PORT = Number(env.JARVIS_PROXY_PORT || 3128);
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const DAEMON_HTTP = `http://127.0.0.1:${DAEMON_PORT}`;

const SERVER = need("JARVIS_URL").replace(/\/$/, "");
const TOKEN = need("JARVIS_SESSION_TOKEN");
const MODEL = need("JARVIS_MODEL");
const PASSWORD = need("PASEO_PASSWORD");
const TIME_ZONE = env.JARVIS_TIME_ZONE || "UTC";
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

async function server(method, path, body, { retries = 0, raw = false, timeoutMs = 60_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(SERVER + path, {
        method,
        headers: { ...serverHeaders, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
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

let guards = [];
/** The task's Tier 0 tools (GET /api/session/tools); null when the server has none (or is older). */
let tools = null;

async function loadTools() {
  try {
    const v = await server("GET", "/api/session/tools", undefined, { retries: 4 });
    return v.search || v.fetch || v.proxy ? v : null;
  } catch (e) {
    log("no Tier 0 tools", { error: e.message });
    return null;
  }
}

async function loadLayers() {
  const bundle = await server("GET", "/api/session/bundle", undefined, { retries: 8 });
  guards = bundle.guards || [];
  tools = await loadTools();
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
    tools,
    proxyUrl: PROXY_URL,
    filesDir: P.files,
    images: env.JARVIS_MODEL_IMAGES === "1",
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
    // the owner's zone: `date` in the agent's shell, and jarvis-wakeup's default for wall-clock times
    TZ: TIME_ZONE,
    JARVIS_TIME_ZONE: TIME_ZONE,
    ...(env.OPENROUTER_BASE_URL ? { OPENROUTER_BASE_URL: env.OPENROUTER_BASE_URL } : {}),
    // the local proxy's address only; its upstream login (subuser) or the server's (relay) stays out
    ...(tools?.proxy ? { JARVIS_PROXY_URL: PROXY_URL } : {}),
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
  const { note, images } = await prepareAttachments();
  const text = prompt + note;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const c = await paseo();
      // images go to the model inline; if that keeps failing (a model without image input), without them
      const withImages = images.length > 0 && attempt < 3;
      log("creating the main agent", { attempt, attachments: note ? "yes" : "no", images: withImages ? images.length : 0 });
      const agent = await c.agents.create({ config: { provider: `opencode/openrouter/${MODEL}` }, cwd: P.workspace, prompt: text, ...(withImages ? { images } : {}) });
      writeFileSync(mainAgentFile(), agent.id);
      writeFileSync(marker, new Date().toISOString());
      chownR(P.jarvis);
      log("first prompt sent", { agent: agent.id, bytes: text.length });
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
  knownAgents = agents.map((a) => a.agent ?? a).filter((a) => !a.internal).map((a) => a.id);
  const list = agents.map((a) => a.agent ?? a).filter((a) => !a.archivedAt && !a.internal);
  const busy = firstPromptPending || list.some((a) => a.status === "running" || a.status === "initializing");
  const main = list.find((a) => a.id === mainAgent());
  const title = (main?.title || "").slice(0, 120);
  const agentId = mainAgent();
  const activity = busy ? "busy" : "idle";
  // the conversation into the search index: when the agents settle, and every 30 s while they work
  if ((activity === "idle" && reported.activity === "busy") || Date.now() - lastSync > TRANSCRIPT_EVERY_MS) void syncTranscripts(knownAgents);
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

// ---- 8. the owner's files and the first prompt's attachments ----------------------------------

const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
/** A path from the server, refused if it would leave `dir`. */
function inside(dir, p) {
  const full = resolve(dir, p);
  const rel = relative(dir, full);
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) throw new Error(`refusing path ${p}`);
  return full;
}

/** Download one of the owner's files to `dest` (as root; the caller chowns). */
async function downloadFile(path, dest, updatedAt) {
  const link = await server("GET", `/api/session/files/${encPath(path)}`, undefined, { retries: 3 });
  const r = await fetch(link.url, { signal: AbortSignal.timeout(600_000) });
  if (!r.ok) throw new Error(`download ${path} -> ${r.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  if (updatedAt) {
    const t = new Date(updatedAt);
    utimesSync(dest, t, t);
  }
}

let fileIndex = []; // the owner's files at boot: [{path, size, contentType, updatedAt, local}]

/** Boot: the owner's files -> ~/files, newest first, within the sync budget. Never fails the boot. */
async function pullFiles() {
  try {
    const list = await server("GET", "/api/session/files", undefined, { retries: 5 });
    const budget = Number(env.JARVIS_FILES_SYNC_BYTES || 256 * 1024 * 1024);
    let used = 0;
    rmSync(P.files, { recursive: true, force: true }); // a fresh copy every boot (not in the snapshot)
    mkdirSync(P.files, { recursive: true });
    fileIndex = [];
    for (const f of [...list.files].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      let local = false;
      if (used + f.size <= budget) {
        try {
          await downloadFile(f.path, inside(P.files, f.path), f.updatedAt);
          used += f.size;
          local = true;
        } catch (e) {
          log("file not downloaded", { path: f.path, error: e.message });
        }
      }
      fileIndex.push({ ...f, local });
    }
    chownR(P.files);
    log("files copied", { files: fileIndex.filter((f) => f.local).length, of: fileIndex.length, bytes: used });
  } catch (e) {
    log("files not copied", { error: e.message });
  }
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;
const MAX_INLINE_IMAGES = 5;

/**
 * The first prompt's attachments (JARVIS_ATTACHMENTS, paths in the owner's files) -> copies in
 * ~/workspace/attachments/, a note naming them for the prompt, and the images to send inline.
 */
async function prepareAttachments() {
  let paths = [];
  try {
    paths = JSON.parse(env.JARVIS_ATTACHMENTS || "[]");
  } catch {
    log("JARVIS_ATTACHMENTS is not JSON; ignored");
  }
  if (!Array.isArray(paths) || !paths.length) return { note: "", images: [] };
  mkdirSync(P.attachments, { recursive: true });
  const lines = [];
  const images = [];
  const taken = new Set();
  for (const p of paths) {
    const meta = fileIndex.find((f) => f.path === p);
    let name = basename(p);
    for (let i = 2; taken.has(name); i++) name = `${basename(p, extname(p))}-${i}${extname(p)}`;
    taken.add(name);
    const dest = join(P.attachments, name);
    try {
      const local = meta?.local ? inside(P.files, p) : null;
      if (local && existsSync(local)) copyFileSync(local, dest);
      else await downloadFile(p, dest, meta?.updatedAt);
      const size = statSync(dest).size;
      const type = meta?.contentType || "";
      lines.push(`- ${dest} (${type || "file"}, ${size} bytes; "${p}" in their files)`);
      // inline only for a model that takes images (else OpenCode answers "cannot read"); the file is there either way
      if (env.JARVIS_MODEL_IMAGES === "1" && IMAGE_TYPES.has(type) && size <= MAX_INLINE_IMAGE && images.length < MAX_INLINE_IMAGES) {
        images.push({ data: readFileSync(dest).toString("base64"), mimeType: type });
      }
    } catch (e) {
      log("attachment not copied", { path: p, error: e.message });
      lines.push(`- "${p}" could not be copied (${e.message.slice(0, 120)})`);
    }
  }
  chownR(P.attachments);
  const note = `\n\nThe user attached ${paths.length === 1 ? "a file" : `${paths.length} files`} to this message (copied into ${P.attachments}/):\n${lines.join("\n")}`;
  return { note, images };
}

/** Stream a request body (from a helper on the socket) to a server route, with its length. */
function serverPutStream(path, body, length, contentType) {
  const url = new URL(SERVER + path);
  return new Promise((resolvePut, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      { method: "PUT", headers: { ...serverHeaders, "content-length": String(length), "content-type": contentType || "application/octet-stream" }, timeout: 600_000 },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolvePut({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("upload timed out")));
    body.on("error", (e) => req.destroy(e));
    body.pipe(req);
  });
}

// ---- 9. transcript sync ----------------------------------------------------------------------------

const TRANSCRIPT_EVERY_MS = Number(env.JARVIS_TRANSCRIPT_MS || 30_000);
const held = new Map(); // agentId -> {epoch, lastSeq, lastEnd}
let heldLoaded = false;
let syncing = null;
let lastSync = 0;

/** Every agent's timeline -> the server. One run at a time; a failure is retried at the next one. */
function syncTranscripts(agentIds) {
  syncing ??= (async () => {
    try {
      if (!heldLoaded) {
        for (const a of (await server("GET", "/api/session/transcript")).agents) held.set(a.agentId, { epoch: a.epoch, lastSeq: a.lastSeq });
        heldLoaded = true;
      }
      const c = await paseo();
      for (const agentId of agentIds) {
        const h = c.agents.ref(agentId);
        try {
          const r = await syncAgent({
            agentId,
            held: held.get(agentId) ?? null,
            probe: () => h.timeline.refetch({ direction: "tail", limit: 1, projection: "projected" }),
            fetchPage: ({ cursor, limit }) => h.timeline.refetch({ direction: "after", cursor, limit, projection: "projected" }),
            post: (body) => server("POST", "/api/session/transcript", body, { retries: 2 }),
          });
          held.set(agentId, { epoch: r.epoch, lastSeq: r.lastSeq, lastEnd: r.lastEnd });
          if (r.sent) log("transcript synced", { agent: agentId, entries: r.sent });
        } catch (e) {
          log("transcript sync failed", { agent: agentId, error: e.message });
        }
      }
    } catch (e) {
      log("transcript sync failed", { error: e.message });
    } finally {
      lastSync = Date.now();
      syncing = null;
    }
  })();
  return syncing;
}

let knownAgents = [];
async function syncNow() {
  try {
    knownAgents = ((await (await paseo()).agents.list()).entries ?? []).map((a) => a.agent ?? a).filter((a) => !a.internal).map((a) => a.id);
  } catch {
    /* keep the last list */
  }
  await syncTranscripts(knownAgents);
}

// ---- 6. local helpers socket ------------------------------------------------------------------

function localApi() {
  mkdirSync(RUN, { recursive: true });
  rmSync(P.socket, { force: true });
  const srv = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const u0 = new URL(req.url, "http://local");
    // jarvis-files save: the body (the file, read by the agent's own user) streams through to the server
    if (req.method === "PUT" && u0.pathname.startsWith("/files/")) {
      const length = Number(req.headers["content-length"]);
      if (!Number.isFinite(length)) return reply(400, { error: { code: "bad_request", message: "a Content-Length is needed" } });
      try {
        const path = decodeURIComponent(u0.pathname.slice("/files/".length));
        const r = await serverPutStream(`/api/session/files/${encPath(path)}`, req, length, req.headers["content-type"]);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.text);
        if (r.status < 300) log("file saved", { path, bytes: length });
      } catch (e) {
        reply(502, { error: { code: "upstream", message: `the Jarvis server is unreachable: ${e.message}` } });
      }
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
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
    // the policy plugin: guards, the action catalogue, filing a request and waiting on it
    const forward = async (method, path, body, okStatus, timeoutMs) => {
      try {
        return reply(okStatus ?? (method === "POST" ? 201 : 200), await server(method, path, body, timeoutMs ? { timeoutMs } : {}));
      } catch (e) {
        if (!e.status) return reply(502, { error: { code: "upstream", message: `the Jarvis server is unreachable: ${e.message}` } });
        let b = e.body;
        try {
          b = JSON.parse(e.body);
        } catch {
          /* text */
        }
        return reply(e.status, b);
      }
    };
    const url = new URL(req.url, "http://local");
    if (req.method === "GET" && url.pathname === "/guards") return reply(200, { guards });
    // Tier 0 web tools: metered by the server against the task owner's allowance
    if (req.method === "GET" && url.pathname === "/tools") return forward("GET", "/api/session/tools");
    if (req.method === "POST" && (url.pathname === "/tools/search" || url.pathname === "/tools/fetch")) {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      } catch {
        return reply(400, { error: { code: "bad_request", message: "body must be JSON" } });
      }
      // a rendered fetch can take a while; Cloudflare cuts a proxied request at 100 s
      const r = await forward("POST", `/api/session${url.pathname}`, body, 200, 100_000);
      log(`web ${url.pathname.slice(7)}`, { status: res.statusCode });
      return r;
    }
    // jarvis-files
    if (req.method === "GET" && url.pathname === "/files") {
      try {
        const list = await server("GET", "/api/session/files");
        const files = list.files.map((f) => {
          let local = false;
          try {
            local = statSync(inside(P.files, f.path)).size === f.size;
          } catch {
            /* not on disk */
          }
          return { ...f, local };
        });
        return reply(200, { ...list, files, dir: P.files });
      } catch (e) {
        return reply(e.status || 502, { error: { code: "upstream", message: e.message } });
      }
    }
    if (req.method === "POST" && url.pathname === "/files/get") {
      let path = "";
      try {
        path = String(JSON.parse(Buffer.concat(chunks).toString()).path || "");
        const dest = inside(P.files, path);
        await downloadFile(path, dest);
        chownR(P.files);
        return reply(200, { path, local: dest });
      } catch (e) {
        return reply(e.status || 502, { error: { code: e.status === 404 ? "not_found" : "upstream", message: e.status === 404 ? `no file "${path}" in the user's files` : e.message } });
      }
    }
    // jarvis-search
    if (req.method === "GET" && url.pathname === "/search") return forward("GET", `/api/session/search?${url.searchParams}`);
    const tm = /^\/tasks\/([A-Za-z0-9_-]{1,64})\/transcript$/.exec(url.pathname);
    if (req.method === "GET" && tm) return forward("GET", `/api/session/tasks/${tm[1]}/transcript?${url.searchParams}`);
    // jarvis-snapshot, before it packs: the conversation so far into the search index
    if (req.method === "POST" && url.pathname === "/transcript-sync") {
      await Promise.race([syncNow(), sleep(25_000)]);
      return reply(200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/actions") return forward("GET", "/api/session/actions");
    if (req.method === "POST" && url.pathname === "/approvals") {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return reply(400, { error: { code: "bad_request", message: "body must be JSON" } });
      }
      log("approval requested", { kind: body?.kind, action: body?.action ?? body?.rule ?? null });
      return forward("POST", "/api/session/approvals", body);
    }
    // wakeups and channel posts (jarvis-wakeup, jarvis-post, the plugin's tools)
    if (url.pathname === "/wakeups" && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "GET") return forward("GET", "/api/session/wakeups");
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return reply(400, { error: { code: "bad_request", message: "body must be JSON" } });
      }
      log("wakeup armed", { name: body?.name ?? "default" });
      return forward("POST", "/api/session/wakeups", body);
    }
    const wm = /^\/wakeups\/([A-Za-z0-9_-]{1,40})$/.exec(url.pathname);
    if (req.method === "DELETE" && wm) return forward("DELETE", `/api/session/wakeups/${wm[1]}`);
    if (req.method === "POST" && url.pathname === "/posts") {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        return reply(400, { error: { code: "bad_request", message: "body must be JSON" } });
      }
      return forward("POST", "/api/session/posts", body);
    }
    const m = /^\/approvals\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const wait = Math.max(0, Math.min(55, Number(url.searchParams.get("wait") || 0) || 0));
      return forward("GET", `/api/session/approvals/${m[1]}?wait=${wait}`);
    }
    reply(404, { error: "no such route" });
  });
  srv.listen(P.socket, () => chmodSync(P.socket, 0o666));
  return srv;
}

// ---- 7. the Tier 0 local proxy ------------------------------------------------------------------

async function startProxy() {
  if (!tools?.proxy) return null;
  let open;
  if (tools.proxy === "subuser") {
    let up;
    try {
      up = JSON.parse(env.JARVIS_PROXY || "");
    } catch {
      log("no proxy sub-account in this machine (JARVIS_PROXY); the local proxy stays off");
      return null;
    }
    open = subuserTunnel(up);
  } else {
    open = relayTunnel({ serverWs: SERVER.replace(/^http/, "ws"), headers: serverHeaders });
  }
  try {
    const srv = await startLocalProxy({ open, port: PROXY_PORT, log });
    log("local proxy listening", { url: PROXY_URL, mode: tools.proxy });
    return srv;
  } catch (e) {
    log("local proxy failed to start", { error: e.message });
    return null;
  }
}

// ---- 10. inbox --------------------------------------------------------------------------------

function deliveredStore() {
  const file = join(P.jarvis, "inbox-delivered");
  const ids = new Set(existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  return {
    has: (id) => ids.has(id),
    add(list) {
      for (const id of list) ids.add(id);
      // kept in the snapshot, so a resumed machine doesn't deliver a message twice
      writeFileSync(file, [...ids].slice(-500).join("\n") + "\n");
      chownR(file);
    },
  };
}

async function mainAgentState() {
  const c = await paseo();
  const list = ((await c.agents.list()).entries ?? []).map((a) => a.agent ?? a).filter((a) => !a.archivedAt);
  const main = list.find((a) => a.id === mainAgent());
  if (!main) return { exists: false, busy: false };
  const busy = main.status === "running" || main.status === "initializing" || (Array.isArray(main.pendingPermissions) && main.pendingPermissions.length > 0);
  return { exists: true, busy };
}

async function sendToMainAgent(text) {
  const c = await paseo();
  const s = await mainAgentState();
  if (s.exists) {
    await c.agents.ref(mainAgent()).send(text);
    return;
  }
  // no main agent (it was archived, or the first prompt never made one): the message starts one
  const agent = await c.agents.create({ config: { provider: `opencode/openrouter/${MODEL}` }, cwd: P.workspace, prompt: text });
  writeFileSync(mainAgentFile(), agent.id);
  chownR(P.jarvis);
  log("a wakeup made a new main agent", { agent: agent.id });
}

function startInbox() {
  const d = new InboxDelivery({
    fetchInbox: async (wait) => (await server("GET", `/api/session/inbox?wait=${wait}`)).messages,
    ack: (id) => server("POST", `/api/session/inbox/${encodeURIComponent(id)}/ack`, {}, { retries: 3 }),
    agentState: async () => {
      try {
        return await mainAgentState();
      } catch (e) {
        dropClient();
        throw e;
      }
    },
    send: async (text) => {
      try {
        await sendToMainAgent(text);
      } catch (e) {
        dropClient();
        throw e;
      }
      void statusTick(true);
    },
    delivered: deliveredStore(),
    sleep,
    log,
  });
  void d.run();
  return d;
}

// ---- main ---------------------------------------------------------------------------------------

async function main() {
  log("jarvis-agent starting", { version: VERSION, task: env.JARVIS_TASK_ID, model: MODEL });
  await loadLayers();
  await pullFiles();
  const local = localApi();
  const proxy = await startProxy();
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
  const inbox = startInbox();
  const timer = setInterval(() => void statusTick(), Number(env.JARVIS_STATUS_MS || 3000));
  await statusTick();

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    clearInterval(timer);
    inbox.stop();
    channel.stop();
    local.close();
    proxy?.close();
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
