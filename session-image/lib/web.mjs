// Tier 0 web tools on the session side (docs/TOOLS.md): what the OpenCode tools (web_search,
// web_fetch in lib/opencode-plugin.mjs) and the `jarvis-web` command send to jarvis-agent's socket,
// and how the answers are written for the model. The server meters every call against the task
// owner's monthly allowance; the organisation's keys never enter the machine.
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { errorText } from "./policy.mjs";

/** How much of a fetched page goes into the model's context (the whole page is saved to a file). */
export const DEFAULT_INLINE_CHARS = 30_000;

const money = (n) => (n === null || n === undefined ? "no cap" : `USD ${Number(n).toFixed(n < 1 ? 4 : 2)}`);

/** One line on what is left this month. */
export function allowanceLine(r) {
  if (r.capUsd === null || r.capUsd === undefined) return `Web tools spend this month: ${money(r.spentUsd)} (no cap).`;
  return `Web tools spend this month: ${money(r.spentUsd)} of ${money(r.capUsd)}.`;
}

/** Search results as compact text for the model. */
export function formatSearch(r) {
  if (!r.results.length) return `No results. ${allowanceLine(r)}`;
  const lines = r.results.map((x, i) => {
    const date = x.publishedDate ? ` (${x.publishedDate.slice(0, 10)})` : "";
    const text = x.text ? `\n   text: ${x.text.replace(/\s+/g, " ").trim()}` : "";
    return `${i + 1}. ${x.title || "(no title)"}${date}\n   ${x.url}\n   ${(x.snippet || "").replace(/\s+/g, " ").trim()}${text}`;
  });
  return `${lines.join("\n")}\n\n(${r.provider}; this search cost ${money(r.costUsd)}. ${allowanceLine(r)})`;
}

/** File name for a fetched page: host + short hash, under dir. */
export function pagePath(dir, url, contentType) {
  let host = "page";
  try {
    host = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, "_");
  } catch {
    /* keep "page" */
  }
  const ext = /html/.test(contentType || "") ? "html" : /json/.test(contentType || "") ? "json" : "txt";
  const h = createHash("sha256").update(url).digest("hex").slice(0, 10);
  return join(dir, `${host}-${h}.${ext}`);
}

/** Save the page and say what came back; the first `inlineChars` go into the answer. */
export function fetchOutput(r, { url, dir, inlineChars = DEFAULT_INLINE_CHARS }) {
  mkdirSync(dir, { recursive: true });
  const file = pagePath(dir, r.finalUrl || url, r.contentType);
  writeFileSync(file, r.body);
  const cut = r.body.length > inlineChars;
  const head = [
    `HTTP ${r.status} ${r.contentType || ""}`.trim(),
    r.finalUrl && r.finalUrl !== url ? `Final URL: ${r.finalUrl}` : null,
    `Saved in full (${r.body.length} characters${r.truncated ? ", cut to the server's limit" : ""}) to ${file}${cut ? `; the first ${inlineChars} characters follow` : ""}.`,
    `(${r.provider}; this fetch cost ${money(r.costUsd)}. ${allowanceLine(r)})`,
  ].filter(Boolean);
  return `${head.join("\n")}\n\n${cut ? r.body.slice(0, inlineChars) : r.body}`;
}

/** POST to the agent socket; the server's error message on failure (a cap says so plainly). */
export async function webCall(client, path, body) {
  const r = await client.post(path, body);
  if (r.status === 200) return r.body;
  const msg = errorText(r);
  if (r.status === 429) throw new Error(`Not done: ${msg}. Tell the user; don't try to get around it.`);
  throw new Error(`${path.endsWith("search") ? "Search" : "Fetch"} failed (${r.status}): ${msg}`);
}

/** The text the proxy section of the instructions and `jarvis-web proxy` give. */
export function proxyHelp(view, url) {
  if (!view?.proxy) return "No proxy is set up for this instance.";
  const u = view.proxyUsage;
  const used = u ? ` Used this month: ${u.usedGb} GB of ${u.capGb === null ? "no cap" : `${u.capGb} GB`}.` : "";
  return [
    `Proxy: ${url} (HTTP proxy; https goes through CONNECT). Exit country: put it in the proxy user name, e.g. http://country-de:x@127.0.0.1:3128; a sticky exit IP: country-us-session-ab12cd34 (8 letters/digits).`,
    `Examples: curl -x ${url} https://example.com   ·   HTTPS_PROXY=${url} python3 script.py   ·   chromium --proxy-server=${url}`,
    `Use it only when a site blocks this machine's own IP or needs a particular country; traffic counts against the user's monthly allowance.${used}`,
  ].join("\n");
}
