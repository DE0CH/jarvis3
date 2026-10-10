// The Tier 0 web tools on the session side: the OpenCode tools and the formatting, against a
// stand-in jarvis-agent socket; the preamble and the built-in skill.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowanceLine, fetchOutput, formatSearch, pagePath, proxyHelp } from "../lib/web.mjs";
import { renderInstructions, webSkill, writeLayers, WEB_SKILL } from "../lib/assemble.mjs";

const dir = mkdtempSync(join(tmpdir(), "jarvis-web-"));
const sock = join(dir, "agent.sock");
process.env.JARVIS_AGENT_SOCKET = sock;
process.env.HOME = dir;

const seen = [];
let capped = false;
let srv;
before(async () => {
  srv = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const reply = (s, b) => {
      res.writeHead(s, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    seen.push({ path: req.url, body });
    if (capped) return reply(429, { error: { code: "tools_cap", message: "this month's web-tools allowance (USD 5) is used up" } });
    if (req.url === "/guards") return reply(200, { guards: [] });
    if (req.url === "/tools/search")
      return reply(200, { provider: "exa", results: [{ title: "Jarvis", url: "https://j.example/", snippet: "an  agent\nplatform", publishedDate: "2026-10-01T00:00:00Z" }], costUsd: 0.007, spentUsd: 0.021, capUsd: 5 });
    if (req.url === "/tools/fetch") return reply(200, { provider: "scrapingbee", status: 200, contentType: "text/html", finalUrl: "https://j.example/final", body: "<html>" + "x".repeat(50_000) + "</html>", truncated: false, costUsd: 0.001, spentUsd: 0.022, capUsd: 5 });
    reply(404, { error: "no" });
  });
  await new Promise((r) => srv.listen(sock, r));
});
after(() => {
  srv.close();
  rmSync(dir, { recursive: true, force: true });
});

test("formatting: results, the allowance, pages saved in full", () => {
  assert.equal(allowanceLine({ spentUsd: 0.5, capUsd: 5 }), "Web tools spend this month: USD 0.5000 of USD 5.00.");
  assert.equal(allowanceLine({ spentUsd: 2, capUsd: null }), "Web tools spend this month: USD 2.00 (no cap).");
  assert.match(formatSearch({ provider: "exa", results: [], spentUsd: 0, capUsd: 1 }), /^No results\./);
  assert.match(pagePath("/d", "https://a.example/x?y", "text/html"), /^\/d\/a\.example-[0-9a-f]{10}\.html$/);
  assert.match(pagePath("/d", "not a url", "text/plain"), /^\/d\/page-[0-9a-f]{10}\.txt$/);
  const out = fetchOutput({ provider: "p", status: 200, contentType: "text/plain", body: "abcdef", truncated: false, costUsd: 0, spentUsd: 0, capUsd: 1 }, { url: "https://a.example/", dir: join(dir, "pages"), inlineChars: 3 });
  assert.match(out, /the first 3 characters follow/);
  assert.ok(out.endsWith("\n\nabc"));
  assert.match(proxyHelp({ proxy: "relay", proxyUsage: { usedGb: 0.1, capGb: 1 } }, "http://127.0.0.1:3128"), /country-de:x@127\.0\.0\.1:3128[\s\S]*0\.1 GB of 1 GB/);
  assert.equal(proxyHelp({ proxy: null }, "x"), "No proxy is set up for this instance.");
});

test("the plugin's web_search and web_fetch go to the agent socket; a cap is reported plainly", async () => {
  const { JarvisPolicyPlugin } = await import("../lib/opencode-plugin.mjs");
  const hooks = await JarvisPolicyPlugin({});
  const s = await hooks.tool.web_search.execute({ query: "jarvis", numResults: 3 }, {});
  assert.deepEqual(seen.find((x) => x.path === "/tools/search").body, { query: "jarvis", numResults: 3 });
  assert.match(s, /^1\. Jarvis \(2026-10-01\)\n   https:\/\/j\.example\/\n   an agent platform/);
  assert.match(s, /this search cost USD 0\.0070\. Web tools spend this month: USD 0\.0210 of USD 5\.00/);
  const f = await hooks.tool.web_fetch.execute({ url: "https://j.example/", render: true, inlineChars: 1000 }, {});
  assert.deepEqual(seen.find((x) => x.path === "/tools/fetch").body, { url: "https://j.example/", render: true });
  const file = /to (\S+); the first 1000/.exec(f)[1];
  assert.ok(file.startsWith(join(dir, "workspace", ".web")));
  assert.equal(readFileSync(file, "utf8").length, 50_013);
  assert.match(f, /Final URL: https:\/\/j\.example\/final/);
  // the guard hook also sees the web tools (a policy may guard them)
  await hooks["tool.execute.before"]({ tool: "web_fetch", sessionID: "s", callID: "c" }, { args: { url: "https://x" } });
  capped = true;
  await assert.rejects(hooks.tool.web_search.execute({ query: "x" }, {}), /^Error: Not done: this month's web-tools allowance \(USD 5\) is used up\. Tell the user/);
  capped = false;
});

test("preamble and the built-in skill follow what the instance has", () => {
  const bundle = { instructions: [], skills: [], deny: [] };
  const o = { workspace: "/w", orgDir: "/o", proxyUrl: "http://127.0.0.1:3128" };
  assert.doesNotMatch(renderInstructions(bundle, o), /web_search/);
  const all = { search: true, fetch: true, proxy: "relay" };
  const text = renderInstructions(bundle, { ...o, tools: all });
  assert.match(text, /use web_search \(a real search engine, current results\) and web_fetch/);
  assert.match(text, /A proxy is available at http:\/\/127\.0\.0\.1:3128/);
  assert.doesNotMatch(renderInstructions(bundle, { ...o, tools: { search: true, fetch: false, proxy: null } }), /web_fetch|proxy/);
  const skill = webSkill(all, o.proxyUrl);
  assert.match(skill, /^---\nname: jarvis-web\ndescription: /);
  assert.match(skill, /## Search[\s\S]*## Fetch[\s\S]*## Proxy[\s\S]*curl -x \$JARVIS_PROXY_URL/);
  assert.doesNotMatch(webSkill({ search: true, fetch: false, proxy: null }, o.proxyUrl), /## Fetch|## Proxy/);

  const d = mkdtempSync(join(tmpdir(), "layers-web-"));
  try {
    const opts = { jarvisDir: join(d, ".jarvis"), workspace: "/w", orgDir: "/o", model: "m/x", baseUrl: "", opencodeConfigPath: join(d, "oc.json"), proxyUrl: o.proxyUrl };
    writeLayers(bundle, { ...opts, tools: all });
    assert.ok(existsSync(join(d, `.jarvis/skills/${WEB_SKILL}/SKILL.md`)));
    // an org skill of that name wins; no tools, no skill
    writeLayers({ ...bundle, skills: [{ name: WEB_SKILL, originalName: WEB_SKILL, layer: "org", files: { "SKILL.md": "ORG WEB" } }] }, { ...opts, tools: all });
    assert.match(readFileSync(join(d, `.jarvis/skills/${WEB_SKILL}/SKILL.md`), "utf8"), /ORG WEB/);
    writeLayers(bundle, opts);
    assert.ok(!existsSync(join(d, `.jarvis/skills/${WEB_SKILL}`)));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
