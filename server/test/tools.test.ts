// Tier 0 tools: metering and hard caps for search and fetch, per-user proxy sub-accounts, the
// metered proxy relay, and who can see whose usage (docs/TOOLS.md).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { harness, seedUsers, call, asEmail, asService, createTask, machineOf, sessionTokenOf, GATE, testConfig, type Harness, type Cred } from "./helpers.ts";
import { FakeFetch, FakeRelayProxy, FakeSearch, FakeSubUserProxy } from "../src/fakes/tools.ts";
import type { Config } from "../src/config.ts";
import { validateConfig } from "../src/config.ts";
import type { ToolProviders } from "../src/tools/types.ts";
import { applyTargeting } from "../src/tools/types.ts";

const ROLES = {
  admin: { openrouterMonthlyUsd: 100, machineHoursPerMonth: null, admin: true, toolsMonthlyUsd: 10, proxyMonthlyGb: 5 },
  staff: { openrouterMonthlyUsd: 20, machineHoursPerMonth: 10, toolsMonthlyUsd: 0.025, proxyMonthlyGb: 1 },
};
const TOOLS_CFG: Config["tools"] = { search: { provider: "fake" }, fetch: { provider: "fake" }, proxy: { provider: "fake" } };

async function setup(tools: Partial<ToolProviders>, over: Partial<Config> = {}) {
  const providers: ToolProviders = { search: null, fetch: null, proxy: null, ...tools };
  const h = await harness({ config: { roles: ROLES, tools: TOOLS_CFG, ...over }, tools: providers });
  const people = await seedUsers(h);
  return { h, ...people };
}
const session = (h: Harness, taskId: string): Promise<Cred> => asService(h, GATE, sessionTokenOf(h, taskId));
const userId = async (h: Harness, email: string): Promise<string> => (await call(h, await asEmail(h, email), "GET", "/api/me")).body.user.id;

describe("config", () => {
  test("a configured tool needs an explicit cap on every role", () => {
    assert.throws(() => testConfig({ tools: { search: { provider: "exa", credential: "EXA_KEY" } } }), /toolsMonthlyUsd must be set/);
    assert.throws(() => testConfig({ tools: { proxy: { provider: "iproyal" } }, roles: { admin: { ...ROLES.admin }, staff: { openrouterMonthlyUsd: 1, machineHoursPerMonth: 1, toolsMonthlyUsd: 1 } } }), /proxyMonthlyGb must be set/);
    assert.throws(() => testConfig({ roles: ROLES, tools: { search: { provider: "exa", credential: "lower-case" } } }), /credential must name an environment variable/);
    assert.throws(() => testConfig({ roles: ROLES, tools: { search: { provider: "exa", pricing: { perCallUsd: -1 } } } }), /pricing.perCallUsd/);
    // null = no cap, chosen on purpose, is fine
    const c = testConfig({ roles: { ...ROLES, staff: { ...ROLES.staff, toolsMonthlyUsd: null } }, tools: { search: { provider: "exa" } } });
    assert.equal(c.roles.staff!.toolsMonthlyUsd, null);
    // no tools: nothing required
    assert.ok(validateConfig(testConfig()));
  });

  test("targeting templates", () => {
    const l = { username: "u", password: "p" };
    assert.deepEqual(applyTargeting(l, { field: "password", country: "_country-{c}", session: "_session-{s}_lifetime-30m" }, { country: "de", session: "abcd1234" }), {
      username: "u",
      password: "p_country-de_session-abcd1234_lifetime-30m",
    });
    assert.deepEqual(applyTargeting(l, { field: "password", country: "_country-{c}", countryCase: "upper" }, { country: "us" }), { username: "u", password: "p_country-US" });
    assert.deepEqual(applyTargeting(l, { field: "username" }, { country: "us" }), l);
  });
});

