// The metered proxy relay ("relay" proxy providers): a session's local proxy (jarvis-agent,
// 127.0.0.1:3128) turns each CONNECT into one WebSocket to wss://<instance>/api/session/proxy
// ?host=&port=[&country=][&session=], authenticated by the session token. The server opens the
// tunnel through the provider with the organisation's login (which never leaves the server), says
// {"ok":true} as the first text frame, and then relays binary frames both ways, counting every byte
// against the task owner's monthly GB cap. At the cap the tunnel is closed.
//
// Bytes are written to the ledger (tool_usage, tool 'proxy') when a tunnel closes and every
// FLUSH_BYTES while it runs; the cap check counts the ledger plus every open tunnel's unwritten bytes.
import net from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import type { Ctx } from "../ctx.ts";
import type { TaskRow, UserRow } from "../rows.ts";
import { monthKey } from "../clock.ts";
import { httpError } from "../errors.ts";
import { capNotice, GB, relayBytes, toolCaps } from "./index.ts";
import type { ProxyTargeting, RelayProxyProvider } from "./types.ts";

const FLUSH_BYTES = 8 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
/** Ports a tunnel may open (web and the common alternates); others are refused. */
const DEFAULT_PORTS = new Set([80, 443, 8080, 8443]);

interface Live {
  /** Unwritten bytes per user, across their open tunnels. */
  pending: Map<string, number>;
  /** The ledger's bytes for the user's month (read once, then kept up to date by write()). */
  written: Map<string, { month: string; bytes: number }>;
  /** Open tunnels per user (offboarding closes them). */
  open: Map<string, Set<WebSocket>>;
}
const live = new WeakMap<Ctx, Live>();
const state = (ctx: Ctx): Live => {
  let s = live.get(ctx);
  if (!s) live.set(ctx, (s = { pending: new Map(), written: new Map(), open: new Map() }));
  return s;
};

export function relayProvider(ctx: Ctx): RelayProxyProvider | null {
  return ctx.tools.proxy?.mode === "relay" ? ctx.tools.proxy : null;
}

/** Bytes used this month: written + in flight. */
export function relayUsed(ctx: Ctx, userId: string): number {
  const s = state(ctx);
  const month = monthKey(ctx.clock.now());
  let w = s.written.get(userId);
  if (!w || w.month !== month) s.written.set(userId, (w = { month, bytes: relayBytes(ctx, userId, month) }));
  return w.bytes + (s.pending.get(userId) ?? 0);
}

function capBytes(ctx: Ctx, user: UserRow): number | null {
  const gb = toolCaps(ctx, user).proxyCapGb;
  return gb === null ? null : gb * GB;
}

function write(ctx: Ctx, user: UserRow, task: TaskRow, p: RelayProxyProvider, bytes: number): void {
  if (bytes <= 0) return;
  const s = state(ctx);
  s.pending.set(user.id, Math.max(0, (s.pending.get(user.id) ?? 0) - bytes));
  const month = monthKey(ctx.clock.now());
  const w = s.written.get(user.id);
  if (w && w.month === month) w.bytes += bytes;
  ctx.db
    .prepare("INSERT INTO tool_usage(user_id, task_id, tool, provider, state, cost_usd, bytes, month, created_at) VALUES (?, ?, 'proxy', ?, 'done', ?, ?, ?, ?)")
    .run(user.id, task.id, p.name, Math.round((bytes / GB) * p.perGbUsd * 1e6) / 1e6, bytes, month, ctx.clock.now());
}

export interface TunnelTarget {
  host: string;
  port: number;
  targeting: ProxyTargeting;
}

export function parseTarget(url: URL, allowedPorts: Set<number> = DEFAULT_PORTS): TunnelTarget {
  const host = url.searchParams.get("host") || "";
  const port = Number(url.searchParams.get("port") || "");
  // a host name or an IPv4/IPv6 literal; nothing that could break the CONNECT line
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) && !/^\[?[0-9a-fA-F:.]{2,45}\]?$/.test(host)) throw httpError("bad_request", "host must be a host name or an IP address");
  if (!Number.isInteger(port) || !allowedPorts.has(port)) throw httpError("bad_request", `port must be one of ${[...allowedPorts].join(", ")}`);
  const t: ProxyTargeting = {};
  const c = url.searchParams.get("country");
  if (c) {
    if (!/^[a-zA-Z]{2}$/.test(c)) throw httpError("bad_request", "country must be two letters");
    t.country = c.toLowerCase();
  }
  const sess = url.searchParams.get("session");
  if (sess) {
    if (!/^[A-Za-z0-9]{1,32}$/.test(sess)) throw httpError("bad_request", "session must be [A-Za-z0-9]{1,32}");
    t.session = sess;
  }
  return { host: host.replace(/^\[|\]$/g, ""), port, targeting: t };
}

