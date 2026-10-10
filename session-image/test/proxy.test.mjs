// The session's local proxy: targeting from the proxy user name, CONNECT and plain http, through a
// sub-account (chained to an upstream CONNECT proxy) and through the server's relay (a stand-in
// WebSocket server), and refusals passed on as proxy errors.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { applyTargeting, parseTargeting, relayTunnel, startLocalProxy, subuserTunnel } from "../lib/proxy.mjs";

const closers = [];
after(() => Promise.all(closers.map((c) => c())));
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

/** A target that answers HTTP and echoes raw bytes after a "ECHO\n" line. */
async function target() {
  const srv = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.startsWith("ECHO\n")) {
        c.write(buf.slice(5));
        buf = "ECHO\n";
      } else if (buf.includes("\r\n\r\n")) {
        const line = buf.split("\r\n")[0];
        const hdrs = buf.split("\r\n\r\n")[0];
        const body = `you sent: ${line} | proxy-auth header: ${/proxy-authorization/i.test(hdrs)} | connection: ${/connection: close/i.test(hdrs)}`;
        c.end(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      }
    });
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(r)));
  return port;
}

/** An upstream CONNECT proxy wanting `login`; sends every tunnel to the target port. */
async function upstream(login, targetPort) {
  const seen = [];
  const srv = createServer((_q, s) => s.writeHead(405).end());
  srv.on("connect", (req, sock, head) => {
    const auth = Buffer.from(String(req.headers["proxy-authorization"] || "").replace(/^Basic /, ""), "base64").toString();
    seen.push({ target: req.url, auth });
    if (!auth.startsWith(`${login.username}:${login.password}`)) return sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    const up = net.connect(targetPort, "127.0.0.1", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => (srv.closeAllConnections(), srv.close(r))));
  return { port, seen };
}

/** curl-ish: one request through the local proxy, raw. */
function through(proxyPort, raw, { connect, user } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(proxyPort, "127.0.0.1");
    let out = "";
    c.on("data", (d) => {
      out += d.toString("latin1");
      if (connect && out.includes("\r\n\r\n") && !c.sentInner) {
        c.sentInner = true;
        if (!out.startsWith("HTTP/1.1 200")) return c.end();
        c.write(raw);
      }
    });
    c.on("end", () => resolve(out));
    c.on("close", () => resolve(out));
    c.on("error", reject);
    const auth = user ? `Proxy-Authorization: Basic ${Buffer.from(`${user}:x`).toString("base64")}\r\n` : "";
    if (connect) c.write(`CONNECT ${connect} HTTP/1.1\r\nHost: ${connect}\r\n${auth}\r\n`);
    else c.write(raw.replace("\r\n", `\r\n${auth}`));
    setTimeout(() => c.end(), 1500);
  });
}

test("targeting from the proxy user name, applied with the provider's template", () => {
  assert.deepEqual(parseTargeting("country-de"), { country: "de" });
  assert.deepEqual(parseTargeting("country-US-session-ab12cd34"), { country: "us", session: "ab12cd34" });
  assert.deepEqual(parseTargeting("x"), {});
  assert.deepEqual(parseTargeting("country-deu"), {});
  const tpl = { field: "password", country: "_country-{c}", session: "_session-{s}_lifetime-30m" };
  assert.deepEqual(applyTargeting({ username: "u", password: "p" }, tpl, { country: "de", session: "s1" }), { username: "u", password: "p_country-de_session-s1_lifetime-30m" });
});

