// The session's local proxy (Tier 0 proxies, docs/TOOLS.md): jarvis-agent listens on
// 127.0.0.1:3128 and the agent points tools at it ($JARVIS_PROXY_URL). Targeting goes in the proxy
// username: http://country-de:x@127.0.0.1:3128, http://country-us-session-ab12cd34:x@127.0.0.1:3128.
//
// Two upstream modes, chosen by the server:
//   subuser  the task owner's own capped sub-account (JARVIS_PROXY from the machine env): the
//            local proxy chains to the provider with that login, targeting applied per the
//            provider's template; the login never reaches the agent's environment
//   relay    every tunnel is a WebSocket to the server (/api/session/proxy), which opens it with
//            the organisation's login and meters the bytes; nothing of the login is in the machine
//
// It speaks CONNECT (https and anything tunnelled) and plain-http absolute-URI requests (sent as a
// tunnel to port 80 with the request rewritten to origin form and Connection: close).
import net from "node:net";
import { WebSocket, createWebSocketStream } from "ws";

/** Parse targeting from the proxy username ("country-de", "country-us-session-ab12"). */
export function parseTargeting(username) {
  const t = {};
  const c = /(?:^|-)country-([a-zA-Z]{2})(?:-|$)/.exec(username || "");
  if (c) t.country = c[1].toLowerCase();
  const s = /(?:^|-)session-([A-Za-z0-9]{1,32})(?:-|$)/.exec(username || "");
  if (s) t.session = s[1];
  return t;
}

/** The provider's template applied to a login (same as the server's applyTargeting). */
export function applyTargeting(login, tpl, t) {
  let add = "";
  if (t.country && tpl?.country) add += tpl.country.replace("{c}", tpl.countryCase === "upper" ? t.country.toUpperCase() : t.country.toLowerCase());
  if (t.session && tpl?.session) add += tpl.session.replace("{s}", t.session);
  return tpl?.field === "username" ? { username: login.username + add, password: login.password } : { username: login.username, password: login.password + add };
}

/** Read one HTTP header block from a socket. Resolves {head, rest}. */
function readHead(sock, max = 32768) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (c) => {
      buf = Buffer.concat([buf, c]);
      const end = buf.indexOf("\r\n\r\n");
      if (end >= 0) {
        cleanup();
        resolve({ head: buf.subarray(0, end).toString("latin1"), rest: buf.subarray(end + 4) });
      } else if (buf.length > max) {
        cleanup();
        reject(new Error("header too large"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("closed before the header ended"));
    };
    const cleanup = () => {
      sock.off("data", onData);
      sock.off("end", onEnd);
      sock.off("error", onEnd);
    };
    sock.on("data", onData);
    sock.on("end", onEnd);
    sock.on("error", onEnd);
  });
}

/** Upstream "subuser": CONNECT through the provider with the owner's sub-account login. */
export function subuserTunnel(upstream) {
  return (host, port, t) =>
    new Promise((resolve, reject) => {
      const login = applyTargeting({ username: upstream.username, password: upstream.password }, upstream.targeting, t);
      const sock = net.connect({ host: upstream.host, port: upstream.port });
      sock.setTimeout(30_000, () => sock.destroy(new Error("the proxy did not answer in time")));
      sock.once("error", reject);
      sock.once("connect", async () => {
        const target = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
        const auth = Buffer.from(`${login.username}:${login.password}`).toString("base64");
        sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
        try {
          const { head, rest } = await readHead(sock);
          const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] || 0);
          if (status !== 200) {
            sock.destroy();
            return reject(Object.assign(new Error(`the proxy refused the tunnel (${status || "?"})`), { status: status || 502 }));
          }
          sock.setTimeout(0);
          if (rest.length) sock.unshift(rest);
          sock.off("error", reject);
          resolve(sock);
        } catch (e) {
          sock.destroy();
          reject(e);
        }
      });
    });
}

