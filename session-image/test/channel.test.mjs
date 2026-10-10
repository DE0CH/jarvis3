// The session side of the reverse channel against a stand-in server and a stand-in daemon:
// hello + ping, ws-open with the server's subprotocols, text and binary both ways, close both
// ways, a refused daemon, reconnect after the server drops the channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { startChannel } from "../lib/channel.mjs";

const listen = (opts = {}) =>
  new Promise((r) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", ...opts }, () => r(wss));
  });
const next = (emitter, ev = "message", ms = 3000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
    emitter.once(ev, (...a) => {
      clearTimeout(t);
      resolve(a);
    });
  });
const frames = (ws) => {
  const q = [];
  const waiters = [];
  ws.on("message", (d) => {
    const f = JSON.parse(d.toString());
    const w = waiters.findIndex((x) => x.pred(f));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(f);
    else q.push(f);
  });
  return (pred, ms = 3000) =>
    new Promise((resolve, reject) => {
      const i = q.findIndex(pred);
      if (i >= 0) return resolve(q.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
      waiters.push({ pred, resolve: (f) => (clearTimeout(t), resolve(f)) });
    });
};

test("relays a daemon stream: subprotocols, text, binary, close from either side", async () => {
  const daemonConns = [];
  const daemon = await listen({ handleProtocols: (p) => [...p][0] ?? false });
  daemon.on("connection", (ws, req) => {
    daemonConns.push({ ws, protocols: req.headers["sec-websocket-protocol"], url: req.url });
    ws.on("message", (d, bin) => ws.send(bin ? Buffer.concat([Buffer.from("B:"), d]) : `daemon:${d}`, { binary: bin }));
  });
  const server = await listen();
  const headersSeen = [];
  server.on("connection", (_ws, req) => headersSeen.push(req.headers));
  const ch = startChannel({
    url: `ws://127.0.0.1:${server.address().port}/api/session/channel`,
    headers: { Authorization: "Bearer tok", "CF-Access-Client-Id": "gate" },
    daemonBase: `ws://127.0.0.1:${daemon.address().port}`,
    pingMs: 50,
  });
  try {
    const [sws] = await next(server, "connection");
    const recv = frames(sws);
    assert.deepEqual(await recv((f) => f.type === "hello"), { type: "hello", agent: "jarvis3-session/0.1.0" });
    await recv((f) => f.type === "ping");
    assert.equal(headersSeen[0].authorization, "Bearer tok");
    assert.equal(headersSeen[0]["cf-access-client-id"], "gate");

    // open; a message sent before the daemon socket is open is queued, not lost
    sws.send(JSON.stringify({ type: "ws-open", id: "s1", path: "/ws?x=1", protocols: ["paseo.bearer.pw", "app.v1"], headers: {} }));
    sws.send(JSON.stringify({ type: "ws-msg", id: "s1", text: "early" }));
    assert.deepEqual(await recv((f) => f.type === "ws-msg"), { type: "ws-msg", id: "s1", text: "daemon:early" });
    assert.deepEqual(daemonConns[0].protocols.split(/,\s*/), ["paseo.bearer.pw", "app.v1"]);
    assert.equal(daemonConns[0].url, "/ws?x=1");

    sws.send(JSON.stringify({ type: "ws-msg", id: "s1", data_b64: Buffer.from([1, 2, 3]).toString("base64") }));
    const b = await recv((f) => f.type === "ws-msg");
    assert.deepEqual([...Buffer.from(b.data_b64, "base64")], [...Buffer.from("B:"), 1, 2, 3]);

    // the daemon closes -> ws-close up
    daemonConns[0].ws.close(4000, "bye");
    assert.deepEqual(await recv((f) => f.type === "ws-close"), { type: "ws-close", id: "s1", code: 4000, reason: "bye" });

    // the server closes a stream -> the daemon socket closes
    sws.send(JSON.stringify({ type: "ws-open", id: "s2", path: "/ws", protocols: ["paseo.bearer.pw"], headers: {} }));
    sws.send(JSON.stringify({ type: "ws-msg", id: "s2", text: "hi" }));
    await recv((f) => f.type === "ws-msg" && f.id === "s2");
    const closedP = next(daemonConns[1].ws, "close");
    sws.send(JSON.stringify({ type: "ws-close", id: "s2", code: 1000, reason: "client closed" }));
    const [code] = await closedP;
    assert.equal(code, 1000);
    assert.equal(ch.streams, 0);
  } finally {
    ch.stop();
    daemon.close();
    server.close();
  }
});

test("a daemon that refuses (or isn't there) closes the stream with 1011", async () => {
  const server = await listen();
  const ch = startChannel({ url: `ws://127.0.0.1:${server.address().port}/c`, headers: {}, daemonBase: "ws://127.0.0.1:1" });
  try {
    const [sws] = await next(server, "connection");
    const recv = frames(sws);
    sws.send(JSON.stringify({ type: "ws-open", id: "x", path: "/ws", protocols: [], headers: {} }));
    const f = await recv((f) => f.type === "ws-close");
    assert.equal(f.id, "x");
    assert.equal(f.code, 1011);
    sws.send(JSON.stringify({ type: "ws-open", id: "y", path: "no-slash", protocols: [], headers: {} }));
    assert.equal((await recv((f) => f.type === "ws-close" && f.id === "y")).code, 1008);
  } finally {
    ch.stop();
    server.close();
  }
});

test("reconnects after the server drops the channel, and says hello again", async () => {
  const server = await listen();
  let connects = 0;
  const ch = startChannel({ url: `ws://127.0.0.1:${server.address().port}/c`, headers: {}, daemonBase: "ws://127.0.0.1:1", onConnect: () => connects++ });
  try {
    const [first] = await next(server, "connection");
    first.close(1012, "replaced");
    const [second] = await next(server, "connection", 5000);
    const [hello] = await next(second, "message");
    assert.equal(JSON.parse(hello.toString()).type, "hello");
    assert.equal(connects, 2);
  } finally {
    ch.stop();
    server.close();
  }
});

test("relays HTTP requests to the daemon: method, path, headers, body; chunked answer; cancel aborts", async () => {
  const { createServer } = await import("node:http");
  const seen = [];
  let hung = null;
  const daemon = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      if (req.url.startsWith("/hang")) {
        hung = res;
        res.on("close", () => (hung = "closed"));
        return;
      }
      res.writeHead(201, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(600 * 1024, 7)); // bigger than one chunk
    });
  });
  await new Promise((r) => daemon.listen(0, "127.0.0.1", r));
  const server = await listen();
  const ch = startChannel({
    url: `ws://127.0.0.1:${server.address().port}/api/session/channel`,
    headers: {},
    daemonBase: `ws://127.0.0.1:${daemon.address().port}`,
  });
  try {
    const [sws] = await next(server, "connection");
    const recv = frames(sws);
    await recv((f) => f.type === "hello");
    sws.send(JSON.stringify({ type: "http-req", id: "h1", method: "POST", path: "/api/x?y=1", headers: { authorization: "Bearer pw" }, body_b64: Buffer.from("hi").toString("base64") }));
    const head = await recv((f) => f.type === "http-res" && f.id === "h1");
    assert.equal(head.status, 201);
    assert.equal(head.headers["content-type"], "application/octet-stream");
    let total = 0;
    let parts = 0;
    for (;;) {
      const f = await recv((x) => (x.type === "http-data" || x.type === "http-end") && x.id === "h1");
      if (f.type === "http-end") {
        assert.equal(f.error, undefined);
        break;
      }
      total += Buffer.from(f.data_b64, "base64").length;
      parts++;
    }
    assert.equal(total, 600 * 1024);
    assert.ok(parts >= 3, "sent in ≤ 256 KiB chunks");
    assert.deepEqual(seen[0], { method: "POST", url: "/api/x?y=1", auth: "Bearer pw", body: "hi" });

    sws.send(JSON.stringify({ type: "http-req", id: "h2", method: "GET", path: "/hang", headers: {} }));
    for (let i = 0; i < 200 && !hung; i++) await new Promise((r) => setTimeout(r, 5));
    sws.send(JSON.stringify({ type: "http-cancel", id: "h2" }));
    for (let i = 0; i < 200 && hung !== "closed"; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(hung, "closed", "the daemon request is aborted");

    sws.send(JSON.stringify({ type: "http-req", id: "h3", method: "GET", path: "no-slash", headers: {} }));
    assert.equal((await recv((f) => f.type === "http-end" && f.id === "h3")).error, "bad path");
  } finally {
    ch.stop();
    server.close();
    daemon.close();
    daemon.closeAllConnections();
  }
});