test("subuser: CONNECT and plain http go through the owner's sub-account, with targeting", async () => {
  const tp = await target();
  const login = { username: "acme_u1", password: "pw" };
  const up = await upstream(login, tp);
  const srv = await startLocalProxy({ open: subuserTunnel({ host: "127.0.0.1", port: up.port, ...login, targeting: { field: "password", country: "_country-{c}" } }), port: 0 });
  closers.push(() => new Promise((r) => srv.close(r)));
  const lp = srv.address().port;
  const r1 = await through(lp, "GET /secure HTTP/1.1\r\nHost: shop.example\r\n\r\n", { connect: "shop.example:443", user: "country-de" });
  assert.match(r1, /^HTTP\/1\.1 200 Connection Established[\s\S]*you sent: GET \/secure HTTP\/1\.1/);
  assert.deepEqual(up.seen[0], { target: "shop.example:443", auth: "acme_u1:pw_country-de" });
  const r2 = await through(lp, "GET http://plain.example/a?b=1 HTTP/1.1\r\nHost: plain.example\r\nProxy-Connection: keep-alive\r\n\r\n");
  assert.match(r2, /you sent: GET \/a\?b=1 HTTP\/1\.1 \| proxy-auth header: false \| connection: true/);
  assert.equal(up.seen[1].target, "plain.example:80");
  // a refused login comes back as a proxy error, not a hang
  const bad = await startLocalProxy({ open: subuserTunnel({ host: "127.0.0.1", port: up.port, username: "acme_u1", password: "wrong", targeting: { field: "password" } }), port: 0 });
  closers.push(() => new Promise((r) => bad.close(r)));
  const r3 = await through(bad.address().port, "", { connect: "shop.example:443" });
  assert.match(r3, /^HTTP\/1\.1 407 Proxy Authentication Required[\s\S]*Jarvis proxy: the proxy refused the tunnel \(407\)/);
});

test("relay: each tunnel is a WebSocket to the server with the session's headers; a refusal is passed on", async () => {
  const tp = await target();
  const opened = [];
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  closers.push(() => new Promise((r) => wss.close(r)));
  wss.on("connection", (ws, req) => {
    const u = new URL(req.url, "http://x");
    opened.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: req.headers.authorization, gate: req.headers["cf-access-client-id"] });
    if (u.searchParams.get("host") === "refuse.example") {
      ws.send(JSON.stringify({ ok: false, status: 502, error: "the proxy refused the tunnel (HTTP 407)" }));
      return ws.close();
    }
    const sock = net.connect(tp, "127.0.0.1", () => ws.send(JSON.stringify({ ok: true })));
    ws.on("message", (d) => sock.write(d));
    sock.on("data", (d) => ws.send(d, { binary: true }));
    sock.on("end", () => ws.close());
    ws.on("close", () => sock.destroy());
  });
  const open = relayTunnel({ serverWs: `ws://127.0.0.1:${wss.address().port}`, headers: { Authorization: "Bearer tok", "CF-Access-Client-Id": "gate" } });
  const srv = await startLocalProxy({ open, port: 0 });
  closers.push(() => new Promise((r) => srv.close(r)));
  const lp = srv.address().port;
  const r = await through(lp, "GET /x HTTP/1.1\r\nHost: news.example\r\n\r\n", { connect: "news.example:443", user: "country-gb-session-abc12345" });
  assert.match(r, /you sent: GET \/x HTTP\/1\.1/);
  assert.deepEqual(opened[0], { path: "/api/session/proxy", q: { host: "news.example", port: "443", country: "gb", session: "abc12345" }, auth: "Bearer tok", gate: "gate" });
  const no = await through(lp, "", { connect: "refuse.example:443" });
  assert.match(no, /^HTTP\/1\.1 502 Bad Gateway[\s\S]*refused the tunnel/);
});

test("relay: the server's HTTP refusal (cap reached) becomes a 429 with its message", async () => {
  const srv0 = createServer((_q, s) => {
    s.writeHead(429, { "content-type": "application/json" });
    s.end(JSON.stringify({ error: { code: "tools_cap", message: "this month's proxy traffic (1 GB) is used up" } }));
  });
  const port = await listen(srv0);
  closers.push(() => new Promise((r) => srv0.close(r)));
  const lpSrv = await startLocalProxy({ open: relayTunnel({ serverWs: `ws://127.0.0.1:${port}`, headers: {} }), port: 0 });
  closers.push(() => new Promise((r) => lpSrv.close(r)));
  const r = await through(lpSrv.address().port, "", { connect: "a.example:443" });
  assert.match(r, /^HTTP\/1\.1 429 Too Many Requests[\s\S]*proxy traffic \(1 GB\) is used up/);
});