/** Before the upgrade: refuse when no relay proxy is set up or the cap is already reached. */
export function checkRelay(ctx: Ctx, user: UserRow): RelayProxyProvider {
  const p = relayProvider(ctx);
  if (!p) throw httpError("conflict", "no metered proxy is set up on this instance");
  const cap = capBytes(ctx, user);
  if (cap !== null && relayUsed(ctx, user.id) >= cap) {
    capNotice(ctx, user, "proxy", toolCaps(ctx, user).proxyCapGb);
    throw httpError("tools_cap", `this month's proxy traffic (${toolCaps(ctx, user).proxyCapGb} GB) is used up`);
  }
  return p;
}

/** Open the tunnel through the provider: TCP to its endpoint, CONNECT with the org login. */
function openUpstream(p: RelayProxyProvider, t: TunnelTarget): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const ep = p.endpoint();
    const login = p.login(t.targeting);
    const sock = net.connect({ host: ep.host, port: ep.port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("the proxy did not answer in time"));
    }, CONNECT_TIMEOUT_MS);
    let head = Buffer.alloc(0);
    const onData = (c: Buffer) => {
      head = Buffer.concat([head, c]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 16384) fail(new Error("the proxy sent an oversized answer"));
        return;
      }
      sock.off("data", onData);
      clearTimeout(timer);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"))?.[1] ?? 0);
      if (status !== 200) {
        sock.destroy();
        return reject(Object.assign(new Error(`the proxy refused the tunnel (HTTP ${status || "?"})`), { status }));
      }
      const rest = head.subarray(end + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    const fail = (e: Error) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    };
    sock.on("data", onData);
    sock.once("error", fail);
    sock.once("connect", () => {
      const auth = Buffer.from(`${login.username}:${login.password}`).toString("base64");
      const target = t.host.includes(":") ? `[${t.host}]:${t.port}` : `${t.host}:${t.port}`;
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
    });
  });
}

/** After authorize + checkRelay: run one tunnel for the session's task. */
export function runTunnel(ctx: Ctx, wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, user: UserRow, task: TaskRow, p: RelayProxyProvider, t: TunnelTarget): void {
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    const s = state(ctx);
    const cap = capBytes(ctx, user);
    let unwritten = 0;
    let up: net.Socket | null = null;
    let closed = false;
    const finish = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      write(ctx, user, task, p, unwritten);
      unwritten = 0;
      up?.destroy();
      try {
        ws.close(code, reason.slice(0, 120));
      } catch {
        ws.terminate();
      }
    };
    const count = (n: number): boolean => {
      unwritten += n;
      s.pending.set(user.id, (s.pending.get(user.id) ?? 0) + n);
      if (unwritten >= FLUSH_BYTES) {
        write(ctx, user, task, p, unwritten);
        unwritten = 0;
      }
      if (cap !== null && relayUsed(ctx, user.id) >= cap) {
        capNotice(ctx, user, "proxy", toolCaps(ctx, user).proxyCapGb);
        finish(4029, "monthly proxy traffic cap reached");
        return false;
      }
      return true;
    };
    let mine = s.open.get(user.id);
    if (!mine) s.open.set(user.id, (mine = new Set()));
    mine.add(ws);
    ws.on("close", () => {
      mine.delete(ws);
      finish();
    });
    ws.on("error", () => finish(1011));
    const early: Buffer[] = [];
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      if (!isBinary || closed) return;
      const b = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      if (!count(b.length)) return;
      if (up) up.write(b);
      else early.push(b);
    });
    openUpstream(p, t).then(
      (sock) => {
        if (closed) return sock.destroy();
        up = sock;
        ws.send(JSON.stringify({ ok: true }));
        for (const b of early.splice(0)) sock.write(b);
        sock.on("data", (c: Buffer) => {
          if (!count(c.length)) return;
          ws.send(c, { binary: true });
        });
        sock.on("close", () => finish());
        sock.on("error", () => finish(1011, "upstream error"));
      },
      (e: Error & { status?: number }) => {
        ctx.log("proxy tunnel refused", { task: task.id, host: t.host, error: e.message });
        try {
          ws.send(JSON.stringify({ ok: false, status: e.status === 407 ? 502 : e.status || 502, error: e.message }));
        } catch {
          /* closing */
        }
        finish(1011, "upstream refused");
      },
    );
  });
}

/** Close every open tunnel of a user (offboarding). */
export function closeUserTunnels(ctx: Ctx, userId: string): void {
  for (const ws of state(ctx).open.get(userId) ?? []) ws.close(4403, "access removed");
}
