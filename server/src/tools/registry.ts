// Build an instance's Tier 0 providers from its config: `provider` names an adapter here. Adding a
// provider = an adapter implementing tools/types.ts plus one line in the table below (docs/TOOLS.md).
import type { Config, ToolProviderConfig } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import type { FetchProvider, ProxyProvider, SearchProvider, ToolProviders } from "./types.ts";
import type { AdapterOptions } from "./http.ts";
import { ExaFetch, ExaSearch } from "./exa.ts";
import { BraveSearch } from "./brave.ts";
import { TavilySearch } from "./tavily.ts";
import { ScrapingBeeFetch } from "./scrapingbee.ts";
import { IPRoyalProxy } from "./iproyal.ts";
import { HttpRelayProxy } from "./http-proxy.ts";

const SEARCH: Record<string, (o: AdapterOptions) => SearchProvider> = {
  exa: (o) => new ExaSearch(o),
  brave: (o) => new BraveSearch(o),
  tavily: (o) => new TavilySearch(o),
};
const FETCH: Record<string, (o: AdapterOptions) => FetchProvider> = {
  scrapingbee: (o) => new ScrapingBeeFetch(o),
  exa: (o) => new ExaFetch(o),
};
const PROXY: Record<string, (o: AdapterOptions) => ProxyProvider> = {
  iproyal: (o) => new IPRoyalProxy(o),
  evomi: (o) => new HttpRelayProxy("evomi", o),
  http: (o) => new HttpRelayProxy("http", o),
};

export const PROVIDER_NAMES = { search: Object.keys(SEARCH), fetch: Object.keys(FETCH), proxy: Object.keys(PROXY) };

function opts(p: ToolProviderConfig, key: string | undefined, f?: typeof fetch): AdapterOptions {
  return { key: key ?? "", ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.pricing ? { pricing: p.pricing } : {}), ...(p.settings ? { settings: p.settings } : {}), ...(f ? { fetch: f } : {}) };
}

/** The providers the config names, with the credentials loadToolSecrets read. Throws on an unknown provider. */
export function buildToolProviders(c: Config, secrets: Partial<Record<"search" | "fetch" | "proxy", string>>, o: { fetch?: typeof fetch } = {}): ToolProviders {
  const pick = <T>(kind: "search" | "fetch" | "proxy", table: Record<string, (o: AdapterOptions) => T>): T | null => {
    const p = c.tools?.[kind];
    if (!p) return null;
    const make = table[p.provider];
    if (!make) throw new Error(`tools.${kind}.provider: unknown provider ${p.provider} (one of ${Object.keys(table).join(", ")})`);
    if (!secrets[kind]) throw new Error(`tools.${kind}: the provider needs a credential (tools.${kind}.credential)`);
    return make(opts(p, secrets[kind], o.fetch));
  };
  return { search: pick("search", SEARCH), fetch: pick("fetch", FETCH), proxy: pick("proxy", PROXY) };
}

/** Start-up checks that need the built providers: a subuser proxy can't be "no cap". */
export function checkToolProviders(ctx: Pick<Ctx, "config" | "tools">): void {
  if (ctx.tools.proxy?.mode !== "subuser") return;
  for (const [name, r] of Object.entries(ctx.config.roles)) {
    if (r.proxyMonthlyGb === null) throw new Error(`roles.${name}.proxyMonthlyGb: ${ctx.tools.proxy.name} sub-accounts need a number of GB (no "no cap")`);
  }
}
