// The session side of the reverse channel (docs/API.md section 9; the server side is
// server/src/channel.ts). One WebSocket out to wss://<instance>/api/session/channel; the server
// sends ws-open for every app connection to the task's daemon, and this relays the stream to the
// local Paseo daemon: text frames as text, binary as base64. Ported from Jarvis 1's
// cf-tunnel/agent.js, WebSocket streams only (no HTTP requests travel over this channel).
import WebSocket from "ws";

export const VERSION = "jarvis3-session/0.1.0";

/**
 * @param {object} o
 * @param {string} o.url            wss://… or ws://…/api/session/channel
 * @param {Record<string,string>} o.headers  gate token + session bearer
 * @param {string} o.daemonBase     ws://127.0.0.1:6767
 * @param {(m: string, e?: object) => void} [o.log]
 * @param {() => void} [o.onConnect]
 * @param {number} [o.pingMs]       default 30 s (the contract)
 */
export function startChannel(o) {
  const log = o.log || (() => {});
  const pingMs = o.pingMs ?? 30_000;
  let ws = null;
  let stopped = false;
  let backoff = 1000;
  let pinger = null;
  /** stream id -> { local: WebSocket, queue: (string|Buffer)[] } */
  const streams = new Map();

  const send = (f) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f));
  };

  const closeStream = (id, code, reason) => {
    const s = streams.get(id);
    if (!s) return;
    streams.delete(id);
    try {
      s.local.close(code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000, String(reason || "").slice(0, 120));
    } catch {
      s.local.terminate();
    }
  };

  const openStream = (f) => {
    if (typeof f.path !== "string" || !f.path.startsWith("/")) {
      send({ type: "ws-close", id: f.id, code: 1008, reason: "bad path" });
      return;
    }
    let local;
    try {
      local = new WebSocket(o.daemonBase + f.path, Array.isArray(f.protocols) ? f.protocols : [], { headers: f.headers || {} });
    } catch (e) {
      send({ type: "ws-close", id: f.id, code: 1011, reason: "session: " + e.message });
      return;
    }
    const s = { local, queue: [] };
    streams.set(f.id, s);
    local.on("open", () => {
      for (const m of s.queue) local.send(m, { binary: Buffer.isBuffer(m) });
      s.queue = [];
    });
    local.on("message", (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      send(isBinary ? { type: "ws-msg", id: f.id, data_b64: buf.toString("base64") } : { type: "ws-msg", id: f.id, text: buf.toString("utf8") });
    });
    local.on("close", (code, reason) => {
      if (streams.get(f.id) === s) {
        streams.delete(f.id);
        send({ type: "ws-close", id: f.id, code, reason: reason.toString() });
      }
    });
    local.on("unexpected-response", (_req, res) => {
      if (streams.get(f.id) === s) {
        streams.delete(f.id);
        send({ type: "ws-close", id: f.id, code: 1011, reason: `daemon refused: ${res.statusCode}` });
      }
      local.terminate();
    });
    local.on("error", (e) => {
      if (streams.get(f.id) === s) {
        streams.delete(f.id);
        send({ type: "ws-close", id: f.id, code: 1011, reason: "daemon: " + e.message });
      }
    });
  };

  const onFrame = (raw) => {
    let f;
    try {
      f = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (f.type === "ws-open") return openStream(f);
    if (f.type === "ws-msg") {
      const s = streams.get(f.id);
      if (!s) return;
      const m = typeof f.data_b64 === "string" ? Buffer.from(f.data_b64, "base64") : String(f.text ?? "");
      if (s.local.readyState === WebSocket.OPEN) s.local.send(m, { binary: Buffer.isBuffer(m) });
      else s.queue.push(m);
      return;
    }
    if (f.type === "ws-close") return closeStream(f.id, f.code, f.reason);
    // pong: nothing to do
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(o.url, { headers: o.headers, handshakeTimeout: 15_000 });
    ws = sock;
    sock.on("open", () => {
      backoff = 1000;
      log("channel connected");
      sock.send(JSON.stringify({ type: "hello", agent: VERSION }));
      pinger = setInterval(() => send({ type: "ping" }), pingMs);
      o.onConnect?.();
    });
    sock.on("message", onFrame);
    sock.on("unexpected-response", (_req, res) => {
      log("channel refused", { status: res.statusCode });
      sock.terminate();
    });
    sock.on("error", (e) => log("channel error", { error: e.message }));
    sock.on("close", (code) => {
      clearInterval(pinger);
      for (const id of [...streams.keys()]) closeStream(id, 1001, "channel closed");
      if (ws === sock) ws = null;
      if (stopped) return;
      log("channel closed; reconnecting", { code, inMs: backoff });
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };
  connect();

  return {
    get connected() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
    get streams() {
      return streams.size;
    },
    stop() {
      stopped = true;
      clearInterval(pinger);
      for (const id of [...streams.keys()]) closeStream(id, 1001, "session stopping");
      ws?.close(1001, "session stopping");
    },
  };
}
