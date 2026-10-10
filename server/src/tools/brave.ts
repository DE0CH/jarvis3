// Brave Search API: flat USD 5 per 1k requests (brave.com/search/api, 2026-10-10); responses
// report no cost, so a call costs pricing.perCallUsd. No per-user keys: server-metered.
import type { Priced, SearchProvider, SearchRequest, SearchResult } from "./types.ts";
import { num, providerError, TIMEOUT_MS, type AdapterOptions } from "./http.ts";

const BASE = "https://api.search.brave.com";

interface BraveResponse {
  web?: { results?: { title?: string; url: string; description?: string; page_age?: string; age?: string; extra_snippets?: string[] }[] };
}

export class BraveSearch implements SearchProvider {
  readonly name = "brave";
  readonly #o: AdapterOptions;
  readonly #f: typeof fetch;
  constructor(o: AdapterOptions) {
    this.#o = o;
    this.#f = o.fetch ?? globalThis.fetch;
  }
  maxCostUsd(_req: SearchRequest): number {
    return num(this.#o.pricing?.perCallUsd, 0.005);
  }
  async search(req: SearchRequest): Promise<Priced<SearchResult[]>> {
    const q = new URLSearchParams({ q: req.query, count: String(req.numResults) });
    if (req.country) q.set("country", req.country.toUpperCase());
    if (req.since) q.set("freshness", `${req.since}to${new Date().toISOString().slice(0, 10)}`);
    let query = req.query;
    if (req.includeDomains?.length) query += " " + req.includeDomains.map((d) => `site:${d}`).join(" OR ");
    q.set("q", query);
    const r = await this.#f(`${this.#o.baseUrl ?? BASE}/res/v1/web/search?${q}`, {
      headers: { "X-Subscription-Token": this.#o.key, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await r.text();
    if (!r.ok) throw providerError("Brave", r.status, text);
    const j = JSON.parse(text) as BraveResponse;
    const results = (j.web?.results ?? []).map((x) => ({
      title: x.title ?? "",
      url: x.url,
      snippet: [x.description ?? "", ...(x.extra_snippets ?? [])].join(" ").replace(/<\/?strong>/g, "").slice(0, 500),
      ...(x.page_age ? { publishedDate: x.page_age } : {}),
    }));
    return { value: results, costUsd: this.maxCostUsd(req) };
  }
}
