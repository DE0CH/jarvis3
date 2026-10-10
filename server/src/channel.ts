// The session reverse channel and the daemon proxy.
//
// A session machine dials OUT to wss://<instance>/api/session/channel with its session token and
// keeps that socket open (the cf-tunnel agent idea from Jarvis 1, ending at this server instead of
// a Cloudflare Worker). When the app opens wss://<instance>/api/tasks/:id/daemon, the server
// (after authorize) sends `ws-open` down the task's channel; the session's agent opens the same
// path on its local Paseo daemon and frames are relayed both ways (text as-is, binary as base64).
// The server puts the daemon password into the forwarded subprotocols; the client never sees it.
//
// The HTTP relay (/api/tasks/:id/daemon/http/*) travels the same channel: `http-req` down, then
// `http-res` (status + headers), `http-data` chunks and `http-end` back. The server adds the
// daemon password as a bearer, passes through only a short list of response headers, and makes
// every response a sandboxed download (see relayResponseHeaders): what a daemon serves is the
// agent's output and must never run as a page on the instance's origin.
import type { ServerResponse } from "node:http";
import type { WebSocket, RawData } from "ws";
import type { ServerToSessionFrame, SessionToServerFrame } from "./api-types.ts";
import { randomId } from "./crypto.ts";

const BEARER_PREFIX = "paseo.bearer.";

interface Stream {
  id: string;
  taskId: string;
  userId: string;
  client: WebSocket;
}

interface HttpStream {
  id: string;
  userId: string;
  res: ServerResponse;
  timer: NodeJS.Timeout | null;
}

interface SessionConn {
  ws: WebSocket;
  streams: Map<string, Stream>;
  http: Map<string, HttpStream>;
}

export interface HttpRelayRequest {
  method: string;
  /** Path and query on the daemon, starting with "/". */
  path: string;
  headers: Record<string, string>;
  body: Buffer | null;
}

/** Request headers the relay passes to the daemon (the server adds authorization itself). */
const FORWARD_REQUEST_HEADERS = ["content-type", "accept", "range", "if-none-match", "if-modified-since", "if-range"];
/** Response headers the relay passes back to the app. */
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges", "etag", "last-modified"];

export function relayRequestHeaders(incoming: Record<string, string | string[] | undefined>, daemonPassword: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of FORWARD_REQUEST_HEADERS) {
    const v = incoming[k];
    if (typeof v === "string") out[k] = v;
  }
  out.authorization = `Bearer ${daemonPassword}`;
  return out;
}

/** Only known headers, always a download, never a page that runs on the instance's origin. */
export function relayResponseHeaders(fromDaemon: Record<string, string>): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(fromDaemon || {})) if (typeof v === "string") lower[k.toLowerCase()] = v;
  const out: Record<string, string> = {};
  for (const k of FORWARD_RESPONSE_HEADERS) if (lower[k] !== undefined) out[k] = lower[k]!;
  const cd = out["content-disposition"];
  out["content-disposition"] = cd ? cd.replace(/^\s*inline\b/i, "attachment").replace(/^(?!\s*attachment)/i, "attachment; ") : "attachment";
  out["content-security-policy"] = "sandbox; default-src 'none'";
  out["x-content-type-options"] = "nosniff";
  out["cache-control"] = "no-store";
  return out;
}

const HTTP_START_TIMEOUT_MS = 60_000;
const MAX_RELAY_BODY = 1024 * 1024;
export { MAX_RELAY_BODY };

export interface HubEvents {
  onConnect?: (taskId: string) => void;
  onDisconnect?: (taskId: string) => void;
}

export class ChannelHub {
  readonly #sessions = new Map<string, SessionConn>();
  readonly #events: HubEvents;
  constructor(events: HubEvents = {}) {
    this.#events = events;
  }

  isConnected(taskId: string): boolean {
    return this.#sessions.has(taskId);
  }