/** Upstream "relay": one WebSocket per tunnel to the server, which meters it. */
export function relayTunnel({ serverWs, headers }) {
  return (host, port, t) =>
    new Promise((resolve, reject) => {
      const q = new URLSearchParams({ host, port: String(port) });
      if (t.country) q.set("country", t.country);
      if (t.session) q.set("session", t.session);
      const ws = new WebSocket(`${serverWs}/api/session/proxy?${q}`, { headers });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("the Jarvis server did not open the tunnel in time"));
      }, 45_000);
      const onError = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        ws.off("error", onError);
        ws.on("error", () => {});
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          let msg = body;
          try {
            msg = JSON.parse(body).error?.message || body;
          } catch {
            /* text */
          }
          reject(Object.assign(new Error(msg.slice(0, 200) || `HTTP ${res.statusCode}`), { status: res.statusCode }));
          ws.terminate();
        });
      });
      ws.once("error", onError);
      ws.once("message", (d, isBinary) => {
        clearTimeout(timer);
        let first = {};
        try {
          first = isBinary ? {} : JSON.parse(d.toString());
        } catch {
          /* not JSON */
        }
        if (!first.ok) {
          ws.close();
          return reject(Object.assign(new Error(first.error || "the tunnel was refused"), { status: first.status || 502 }));
        }
        const stream = createWebSocketStream(ws);
        stream.on("error", () => stream.destroy());
        resolve(stream);
      });
    });
}

const REASON = { 400: "Bad Request", 403: "Forbidden", 407: "Proxy Authentication Required", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable" };
function fail(sock, status, message) {
  const body = `${message}\n`;
  const st = REASON[status] ? status : 502;
  sock.end(`HTTP/1.1 ${st} ${REASON[st]}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

const proxyUser = (headers) => {
  const m = /^proxy-authorization:\s*basic\s+(\S+)/im.exec(headers);
  if (!m) return "";
  const s = Buffer.from(m[1], "base64").toString();
  return s.slice(0, Math.max(0, s.indexOf(":")) || s.length);
};

/**
 * Start the local proxy. `open(host, port, targeting)` resolves a Duplex to the target.
 * Returns the net.Server (listening).
 */
export function startLocalProxy({ open, host = "127.0.0.1", port = 3128, log = () => {} }) {
  const srv = net.createServer(async (client) => {
    client.on("error", () => client.destroy());
    let req;
    try {
      req = await readHead(client);
    } catch {
      return client.destroy();
    }
    const [line, ...rest] = req.head.split("\r\n");
    const headers = rest.join("\r\n");
    const [method, target] = line.split(" ");
    const t = parseTargeting(proxyUser(headers));
    let up;
    try {
      if (method === "CONNECT") {
        const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(target || "");
        if (!m) return fail(client, 400, "CONNECT needs host:port");
        up = await open(m[1], Number(m[2]), t);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (req.rest.length) up.write(req.rest);
      } else {
        let u;
        try {
          u = new URL(target);
        } catch {
          return fail(client, 400, "a proxy request needs an absolute http:// URL");
        }
        if (u.protocol !== "http:") return fail(client, 400, "use CONNECT (https) for anything but http://");
        up = await open(u.hostname, Number(u.port || 80), t);
        const kept = rest.filter((h) => h && !/^(proxy-authorization|proxy-connection|connection|keep-alive):/i.test(h));
        up.write(`${method} ${u.pathname}${u.search} HTTP/1.1\r\n${kept.join("\r\n")}\r\nConnection: close\r\n\r\n`);
        if (req.rest.length) up.write(req.rest);
      }
    } catch (e) {
      log("proxy tunnel refused", { target, error: e.message });
      return fail(client, e.status || 502, `Jarvis proxy: ${e.message}`);
    }
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
    up.on("close", () => client.destroy());
    up.pipe(client);
    client.pipe(up);
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(port, host, () => resolve(srv));
  });
}
