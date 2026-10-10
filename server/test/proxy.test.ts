// The daemon proxy and the session reverse channel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, asService, createTask, fakeSession, openWs, nextMessage, closed, GATE, machineOf, type Harness } from "./helpers.ts";

async function withTask(fn: (h: Harness, alice: string, task: string) => Promise<void>) {
  const h = await harness();
  try {
    const u = await seedUsers(h);
    const task = await createTask(h, u.alice);
    await fn(h, u.alice, task);
  } finally {
    await h.close();
  }
}

test("the server adds the daemon password; the client never sees it, and a client-offered bearer is dropped", () =>
  withTask(async (h, alice, task) => {
    const s = await fakeSession(h, task);
    const c = await openWs(h, await asEmail(h, alice), `/api/tasks/${task}/daemon`, ["paseo.bearer.client-guess", "paseo.v1"]);
    assert.equal(c.protocol, "paseo.v1", "the answered subprotocol is never a bearer one");
    c.send("x");
    await nextMessage(c);
    const pw = machineOf(h, task)!.env.PASEO_PASSWORD!;
    assert.deepEqual(s.opened[0]!.protocols, [`paseo.bearer.${pw}`, "paseo.v1"]);
    assert.equal(s.opened[0]!.path, "/ws");
    // nothing the API returns carries the password
    const views = [await call(h, await asEmail(h, alice), "GET", `/api/tasks/${task}`), await call(h, await asEmail(h, alice), "GET", "/api/tasks")];
    for (const v of views) assert.ok(!JSON.stringify(v.body).includes(pw));
    c.close();
    s.ws.close();
  }));

test("binary frames are relayed both ways", () =>
  withTask(async (h, alice, task) => {
    const s = await fakeSession(h, task);
    const c = await openWs(h, await asEmail(h, alice), `/api/tasks/${task}/daemon`);
    const got = new Promise<Buffer>((r) => c.once("message", (d, isBinary) => (assert.ok(isBinary), r(d as Buffer))));
    c.send(Buffer.from([1, 2, 3, 250]), { binary: true });
    assert.deepEqual([...(await got)], [1, 2, 3, 250]);
    c.close();
    s.ws.close();
  }));

test("not connected yet -> 503; session disconnect closes the app's sockets", () =>
  withTask(async (h, alice, task) => {
    await assert.rejects(openWs(h, await asEmail(h, alice), `/api/tasks/${task}/daemon`), (e: { status?: number }) => e.status === 503);
    const s = await fakeSession(h, task);
    const c = await openWs(h, await asEmail(h, alice), `/api/tasks/${task}/daemon`);
    const done = closed(c);
    s.ws.close();
    assert.equal((await done).code, 1001);
    assert.equal((await call(h, await asEmail(h, alice), "GET", `/api/tasks/${task}`)).body.connected, false);
  }));

test("a second channel connection replaces the first", () =>
  withTask(async (h, alice, task) => {
    const s1 = await fakeSession(h, task);
    const gone = closed(s1.ws);
    const s2 = await fakeSession(h, task);
    assert.equal((await gone).code, 1012);
    const c = await openWs(h, await asEmail(h, alice), `/api/tasks/${task}/daemon`);
    c.send("hi");
    assert.equal(await nextMessage(c), "echo:hi");
    assert.equal(s2.opened.length, 1);
    c.close();
    s2.ws.close();
  }));

test("the channel needs a live session token; pausing kicks the session off", () =>
  withTask(async (h, alice, task) => {
    await assert.rejects(openWs(h, await asService(h, GATE), "/api/session/channel"), (e: { status?: number }) => e.status === 401);
    await assert.rejects(openWs(h, await asService(h, GATE, "0".repeat(64)), "/api/session/channel"), (e: { status?: number }) => e.status === 401);
    await assert.rejects(openWs(h, await asEmail(h, alice), "/api/session/channel"), (e: { status?: number }) => e.status === 401);
    const s = await fakeSession(h, task);
    const c = await openWs(h, await asEmail(h, alice), `/api/tasks/${task}/daemon`);
    const appClosed = closed(c);
    const sessClosed = closed(s.ws);
    await call(h, await asEmail(h, alice), "POST", `/api/tasks/${task}/pause`);
    await h.jarvis.settle();
    await appClosed;
    await sessClosed;
    await assert.rejects(openWs(h, await asService(h, GATE, s.token), "/api/session/channel"), (e: { status?: number }) => e.status === 401);
  }));

test("the admin can open any user's daemon; the stream closes when the app closes", () =>
  withTask(async (h, _alice, task) => {
    const s = await fakeSession(h, task);
    const c = await openWs(h, await asEmail(h, "admin@example.org"), `/api/tasks/${task}/daemon`);
    c.send("admin");
    assert.equal(await nextMessage(c), "echo:admin");
    const closeFrame = new Promise<string>((r) => s.ws.on("message", (d) => JSON.parse(d.toString()).type === "ws-close" && r(d.toString())));
    c.close();
    assert.match(await closeFrame, /ws-close/);
    s.ws.close();
  }));

test("unknown paths are refused at upgrade", () =>
  withTask(async (h, alice) => {
    await assert.rejects(openWs(h, await asEmail(h, alice), "/api/nope"), (e: { status?: number }) => e.status === 404);
  }));