  /** A session's agent connected (already authenticated by its session token). */
  attachSession(taskId: string, ws: WebSocket): void {
    const old = this.#sessions.get(taskId);
    if (old) this.#drop(taskId, old, 1012, "replaced by a newer connection");
    const conn: SessionConn = { ws, streams: new Map(), http: new Map() };
    this.#sessions.set(taskId, conn);
    ws.on("message", (raw: RawData) => this.#fromSession(conn, raw));
    ws.on("close", () => {
      if (this.#sessions.get(taskId) === conn) {
        this.#drop(taskId, conn, 1001, "session disconnected");
        this.#events.onDisconnect?.(taskId);
      }
    });
    ws.on("error", () => ws.terminate());
    this.#events.onConnect?.(taskId);
  }

  #send(conn: SessionConn, f: ServerToSessionFrame): void {
    try {
      conn.ws.send(JSON.stringify(f));
    } catch {
      /* the close handler cleans up */
    }
  }

  #fromSession(conn: SessionConn, raw: RawData): void {
    let f: SessionToServerFrame;
    try {
      f = JSON.parse(raw.toString()) as SessionToServerFrame;
    } catch {
      return;
    }
    if (f.type === "ping") return this.#send(conn, { type: "pong" });
    if (f.type === "ws-msg") {
      const s = conn.streams.get(f.id);
      if (!s) return;
      if (f.data_b64 !== undefined) s.client.send(Buffer.from(f.data_b64, "base64"), { binary: true });
      else s.client.send(String(f.text ?? ""));
      return;
    }
    if (f.type === "ws-close") {
      const s = conn.streams.get(f.id);
      if (!s) return;
      conn.streams.delete(f.id);
      closeQuietly(s.client, safeCode(f.code), f.reason || "");
      return;
    }
    if (f.type === "http-res") {
      const h = conn.http.get(f.id);
      if (!h || h.res.headersSent) return;
      if (h.timer) clearTimeout(h.timer);
      h.timer = null;
      const status = Number.isInteger(f.status) && f.status >= 200 && f.status <= 599 ? f.status : 502;
      h.res.writeHead(status, relayResponseHeaders(f.headers));
      return;
    }
    if (f.type === "http-data") {
      const h = conn.http.get(f.id);
      if (!h || !h.res.headersSent) return;
      h.res.write(Buffer.from(String(f.data_b64 || ""), "base64"));
      return;
    }
    if (f.type === "http-end") {
      const h = conn.http.get(f.id);
      if (!h) return;
      this.#endHttp(conn, h, f.error ? `the daemon request failed: ${f.error}` : null);
    }
  }

  /** Finish an HTTP relay: a clean end, or an error (a 502 if nothing was sent yet, else a cut-off). */
  #endHttp(conn: SessionConn, h: HttpStream, error: string | null): void {
    if (conn.http.get(h.id) !== h) return;
    conn.http.delete(h.id);
    if (h.timer) clearTimeout(h.timer);
    if (!error) {
      if (!h.res.headersSent) h.res.writeHead(502, { "content-type": "application/json" });
      h.res.end();
      return;
    }
    if (!h.res.headersSent) {
      const body = JSON.stringify({ error: { code: "upstream", message: error.slice(0, 300) } });
      h.res.writeHead(502, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      h.res.end(body);
    } else h.res.destroy();
  }

  /**
   * Relay one HTTP request to the task's daemon. Caller has authorised the user and checked
   * isConnected(). The response is streamed into `res`.
   */
  openHttp(taskId: string, userId: string, res: ServerResponse, r: HttpRelayRequest): void {
    const conn = this.#sessions.get(taskId);
    if (!conn) throw new Error("session not connected");
    const id = randomId(8);
    const h: HttpStream = { id, userId, res, timer: null };
    conn.http.set(id, h);
    h.timer = setTimeout(() => this.#endHttp(conn, h, "no answer from the session"), HTTP_START_TIMEOUT_MS);
    res.on("close", () => {
      if (conn.http.get(id) === h) {
        conn.http.delete(id);
        if (h.timer) clearTimeout(h.timer);
        this.#send(conn, { type: "http-cancel", id });
      }
    });
    this.#send(conn, {
      type: "http-req",
      id,
      method: r.method,
      path: r.path,
      headers: r.headers,
      ...(r.body && r.body.length ? { body_b64: r.body.toString("base64") } : {}),
    });
  }

  /**
   * Relay an accepted client WebSocket to the task's daemon. Caller has authorised the user and
   * checked isConnected(). `clientProtocols` = what the client offered (bearer ones are dropped).
   */
  openStream(taskId: string, userId: string, client: WebSocket, o: { path: string; daemonPassword: string; clientProtocols: string[] }): void {
    const conn = this.#sessions.get(taskId);
    if (!conn) {
      closeQuietly(client, 1013, "session not connected");
      return;
    }
    const id = randomId(8);
    const s: Stream = { id, taskId, userId, client };
    conn.streams.set(id, s);
    const protocols = [BEARER_PREFIX + o.daemonPassword, ...o.clientProtocols.filter((p) => !p.startsWith(BEARER_PREFIX))];
    this.#send(conn, { type: "ws-open", id, path: o.path, protocols, headers: {} });
    client.on("message", (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      this.#send(conn, isBinary ? { type: "ws-msg", id, data_b64: buf.toString("base64") } : { type: "ws-msg", id, text: buf.toString("utf8") });
    });
    client.on("close", () => {
      if (conn.streams.delete(id)) this.#send(conn, { type: "ws-close", id, code: 1000, reason: "client closed" });
    });
    client.on("error", () => client.terminate());
  }

  /** Revocation takes effect at once: close every proxied socket a user holds. */
  closeUser(userId: string, reason = "access revoked"): number {
    let n = 0;
    for (const conn of this.#sessions.values()) {
      for (const [id, s] of conn.streams) {
        if (s.userId !== userId) continue;
        conn.streams.delete(id);
        this.#send(conn, { type: "ws-close", id, code: 1000, reason });
        closeQuietly(s.client, 4403, reason);
        n++;
      }
      for (const h of [...conn.http.values()]) {
        if (h.userId !== userId) continue;
        this.#send(conn, { type: "http-cancel", id: h.id });
        this.#endHttp(conn, h, reason);
        n++;
      }
    }
    return n;
  }

  /** The task's machine is going away: close its channel and every stream on it. */
  closeTask(taskId: string, reason = "task stopped"): void {
    const conn = this.#sessions.get(taskId);
    if (conn) this.#drop(taskId, conn, 1000, reason);
  }

  #drop(taskId: string, conn: SessionConn, code: number, reason: string): void {
    if (this.#sessions.get(taskId) === conn) this.#sessions.delete(taskId);
    for (const s of conn.streams.values()) closeQuietly(s.client, 1001, reason);
    conn.streams.clear();
    for (const h of [...conn.http.values()]) this.#endHttp(conn, h, reason);
    closeQuietly(conn.ws, code, reason);
  }

  closeAll(): void {
    for (const [taskId, conn] of this.#sessions) this.#drop(taskId, conn, 1001, "server shutting down");
  }
}

/** Choose the subprotocol answered to the app: never a bearer one if anything else was offered. */
export function pickClientProtocol(offered: Set<string>): string | false {
  for (const p of offered) if (!p.startsWith(BEARER_PREFIX)) return p;
  const first = offered.values().next();
  return first.done ? false : first.value;
}

function safeCode(c: number | undefined): number {
  return c && c >= 1000 && c < 5000 && c !== 1005 && c !== 1006 && c !== 1015 ? c : 1000;
}
function closeQuietly(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason.slice(0, 120));
  } catch {
    try {
      ws.terminate();
    } catch {
      /* gone */
    }
  }
}
