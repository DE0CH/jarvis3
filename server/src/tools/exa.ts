// Exa (api.exa.ai): search, and /contents as a fetch provider. Server-metered with the org key.
// Every response reports its own cost (costDollars.total), which is what the user is charged,
// never more than the reserved maximum. List prices (exa.ai/docs/admin/pricing, 2026-10-10):
// /search auto USD 7 per 1k requests (+ USD 1 per 1k results beyond 10), contents text USD 1 per
// 1k pages. Exa's Team Management API can also mint per-user keys with a budget (it has to be
// enabled by Exa support); docs/TOOLS.md says how that would slot in.
import type { FetchProvider, FetchRequest, FetchResult, Priced, SearchProvider, SearchRequest, SearchResult } from "./types.ts";
import { callJson, num, strSetting, type AdapterOptions } from "./http.ts";

const BASE = "https://api.exa.ai";

interface ExaResult {
  title?: string | null;
  url: string;
  publishedDate?: string | null;
  text?: string;
  highlights?: string[];
  summary?: string;
}
interface ExaResponse {
  results: ExaResult[];
  costDollars?: { total?: number };
  statuses?: { id: string; status: string; error?: { httpStatusCode?: number; tag?: string } }[];
}

abstract class ExaBase {
  readonly name = "exa";
  protected readonly o: AdapterOptions;
  protected readonly f: typeof fetch;
  constructor(o: AdapterOptions) {
    this.o = o;
    this.f = o.fetch ?? globalThis.fetch;
  }
  protected post<T>(path: string, body: unknown): Promise<T> {
    return callJson<T>(this.f, "Exa", (this.o.baseUrl ?? BASE) + path, {
      method: "POST",
      headers: { "x-api-key": this.o.key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
}

export class ExaSearch extends ExaBase implements SearchProvider {
  maxCostUsd(req: SearchRequest): number {
    const p = this.o.pricing;
    const perCall = num(p?.perCallUsd, 0.007);
    return perCall + Math.max(0, req.numResults - 10) * 0.001 + (req.textChars ? req.numResults * 0.001 : 0);
  }
  async search(req: SearchRequest): Promise<Priced<SearchResult[]>> {
    const body: Record<string, unknown> = {
      query: req.query,
      type: strSetting(this.o.settings, "type", "auto"),
      numResults: req.numResults,
      contents: req.textChars ? { text: { maxCharacters: req.textChars } } : { highlights: { maxCharacters: 400 } },
    };
    if (req.includeDomains) body.includeDomains = req.includeDomains;
    if (req.since) body.startPublishedDate = `${req.since}T00:00:00.000Z`;
    if (req.country) body.userLocation = req.country.toUpperCase();
    const r = await this.post<ExaResponse>("/search", body);
    const results = (r.results ?? []).map((x) => ({
      title: x.title ?? "",
      url: x.url,
      snippet: (x.highlights?.join(" … ") || x.summary || x.text || "").slice(0, 500),
      ...(x.publishedDate ? { publishedDate: x.publishedDate } : {}),
      ...(req.textChars && x.text ? { text: x.text } : {}),
    }));
    return { value: results, costUsd: num(r.costDollars?.total, this.maxCostUsd(req)) };
  }
}

/** Exa /contents: the page's text from Exa's crawl (`render` asks for a fresh crawl, maxAgeHours 0). Text only: no raw HTML. */
export class ExaFetch extends ExaBase implements FetchProvider {
  maxCostUsd(_req: FetchRequest): number {
    return num(this.o.pricing?.perCallUsd, 0.001);
  }
  async fetch(req: FetchRequest): Promise<Priced<FetchResult>> {
    const r = await this.post<ExaResponse>("/contents", { urls: [req.url], text: true, ...(req.render ? { maxAgeHours: 0 } : {}) });
    const st = r.statuses?.[0];
    const page = r.results?.[0];
    const status = st && st.status !== "success" ? (st.error?.httpStatusCode ?? 0) : 200;
    return {
      value: { status: page ? status : status || 404, contentType: "text/plain; charset=utf-8", body: page?.text ?? "", ...(page?.url ? { finalUrl: page.url } : {}) },
      costUsd: num(r.costDollars?.total, this.maxCostUsd(req)),
    };
  }
}
