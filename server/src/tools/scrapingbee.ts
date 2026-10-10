// ScrapingBee HTML API (scrapingbee.com/documentation, 2026-10-10): GET /api/v1/?url=…
// Credits per call: 1 plain, 5 with JavaScript, 10 premium proxy, 25 premium + JavaScript; the
// `Spb-cost` response header says what a call cost. render_js defaults to TRUE at ScrapingBee, so
// it is always sent explicitly. A response without Spb-cost is ScrapingBee's own error (not
// charged). No per-user keys: server-metered. USD per credit from the plan (default: the USD 49 /
// 250k-credit plan = 0.000196).
import type { FetchProvider, FetchRequest, FetchResult, Priced } from "./types.ts";
import { num, providerError, TIMEOUT_MS, type AdapterOptions } from "./http.ts";

const BASE = "https://app.scrapingbee.com";

export function scrapingBeeCredits(req: FetchRequest): number {
  if (req.premium) return req.render ? 25 : 10;
  return req.render ? 5 : 1;
}

export class ScrapingBeeFetch implements FetchProvider {
  readonly name = "scrapingbee";
  readonly #o: AdapterOptions;
  readonly #f: typeof fetch;
  constructor(o: AdapterOptions) {
    this.#o = o;
    this.#f = o.fetch ?? globalThis.fetch;
  }
  #perCredit(): number {
    return num(this.#o.pricing?.perCreditUsd, 49 / 250_000);
  }
  maxCostUsd(req: FetchRequest): number {
    return scrapingBeeCredits(req) * this.#perCredit();
  }
  async fetch(req: FetchRequest): Promise<Priced<FetchResult>> {
    const q = new URLSearchParams({ api_key: this.#o.key, url: req.url, render_js: String(req.render) });
    if (req.premium) q.set("premium_proxy", "true");
    // a country needs the premium pool at ScrapingBee
    if (req.country && req.premium) q.set("country_code", req.country);
    if (req.format === "text") q.set("return_page_text", "true");
    const r = await this.#f(`${this.#o.baseUrl ?? BASE}/api/v1/?${q}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await r.text();
    const cost = r.headers.get("spb-cost");
    if (cost === null) throw providerError("ScrapingBee", r.status, body);
    const initial = Number(r.headers.get("spb-initial-status-code") || "");
    return {
      value: {
        status: Number.isInteger(initial) && initial > 0 ? initial : r.status,
        contentType: r.headers.get("content-type") || (req.format === "text" ? "text/plain" : "text/html"),
        body,
        ...(r.headers.get("spb-resolved-url") ? { finalUrl: r.headers.get("spb-resolved-url")! } : {}),
      },
      costUsd: (Number(cost) || scrapingBeeCredits(req)) * this.#perCredit(),
    };
  }
}
