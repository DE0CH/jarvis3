// The Tier 0 provider adapters against recorded request/response shapes (a fake fetch): what each
// sends, how it reads the cost, and that the organisation's key never shows in an error.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ExaFetch, ExaSearch } from "../src/tools/exa.ts";
import { BraveSearch } from "../src/tools/brave.ts";
import { TavilySearch } from "../src/tools/tavily.ts";
import { ScrapingBeeFetch, scrapingBeeCredits } from "../src/tools/scrapingbee.ts";
import { IPRoyalProxy } from "../src/tools/iproyal.ts";
import { HttpRelayProxy } from "../src/tools/http-proxy.ts";
import { buildToolProviders } from "../src/tools/registry.ts";
import { loadToolSecrets } from "../src/config.ts";
import { testConfig } from "./helpers.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}
function fakeFetch(answer: (s: Seen) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const seen: Seen[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const s: Seen = { url: String(url), method: init?.method ?? "GET", headers, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    seen.push(s);
    const a = answer(s);
    const body = typeof a.body === "string" ? a.body : JSON.stringify(a.body ?? {});
    return new Response(body, { status: a.status ?? 200, headers: a.headers ?? { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}
const KEY = "ORG-KEY-must-not-leak";

describe("search adapters", () => {
  test("exa: request shape, cost from costDollars, capped at the reservation by the caller", async () => {
    const { f, seen } = fakeFetch(() => ({ body: { results: [{ title: "T", url: "https://a.org", publishedDate: "2026-10-01", highlights: ["h1"], text: "full text" }], costDollars: { total: 0.008 } } }));
    const exa = new ExaSearch({ key: KEY, fetch: f });
    const req = { query: "q", numResults: 12, textChars: 1000, since: "2026-01-01", includeDomains: ["a.org"], country: "gb" };
    assert.equal(Math.round(exa.maxCostUsd(req) * 1e6) / 1e6, 0.007 + 0.002 + 0.012);
    const r = await exa.search(req);
    assert.equal(seen[0]!.url, "https://api.exa.ai/search");
    assert.equal(seen[0]!.headers["x-api-key"], KEY);
    assert.deepEqual(seen[0]!.body, { query: "q", type: "auto", numResults: 12, contents: { text: { maxCharacters: 1000 } }, includeDomains: ["a.org"], startPublishedDate: "2026-01-01T00:00:00.000Z", userLocation: "GB" });
    assert.equal(r.costUsd, 0.008);
    assert.deepEqual(r.value[0], { title: "T", url: "https://a.org", snippet: "h1", publishedDate: "2026-10-01", text: "full text" });
  });

  test("exa: an error carries the status, never the key; baseUrl and pricing overrides", async () => {
    const { f, seen } = fakeFetch(() => ({ status: 402, body: { error: "budget exceeded" } }));
    const exa = new ExaSearch({ key: KEY, fetch: f, baseUrl: "http://stub:1", pricing: { perCallUsd: 0.004 } });
    assert.equal(exa.maxCostUsd({ query: "q", numResults: 5 }), 0.004);
    await assert.rejects(() => exa.search({ query: "q", numResults: 5 }), (e: Error) => /Exa answered 402/.test(e.message) && !e.message.includes(KEY));
    assert.equal(seen[0]!.url, "http://stub:1/search");
  });

  test("exa contents as fetch: text only, per-page status", async () => {
    const { f, seen } = fakeFetch(() => ({ body: { results: [{ url: "https://a.org/x", text: "page text" }], statuses: [{ id: "https://a.org/x", status: "success" }], costDollars: { total: 0.001 } } }));
    const r = await new ExaFetch({ key: KEY, fetch: f }).fetch({ url: "https://a.org/x", render: true, premium: false, format: "text" });
    assert.deepEqual(seen[0]!.body, { urls: ["https://a.org/x"], text: true, maxAgeHours: 0 });
    assert.equal(r.value.status, 200);
    assert.equal(r.value.body, "page text");
    assert.equal(r.costUsd, 0.001);
  });

  test("brave: token header, flat price", async () => {
    const { f, seen } = fakeFetch(() => ({ body: { web: { results: [{ title: "B", url: "https://b.org", description: "<strong>d</strong>", page_age: "2026-01-01" }] } } }));
    const r = await new BraveSearch({ key: KEY, fetch: f }).search({ query: "q", numResults: 3, includeDomains: ["b.org"], country: "de" });
    const u = new URL(seen[0]!.url);
    assert.equal(u.origin + u.pathname, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(u.searchParams.get("q"), "q site:b.org");
    assert.equal(u.searchParams.get("count"), "3");
    assert.equal(u.searchParams.get("country"), "DE");
    assert.equal(seen[0]!.headers["x-subscription-token"], KEY);
    assert.equal(r.costUsd, 0.005);
    assert.equal(r.value[0]!.snippet, "d");
  });

  test("tavily: credits reported by include_usage", async () => {
    const { f, seen } = fakeFetch(() => ({ body: { results: [{ title: "T", url: "https://t.org", content: "c" }], usage: { credits: 1 } } }));
    const r = await new TavilySearch({ key: KEY, fetch: f }).search({ query: "q", numResults: 4 });
    assert.equal(seen[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen[0]!.body.include_usage, true);
    assert.equal(seen[0]!.body.search_depth, "basic");
    assert.equal(r.costUsd, 0.008);
  });
});

describe("fetch adapters", () => {
  test("scrapingbee: render_js always explicit, credits from Spb-cost", async () => {
    const { f, seen } = fakeFetch((s) => ({
      body: "<html>ok</html>",
      headers: { "content-type": "text/html", "spb-cost": new URL(s.url).searchParams.get("render_js") === "true" ? "5" : "1", "spb-initial-status-code": "200", "spb-resolved-url": "https://final.org/" },
    }));
    const sb = new ScrapingBeeFetch({ key: KEY, fetch: f, pricing: { perCreditUsd: 0.001 } });
    const plain = await sb.fetch({ url: "https://a.org", render: false, premium: false, format: "html" });
    assert.equal(new URL(seen[0]!.url).searchParams.get("render_js"), "false");
    assert.equal(plain.costUsd, 0.001);
    assert.equal(plain.value.finalUrl, "https://final.org/");
    const js = await sb.fetch({ url: "https://a.org", render: true, premium: true, country: "de", format: "text" });
    const q = new URL(seen[1]!.url).searchParams;
    assert.equal(q.get("premium_proxy"), "true");
    assert.equal(q.get("country_code"), "de");
    assert.equal(q.get("return_page_text"), "true");
    assert.equal(js.costUsd, 0.005);
    assert.equal(sb.maxCostUsd({ url: "x", render: true, premium: true, format: "html" }), 0.025);
    assert.deepEqual([false, true].flatMap((p) => [false, true].map((r) => scrapingBeeCredits({ url: "", render: r, premium: p, format: "html" }))), [1, 5, 10, 25]);
  });

  test("scrapingbee: the target's own status passes through; ScrapingBee's error (no Spb-cost) is an upstream error without the key", async () => {
    const { f } = fakeFetch(() => ({ status: 404, body: "not found", headers: { "spb-cost": "1", "content-type": "text/html" } }));
    const r = await new ScrapingBeeFetch({ key: KEY, fetch: f }).fetch({ url: "https://a.org", render: false, premium: false, format: "html" });
    assert.equal(r.value.status, 404);
    const bad = fakeFetch(() => ({ status: 401, body: { message: "Invalid api key" } }));
    await assert.rejects(
      () => new ScrapingBeeFetch({ key: KEY, fetch: bad.f }).fetch({ url: "https://a.org", render: false, premium: false, format: "html" }),
      (e: Error) => /ScrapingBee answered 401/.test(e.message) && !e.message.includes(KEY),
    );
  });
});

describe("proxy adapters", () => {
  test("iproyal: create, set the available GB with give/take, read use, delete (404 = gone)", async () => {
    let available = 1;
    const { f, seen } = fakeFetch((s) => {
      if (s.method === "POST" && s.url.endsWith("/residential-subusers")) return { body: { hash: "H1", username: s.body.username, password: s.body.password, traffic_available: s.body.traffic, traffic_used: 0 } };
      if (s.method === "GET") return { body: { hash: "H1", username: "u", password: "p", traffic_available: available, traffic_used: 0.4 } };
      if (s.url.endsWith("/give-traffic")) available += s.body.amount;
      if (s.url.endsWith("/take-traffic")) available -= s.body.amount;
      if (s.method === "DELETE") return { status: 404, body: { message: "not found" } };
      return { body: {} };
    });
    const ip = new IPRoyalProxy({ key: KEY, fetch: f });
    const su = await ip.createSubUser("acme-user.1", 1);
    assert.equal(su.id, "H1");
    assert.equal(seen[0]!.url, "https://resi-api.iproyal.com/v1/residential-subusers");
    assert.equal(seen[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(seen[0]!.body.username, "acme_user_1");
    assert.equal(seen[0]!.body.traffic, 1);
    assert.match(seen[0]!.body.password, /^[A-Za-z0-9]{16}$/); // IPRoyal allows at most 16 characters
    await ip.setAvailableGb("H1", 2.5);
    assert.equal(available, 2.5);
    await ip.setAvailableGb("H1", 0.5);
    assert.equal(available, 0.5);
    assert.equal(await ip.usedGb("H1"), 0.4);
    await ip.deleteSubUser("H1");
    assert.deepEqual(ip.endpoint(), { host: "geo.iproyal.com", port: 12321 });
    assert.deepEqual(ip.targeting(), { field: "password", country: "_country-{c}", session: "_session-{s}_lifetime-30m", countryCase: "lower" });
  });

  test("evomi relay preset: org login with targeting, host and price", () => {
    const ev = new HttpRelayProxy("evomi", { key: "orguser:orgpass" });
    assert.deepEqual(ev.endpoint(), { host: "dcp.evomi.com", port: 2000 });
    assert.deepEqual(ev.login({ country: "us", session: "s1" }), { username: "orguser", password: "orgpass_country-US_session-s1" });
    assert.equal(ev.perGbUsd, 0.45);
    assert.throws(() => new HttpRelayProxy("evomi", { key: "no-colon" }), /username:password/);
    assert.throws(() => new HttpRelayProxy("http", { key: "a:b" }), /settings.host/);
  });
});

describe("registry", () => {
  const roles = {
    admin: { openrouterMonthlyUsd: 1, machineHoursPerMonth: null, admin: true, toolsMonthlyUsd: 1, proxyMonthlyGb: 1 },
    staff: { openrouterMonthlyUsd: 1, machineHoursPerMonth: 1, toolsMonthlyUsd: 1, proxyMonthlyGb: 1 },
  };
  test("builds what the config names, with the credentials from the env", () => {
    const c = testConfig({
      roles,
      tools: { search: { provider: "exa", credential: "EXA_KEY" }, fetch: { provider: "scrapingbee", credential: "SB_KEY" }, proxy: { provider: "iproyal", credential: "IPR_KEY" } },
    });
    assert.throws(() => loadToolSecrets(c, { EXA_KEY: "x" }), /missing secret env SB_KEY/);
    const p = buildToolProviders(c, loadToolSecrets(c, { EXA_KEY: "x", SB_KEY: "y", IPR_KEY: "z" }));
    assert.equal(p.search?.name, "exa");
    assert.equal(p.fetch?.name, "scrapingbee");
    assert.equal(p.proxy?.mode, "subuser");
  });
  test("an unknown provider or a missing credential refuses to start", () => {
    assert.throws(() => buildToolProviders(testConfig({ roles, tools: { search: { provider: "bing" } } }), {}), /unknown provider bing/);
    assert.throws(() => buildToolProviders(testConfig({ roles, tools: { search: { provider: "exa" } } }), {}), /needs a credential/);
  });
});
