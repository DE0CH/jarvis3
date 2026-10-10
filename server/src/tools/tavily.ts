// Tavily: basic search = 1 credit (advanced 2), USD 0.008 per credit pay-as-you-go
// (docs.tavily.com/documentation/api-credits, 2026-10-10); `include_usage` makes the response
// report the credits used. Per-user keys with a credit limit exist only on the Enterprise plan, so
// this adapter is server-metered.
import type { Priced, SearchProvider, SearchRequest, SearchResult } from "./types.ts";
import { callJson, num, strSetting, type AdapterOptions } from "./http.ts";

const BASE = "https://api.tavily.com";

interface TavilyResponse {
  results?: { title?: string; url: string; content?: string; raw_content?: string | null; published_date?: string }[];
  usage?: { credits?: number };
}

export class TavilySearch implements SearchProvider {
  readonly name = "tavily";
  readonly #o: AdapterOptions;
  readonly #f: typeof fetch;
  constructor(o: AdapterOptions) {
    this.#o = o;
    this.#f = o.fetch ?? globalThis.fetch;
  }
  #depth(): "basic" | "advanced" {
    return strSetting(this.#o.settings, "searchDepth", "basic") === "advanced" ? "advanced" : "basic";
  }
  #perCredit(): number {
    return num(this.#o.pricing?.perCreditUsd, 0.008);
  }
  maxCostUsd(_req: SearchRequest): number {
    return (this.#depth() === "advanced" ? 2 : 1) * this.#perCredit();
  }
  async search(req: SearchRequest): Promise<Priced<SearchResult[]>> {
    const body: Record<string, unknown> = { query: req.query, max_results: req.numResults, search_depth: this.#depth(), include_usage: true, include_raw_content: req.textChars ? "text" : false };
    if (req.includeDomains) body.include_domains = req.includeDomains;
    if (req.since) body.start_date = req.since;
    const j = await callJson<TavilyResponse>(this.#f, "Tavily", (this.#o.baseUrl ?? BASE) + "/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#o.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const results = (j.results ?? []).map((x) => ({
      title: x.title ?? "",
      url: x.url,
      snippet: (x.content ?? "").slice(0, 500),
      ...(x.published_date ? { publishedDate: x.published_date } : {}),
      ...(req.textChars && x.raw_content ? { text: x.raw_content.slice(0, req.textChars) } : {}),
    }));
    const credits = j.usage?.credits;
    return { value: results, costUsd: typeof credits === "number" ? credits * this.#perCredit() : this.maxCostUsd(req) };
  }
}