describe("web search and fetch (server-metered)", () => {
  test("a session searches and fetches; the cost lands on its owner, never another user", async () => {
    const search = new FakeSearch();
    const fetchP = new FakeFetch();
    const { h, alice, bob } = await setup({ search, fetch: fetchP });
    try {
      const t = await createTask(h, alice);
      const s = await session(h, t);
      const view = await call(h, s, "GET", "/api/session/tools");
      assert.equal(view.status, 200);
      assert.deepEqual(view.body, { search: true, fetch: true, proxy: null, web: { capUsd: 0.025, spentUsd: 0 }, proxyUsage: null });

      const r = await call(h, s, "POST", "/api/session/tools/search", { query: "jarvis", numResults: 5 });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.results.length, 3);
      assert.equal(r.body.costUsd, 0.007);
      assert.equal(r.body.spentUsd, 0.007);
      assert.equal(search.calls[0]!.query, "jarvis");

      const f = await call(h, s, "POST", "/api/session/tools/fetch", { url: "https://example.com/a", render: true });
      assert.equal(f.status, 200, JSON.stringify(f.body));
      assert.equal(f.body.body, fetchP.body);
      assert.equal(f.body.truncated, false);
      assert.equal(fetchP.calls[0]!.render, true);
      assert.equal(fetchP.calls[0]!.format, "html");

      const me = await call(h, await asEmail(h, alice), "GET", "/api/me");
      assert.equal(me.body.tools.web.spentUsd, 0.008);
      assert.equal(me.body.tools.web.calls, 2);
      assert.equal(me.body.tools.web.capReached, false);
      assert.deepEqual(me.body.features.tools, { search: true, fetch: true, proxy: false });
      const bobMe = await call(h, await asEmail(h, bob), "GET", "/api/me");
      assert.equal(bobMe.body.tools.web.spentUsd, 0);
    } finally {
      await h.close();
    }
  });

  test("the cap is hard: a call whose most possible cost doesn't fit is refused before it goes out", async () => {
    const search = new FakeSearch(); // reserves 0.01, costs 0.007
    const { h, alice, admin } = await setup({ search });
    try {
      const t = await createTask(h, alice);
      const s = await session(h, t);
      // cap 0.025: spent 0, 0.007, 0.014 (+0.01 reserved each) fit; 0.021 + 0.01 does not
      for (let i = 0; i < 3; i++) assert.equal((await call(h, s, "POST", "/api/session/tools/search", { query: `q${i}` })).status, 200);
      const before = search.calls.length;
      const no = await call(h, s, "POST", "/api/session/tools/search", { query: "one too many" });
      assert.equal(no.status, 429);
      assert.equal(no.body.error.code, "tools_cap");
      assert.equal(search.calls.length, before, "the provider was never called");
      // told once (user + admins), not on every refusal
      await call(h, s, "POST", "/api/session/tools/search", { query: "again" });
      const notices = (await call(h, await asEmail(h, alice), "GET", "/api/notices")).body.notices.filter((n: { kind: string }) => n.kind === "tools_cap");
      assert.equal(notices.length, 1);
      const adminNotices = (await call(h, await asEmail(h, admin), "GET", "/api/notices")).body.notices.filter((n: { kind: string }) => n.kind === "tools_cap");
      assert.equal(adminNotices.length, 1);
      assert.match(adminNotices[0].text, /alice@example.org/);

      // an admin raises Alice's cap: calls go through again
      const aid = await userId(h, alice);
      const p = await call(h, await asEmail(h, admin), "PATCH", `/api/users/${aid}/limits`, { toolsMonthlyUsd: 1 });
      assert.equal(p.status, 200);
      assert.equal(p.body.tools.web.capUsd, 1);
      assert.equal(p.body.tools.web.override, true);
      assert.equal((await call(h, s, "POST", "/api/session/tools/search", { query: "now ok" })).status, 200);

      // a new month starts from zero
      h.clock.advance(31 * 24 * 3600_000);
      const me = await call(h, await asEmail(h, alice), "GET", "/api/me");
      assert.equal(me.body.tools.web.spentUsd, 0);
    } finally {
      await h.close();
    }
  });

  test("concurrent calls can't overshoot the cap together", async () => {
    const search = new FakeSearch();
    search.max = 0.01;
    search.cost = 0.01;
    const { h, alice } = await setup({ search });
    try {
      const t = await createTask(h, alice);
      const s = await session(h, t);
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => call(h, s, "POST", "/api/session/tools/search", { query: `p${i}` })));
      assert.equal(rs.filter((r) => r.status === 200).length, 2); // 0.025 / 0.01
      assert.equal(rs.filter((r) => r.status === 429).length, 6);
      const me = await call(h, await asEmail(h, alice), "GET", "/api/me");
      assert.ok(me.body.tools.web.spentUsd <= 0.025);
    } finally {
      await h.close();
    }
  });

  test("a failed call costs nothing; a provider charging more than reserved is cut to the reservation", async () => {
    const search = new FakeSearch();
    const { h, alice } = await setup({ search });
    try {
      const t = await createTask(h, alice);
      const s = await session(h, t);
      search.fail = "provider down (key sk-org-SECRET must never show)";
      const r = await call(h, s, "POST", "/api/session/tools/search", { query: "x" });
      assert.equal(r.status, 502);
      assert.equal(r.body.error.code, "upstream");
      search.fail = null;
      search.cost = 5;
      const r2 = await call(h, s, "POST", "/api/session/tools/search", { query: "x" });
      assert.equal(r2.status, 200);
      assert.equal(r2.body.costUsd, 0.01);
      assert.equal(r2.body.spentUsd, 0.01);
    } finally {
      await h.close();
    }
  });

  test("the instance-wide cap stops everyone", async () => {
    const search = new FakeSearch();
    search.cost = 0.01;
    const { h, alice, bob } = await setup({ search }, { tools: { ...TOOLS_CFG, monthlyUsd: 0.025 } });
    try {
      const sa = await session(h, await createTask(h, alice));
      const sb = await session(h, await createTask(h, bob));
      assert.equal((await call(h, sa, "POST", "/api/session/tools/search", { query: "a" })).status, 200);
      assert.equal((await call(h, sb, "POST", "/api/session/tools/search", { query: "b" })).status, 200);
      const no = await call(h, sb, "POST", "/api/session/tools/search", { query: "c" });
      assert.equal(no.status, 429);
      assert.match(no.body.error.message, /instance/);
    } finally {
      await h.close();
    }
  });

  test("bad requests are refused before any spend", async () => {
    const search = new FakeSearch();
    const fetchP = new FakeFetch();
    const { h, alice } = await setup({ search, fetch: fetchP });
    try {
      const s = await session(h, await createTask(h, alice));
      for (const body of [{}, { query: "" }, { query: "x", numResults: 50 }, { query: "x", since: "yesterday" }, { query: "x", includeDomains: ["a b"] }]) {
        assert.equal((await call(h, s, "POST", "/api/session/tools/search", body)).status, 400, JSON.stringify(body));
      }
      for (const body of [{ url: "file:///etc/passwd" }, { url: "not a url" }, { url: "https://x.org", render: "yes" }, { url: "https://x.org", format: "pdf" }]) {
        assert.equal((await call(h, s, "POST", "/api/session/tools/fetch", body)).status, 400, JSON.stringify(body));
      }
      assert.equal(search.calls.length + fetchP.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  test("tools not configured: 409 and no tools view", async () => {
    const h = await harness();
    try {
      const { alice } = await seedUsers(h);
      const s = await session(h, await createTask(h, alice));
      assert.equal((await call(h, s, "POST", "/api/session/tools/search", { query: "x" })).status, 409);
      const me = await call(h, await asEmail(h, alice), "GET", "/api/me");
      assert.equal(me.body.tools, undefined);
    } finally {
      await h.close();
    }
  });
});

describe("authorisation", () => {
  test("usage is visible to its owner and admins only; caps are set by admins only", async () => {
    const search = new FakeSearch();
    const { h, alice, bob, admin } = await setup({ search });
    try {
      const sa = await session(h, await createTask(h, alice));
      await call(h, sa, "POST", "/api/session/tools/search", { query: "alice's secret query" });
      const aid = await userId(h, alice);
      const bid = await userId(h, bob);
      // Bob can't see Alice's usage, or set anyone's caps (the uniform 404)
      assert.equal((await call(h, await asEmail(h, bob), "GET", `/api/users/${aid}`)).status, 404);
      assert.equal((await call(h, await asEmail(h, bob), "PATCH", `/api/users/${bid}/limits`, { toolsMonthlyUsd: 1000 })).status, 404);
      assert.equal((await call(h, await asEmail(h, bob), "GET", "/api/admin/tools")).status, 404);
      // Alice sees her own; the admin sees hers and the totals
      assert.equal((await call(h, await asEmail(h, alice), "GET", `/api/users/me`)).body.tools.web.calls, 1);
      const seen = await call(h, await asEmail(h, admin), "GET", `/api/users/${aid}`);
      assert.equal(seen.body.tools.web.calls, 1);
      const tools = await call(h, await asEmail(h, admin), "GET", "/api/admin/tools");
      assert.equal(tools.status, 200);
      assert.deepEqual(tools.body.search, { provider: "fake-search" });
      assert.equal(tools.body.web.calls, 1);
      // no query text is kept anywhere a view could show it
      assert.doesNotMatch(JSON.stringify(seen.body) + JSON.stringify(tools.body), /secret query/);
    } finally {
      await h.close();
    }
  });

  test("only a session token reaches the tool routes, and only for its own owner's account", async () => {
    const search = new FakeSearch();
    const { h, alice, bob } = await setup({ search });
    try {
      const ta = await createTask(h, alice);
      // a person (even the owner) can't spend through the session routes
      assert.equal((await call(h, await asEmail(h, alice), "POST", "/api/session/tools/search", { query: "x" })).status, 401);
      // the gate without a token, or with a wrong one
      assert.equal((await call(h, await asService(h, GATE), "POST", "/api/session/tools/search", { query: "x" })).status, 401);
      assert.equal((await call(h, await asService(h, GATE, "nope"), "POST", "/api/session/tools/search", { query: "x" })).status, 401);
      // a session token can't read user routes
      assert.equal((await call(h, await session(h, ta), "GET", "/api/me")).status, 403);
      // Bob's session spends Bob's allowance, not Alice's
      const tb = await createTask(h, bob);
      await call(h, await session(h, tb), "POST", "/api/session/tools/search", { query: "b" });
      assert.equal((await call(h, await asEmail(h, alice), "GET", "/api/me")).body.tools.web.calls, 0);
      assert.equal((await call(h, await asEmail(h, bob), "GET", "/api/me")).body.tools.web.calls, 1);
      // a paused task's token is dead
      await call(h, await asEmail(h, alice), "POST", `/api/tasks/${ta}/pause`);
      const old = sessionTokenOf(h, ta);
      await h.jarvis.settle();
      assert.equal((await call(h, await asService(h, GATE, old), "POST", "/api/session/tools/search", { query: "x" })).status, 401);
    } finally {
      await h.close();
    }
  });

  test("an offboarded user's session can't spend", async () => {
    const search = new FakeSearch();
    const { h, alice } = await setup({ search });
    try {
      const t = await createTask(h, alice);
      const tok = sessionTokenOf(h, t);
      h.directory.set(alice, { name: "Alice", groups: ["jarvis-staff@example.org"], suspended: true });
      await h.jarvis.syncDirectory();
      const r = await call(h, await asService(h, GATE, tok), "POST", "/api/session/tools/search", { query: "x" });
      assert.ok(r.status === 401 || r.status === 403, String(r.status));
      assert.equal(search.calls.length, 0);
    } finally {
      await h.close();
    }
  });
});

describe("proxy sub-accounts (subuser providers)", () => {
  test("minted with the cap on the first task, refilled every month, resized on a cap change, deleted at offboarding", async () => {
    const proxy = new FakeSubUserProxy();
    const { h, alice, admin } = await setup({ proxy });
    try {
      const t = await createTask(h, alice);
      const env = machineOf(h, t)!.env;
      const p = JSON.parse(env.JARVIS_PROXY!);
      assert.equal(p.host, "proxy.example.net");
      assert.equal(p.port, 12321);
      assert.deepEqual(p.targeting, { field: "password", country: "_country-{c}", session: "_session-{s}" });
      assert.equal(proxy.subs.size, 1);
      const [id, sub] = [...proxy.subs.entries()][0]!;
      assert.equal(sub.available, 1); // staff: 1 GB
      assert.equal(p.username, sub.login.username);
      // a second task reuses it
      await createTask(h, alice, "again");
      assert.equal(proxy.subs.size, 1);

      // the provider stops the account at its allocation
      assert.equal(proxy.use(id, 0.75), true);
      assert.equal(proxy.use(id, 0.5), false);
      h.clock.advance(20 * 60_000);
      await h.jarvis.tick();
      let me = (await call(h, await asEmail(h, alice), "GET", "/api/me")).body;
      assert.equal(me.tools.proxy.mode, "subuser");
      assert.equal(me.tools.proxy.usedGb, 0.75);
      assert.equal(me.tools.proxy.capReached, false);

      // an admin raises the cap to 2 GB: 1.25 more becomes available at once
      const aid = await userId(h, alice);
      assert.equal((await call(h, await asEmail(h, admin), "PATCH", `/api/users/${aid}/limits`, { proxyMonthlyGb: 2 })).status, 200);
      assert.equal(sub.available, 1.25);

      // next month: the account is refilled to the full cap, and use counts from zero
      h.clock.advance(31 * 24 * 3600_000);
      await h.jarvis.tick();
      assert.equal(sub.available, 2);
      me = (await call(h, await asEmail(h, alice), "GET", "/api/me")).body;
      assert.equal(me.tools.proxy.usedGb, 0);

      // offboarding deletes the sub-account (its unused GB go back to the organisation)
      h.directory.set(alice, { name: "Alice", groups: ["jarvis-staff@example.org"], suspended: true });
      await h.jarvis.syncDirectory();
      await h.jarvis.settle();
      assert.equal(proxy.subs.size, 0);
      assert.ok(proxy.log.some((l) => l.startsWith("delete")));
    } finally {
      await h.close();
    }
  });

  test("a cap of 0 means no proxy; a provider outage doesn't stop the task", async () => {
    const proxy = new FakeSubUserProxy();
    const { h, alice, bob, admin } = await setup({ proxy });
    try {
      const bid = await userId(h, bob);
      await call(h, await asEmail(h, admin), "PATCH", `/api/users/${bid}/limits`, { proxyMonthlyGb: 0 });
      const tb = await createTask(h, bob);
      assert.equal(machineOf(h, tb)!.env.JARVIS_PROXY, undefined);
      proxy.fail = "IPRoyal down";
      const ta = await createTask(h, alice);
      assert.equal(machineOf(h, ta)!.env.JARVIS_PROXY, undefined);
      assert.ok(h.logs.some((l) => l.includes("starts without a proxy")));
      const st = await call(h, await asEmail(h, alice), "GET", `/api/tasks/${ta}`);
      assert.notEqual(st.body.state, "failed");
    } finally {
      await h.close();
    }
  });

  test("a subuser provider refuses a role with no cap at start-up", async () => {
    await assert.rejects(
      () => harness({ config: { roles: { ...ROLES, staff: { ...ROLES.staff, proxyMonthlyGb: null } }, tools: TOOLS_CFG }, tools: { search: null, fetch: null, proxy: new FakeSubUserProxy() } }),
      /proxyMonthlyGb/,
    );
  });
});

// ---- the metered relay -----------------------------------------------------------------------------

/** A CONNECT proxy that wants the org login, and an echo target behind it. */
async function relayWorld(login = { username: "org-user", password: "org-secret" }) {
  const seen: { target: string; auth: string }[] = [];
  const echo = net.createServer((c) => c.pipe(c));
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", () => r()));
  const proxy: Server = createServer((_req, res) => res.writeHead(405).end());
  proxy.on("connect", (req, sock: net.Socket, head) => {
    const auth = Buffer.from(String(req.headers["proxy-authorization"] || "").replace(/^Basic /, ""), "base64").toString();
    seen.push({ target: req.url || "", auth });
    if (!auth.startsWith(`${login.username}:${login.password}`)) {
      sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    // every target goes to the echo server (the test's stand-in for the internet)
    const up = net.connect((echo.address() as AddressInfo).port, "127.0.0.1", () => {
      sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on("error", () => sock.destroy());
    sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  return {
    seen,
    endpoint: { host: "127.0.0.1", port: (proxy.address() as AddressInfo).port },
    close: async () => {
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
      await new Promise((r) => echo.close(r));
    },
  };
}

function tunnel(h: Harness, cred: Cred, q: string): Promise<{ ws: WebSocket; first: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "cf-access-jwt-assertion": cred.jwt! };
    if (cred.bearer) headers.authorization = `Bearer ${cred.bearer}`;
    const ws = new WebSocket(`${h.wsBase}/api/session/proxy?${q}`, { headers });
    ws.once("unexpected-response", (_r, res) => {
      reject(Object.assign(new Error(`refused ${res.statusCode}`), { status: res.statusCode }));
      ws.terminate();
    });
    ws.once("error", reject);
    ws.once("message", (d) => resolve({ ws, first: d.toString() }));
  });
}
const echoOnce = (ws: WebSocket, data: Buffer): Promise<Buffer> =>
  new Promise((resolve) => {
    let got = Buffer.alloc(0);
    const on = (d: Buffer) => {
      got = Buffer.concat([got, d]);
      if (got.length >= data.length) {
        ws.off("message", on);
        resolve(got);
      }
    };
    ws.on("message", on);
    ws.send(data);
  });

describe("metered proxy relay (relay providers)", () => {
  test("a session tunnels through the org's proxy; the bytes count against its owner; the org login stays on the server", async () => {
    const world = await relayWorld();
    const proxy = new FakeRelayProxy(world.endpoint);
    const { h, alice } = await setup({ proxy });
    try {
      const t = await createTask(h, alice);
      assert.equal(machineOf(h, t)!.env.JARVIS_PROXY, undefined, "no proxy login in the machine");
      assert.doesNotMatch(JSON.stringify(machineOf(h, t)!.env), /org-secret/);
      const { ws, first } = await tunnel(h, await session(h, t), "host=example.com&port=443&country=DE&session=abc123");
      assert.deepEqual(JSON.parse(first), { ok: true });
      assert.equal(world.seen[0]!.target, "example.com:443");
      assert.equal(world.seen[0]!.auth, "org-user:org-secret_country-de_session-abc123");
      const data = Buffer.alloc(100_000, 7);
      const back = await echoOnce(ws, data);
      assert.equal(back.length, data.length);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
      const me = (await call(h, await asEmail(h, alice), "GET", "/api/me")).body;
      assert.equal(me.tools.proxy.mode, "relay");
      assert.ok(Math.abs(me.tools.proxy.usedGb - 0.0002) < 1e-9, String(me.tools.proxy.usedGb)); // 100 kB each way
      const view = await call(h, await session(h, t), "GET", "/api/session/tools");
      assert.equal(view.body.proxy, "relay");
    } finally {
      await h.close();
      await world.close();
    }
  });

  test("the cap closes a running tunnel and refuses new ones", async () => {
    const world = await relayWorld();
    const proxy = new FakeRelayProxy(world.endpoint);
    const { h, alice, admin } = await setup({ proxy });
    try {
      const aid = await userId(h, alice);
      await call(h, await asEmail(h, admin), "PATCH", `/api/users/${aid}/limits`, { proxyMonthlyGb: 0.0003 }); // 300 kB
      const t = await createTask(h, alice);
      const s = await session(h, t);
      const { ws } = await tunnel(h, s, "host=example.com&port=443");
      ws.on("error", () => {}); // the server cuts it off mid-send
      const closedP = new Promise<number>((r) => ws.once("close", (code) => r(code)));
      for (let i = 0; i < 4 && ws.readyState === ws.OPEN; i++) {
        ws.send(Buffer.alloc(60_000, 1));
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(await closedP, 4029);
      await assert.rejects(() => tunnel(h, s, "host=example.com&port=443"), (e: { status?: number }) => e.status === 429);
      const notices = (await call(h, await asEmail(h, alice), "GET", "/api/notices")).body.notices;
      assert.equal(notices.filter((n: { kind: string }) => n.kind === "tools_cap").length, 1);
    } finally {
      await h.close();
      await world.close();
    }
  });

  test("tunnel targets are checked; people and other kinds of caller can't open one", async () => {
    const world = await relayWorld();
    const proxy = new FakeRelayProxy(world.endpoint);
    const { h, alice } = await setup({ proxy });
    try {
      const t = await createTask(h, alice);
      const s = await session(h, t);
      for (const q of ["host=example.com&port=22", "host=a%0d%0ab&port=443", "host=example.com&port=443&country=deu", "port=443"]) {
        await assert.rejects(() => tunnel(h, s, q), (e: { status?: number }) => e.status === 400, q);
      }
      const person = await asEmail(h, alice);
      const gate = await asService(h, GATE);
      await assert.rejects(() => tunnel(h, person, "host=example.com&port=443"), (e: { status?: number }) => e.status === 401);
      await assert.rejects(() => tunnel(h, gate, "host=example.com&port=443"), (e: { status?: number }) => e.status === 401);
      assert.equal(world.seen.length, 0);
    } finally {
      await h.close();
      await world.close();
    }
  });

  test("the provider refusing the login is reported, not retried with anything else", async () => {
    const world = await relayWorld({ username: "org-user", password: "other" });
    const proxy = new FakeRelayProxy(world.endpoint);
    const { h, alice } = await setup({ proxy });
    try {
      const t = await createTask(h, alice);
      const { ws, first } = await tunnel(h, await session(h, t), "host=example.com&port=443");
      const msg = JSON.parse(first);
      assert.equal(msg.ok, false);
      assert.doesNotMatch(first, /org-secret/);
      ws.close();
    } finally {
      await h.close();
      await world.close();
    }
  });
});