test("cross-origin: a foreign Origin can't open the daemon or change state; the instance's own origin can", () =>
  withTask(async (h, alice, task) => {
    const s = await fakeSession(h, task);
    const jwt = (await asEmail(h, alice)).jwt!;
    const { WebSocket } = await import("ws");
    const refused = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${h.wsBase}/api/tasks/${task}/daemon`, { headers: { "cf-access-jwt-assertion": jwt, origin: "https://evil.example.net" } });
      ws.once("unexpected-response", (_q, res) => resolve(res.statusCode!));
      ws.once("open", () => resolve(101));
    });
    assert.equal(refused, 403);
    const ok = new WebSocket(`${h.wsBase}/api/tasks/${task}/daemon`, { headers: { "cf-access-jwt-assertion": jwt, origin: "https://jarvis.example.org" } });
    await new Promise((r) => ok.once("open", r));
    ok.close();
    const post = await fetch(`${h.base}/api/tasks`, {
      method: "POST",
      headers: { "cf-access-jwt-assertion": jwt, origin: "https://evil.example.net", "content-type": "application/json" },
      body: JSON.stringify({ prompt: "csrf" }),
    });
    assert.equal(post.status, 403);
    const get = await fetch(`${h.base}/api/tasks`, { headers: { "cf-access-jwt-assertion": jwt, origin: "https://evil.example.net" } });
    assert.equal(get.status, 200, "reads are harmless (CORS keeps the answer from the foreign page)");
    s.ws.close();
  }));

// ---- the HTTP relay -------------------------------------------------------------------------------

const raw = async (h: Harness, jwt: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) =>
  fetch(h.base + path, { method, headers: { "cf-access-jwt-assertion": jwt, ...headers }, body });

test("HTTP relay: path and query reach the daemon with the server's bearer; only safe headers come back, always as a sandboxed download", () =>
  withTask(async (h, alice, task) => {
    const s = await fakeSession(h, task);
    const jwt = (await asEmail(h, alice)).jwt!;
    const r = await raw(h, jwt, "GET", `/api/tasks/${task}/daemon/http/api/files/download?token=abc&x=1`, undefined, {
      authorization: "Bearer client-guess",
      range: "bytes=0-10",
      cookie: "foo=bar",
    });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "GET /api/files/download?token=abc&x=1 auth-ok=true body=");
    const req = s.http[0]!;
    assert.equal(req.headers.range, "bytes=0-10");
    assert.equal(req.headers.cookie, undefined, "the Access cookie never reaches the daemon");
    assert.equal(r.headers.get("x-daemon-secret"), null);
    assert.equal(r.headers.get("set-cookie"), null);
    assert.equal(r.headers.get("content-disposition"), 'attachment; filename="a.html"');
    assert.equal(r.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    s.ws.close();
  }));

test("HTTP relay: a POST body is relayed; a foreign Origin, another user and a disconnected session are refused", () =>
  withTask(async (h, alice, task) => {
    const jwt = (await asEmail(h, alice)).jwt!;
    assert.equal((await raw(h, jwt, "GET", `/api/tasks/${task}/daemon/http/x`)).status, 503, "not connected");
    const s = await fakeSession(h, task);
    const post = await raw(h, jwt, "POST", `/api/tasks/${task}/daemon/http/api/thing`, '{"a":1}', { "content-type": "application/json" });
    assert.equal(await post.text(), 'POST /api/thing auth-ok=true body={"a":1}');
    assert.equal(s.http[0]!.headers["content-type"], "application/json");
    const cross = await raw(h, jwt, "POST", `/api/tasks/${task}/daemon/http/api/thing`, "{}", { origin: "https://evil.example.net" });
    assert.equal(cross.status, 403);
    const bob = (await asEmail(h, "bob@example.org")).jwt!;
    const theirs = await raw(h, bob, "GET", `/api/tasks/${task}/daemon/http/x`);
    const missing = await raw(h, bob, "GET", `/api/tasks/ffffffffffffffff/daemon/http/x`);
    assert.equal(theirs.status, 404);
    assert.deepEqual(await theirs.json(), await missing.json());
    assert.equal(s.http.length, 1, "refused requests never reach the session");
    s.ws.close();
  }));

test("HTTP relay: the session going away mid-request answers 502; the app going away cancels the request", () =>
  withTask(async (h, alice, task) => {
    const jwt = (await asEmail(h, alice)).jwt!;
    const s = await fakeSession(h, task);
    const pending = raw(h, jwt, "GET", `/api/tasks/${task}/daemon/http/hang/1`);
    for (let i = 0; i < 100 && !s.http.length; i++) await new Promise((r) => setTimeout(r, 5));
    s.ws.close();
    const r = await pending;
    assert.equal(r.status, 502);
    assert.equal(((await r.json()) as { error: { code: string } }).error.code, "upstream");

    const s2 = await fakeSession(h, task);
    const ac = new AbortController();
    const p2 = raw(h, jwt, "GET", `/api/tasks/${task}/daemon/http/hang/2`).catch(() => null);
    void p2;
    const p3 = fetch(h.base + `/api/tasks/${task}/daemon/http/hang/3`, { headers: { "cf-access-jwt-assertion": jwt }, signal: ac.signal }).catch(() => null);
    for (let i = 0; i < 100 && s2.http.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await p3;
    for (let i = 0; i < 100 && !s2.cancelled.length; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(s2.cancelled.length, 1, "the session is told to stop");
    s2.ws.close();
    await p2;
  }));
