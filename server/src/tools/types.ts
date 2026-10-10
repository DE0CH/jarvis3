// Tier 0 tools (DESIGN "Secrets and capabilities"): web search, page fetching and proxies, always
// on for every session, with per-user hard monthly caps. Each kind sits behind a small provider
// interface; tools/registry.ts builds the providers an instance's config names, tools/index.ts
// meters and caps the calls, and tools/relay.ts carries metered proxy traffic.
//
// Two ways a provider keeps the cap hard:
//   - server-metered (search, fetch, "relay" proxies): the org key stays on the server; every call
//     is reserved against the user's cap before it goes out and settled with its real cost after;
//   - per-user sub-account ("subuser" proxies): the provider itself enforces a traffic allocation
//     per user, minted by the server; that sub-account's credentials go to the user's machines.

export interface SearchRequest {
  query: string;
  /** 1..20, default 10. */
  numResults: number;
  /** Optional: include extracted page text per result, cut to this many characters. */
  textChars?: number;
  /** Optional ISO date (YYYY-MM-DD): only pages published on/after it, where the provider supports it. */
  since?: string;
  /** Optional: restrict to these domains. */
  includeDomains?: string[];
  /** Optional: two-letter country code for localised results, where the provider supports it. */
  country?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  /** Extracted page text (only when asked and the provider returns it). */
  text?: string;
}

export interface FetchRequest {
  url: string;
  /** Run the page's JavaScript in a real browser first (dearer with most providers). */
  render: boolean;
  /** Use the provider's residential/premium pool for bot-walled sites (dearest). */
  premium: boolean;
  /** Two-letter country for the exit IP, where the provider supports it. */
  country?: string;
  /** What to return: the raw HTML (default) or the provider's extracted text/markdown. */
  format: "html" | "text";
}

export interface FetchResult {
  /** The target page's HTTP status as the provider saw it (0 when unknown). */
  status: number;
  contentType: string;
  body: string;
  /** The final URL after redirects, when the provider reports it. */
  finalUrl?: string;
}

/** What a call cost, and what it would cost at most (reserved before the call). */
export interface Priced<T> {
  value: T;
  costUsd: number;
}

export interface SearchProvider {
  readonly name: string;
  /** The most one call with these parameters can cost (reserved against the cap first). */
  maxCostUsd(req: SearchRequest): number;
  search(req: SearchRequest): Promise<Priced<SearchResult[]>>;
}

export interface FetchProvider {
  readonly name: string;
  maxCostUsd(req: FetchRequest): number;
  fetch(req: FetchRequest): Promise<Priced<FetchResult>>;
}

/** How exit targeting is written into the proxy login (provider-specific). */
export interface ProxyTargeting {
  country?: string; // two letters, lower case
  session?: string; // [A-Za-z0-9]{1,32}: a sticky exit IP for this id
}

export interface ProxyEndpoint {
  host: string;
  port: number;
}

export interface ProxyLogin {
  username: string;
  password: string;
}

/** A per-user sub-account the provider caps itself. */
export interface ProxySubUser {
  /** The provider's id for it. */
  id: string;
  login: ProxyLogin;
}

/**
 * How a provider reads exit targeting from the login, as data (the session image applies the same
 * template to its sub-account's login): `{c}` / `{s}` in `country` / `session` are replaced by the
 * country code and the session id, and the pieces are appended to `field`.
 * IPRoyal: {field: "password", country: "_country-{c}", session: "_session-{s}_lifetime-30m"}.
 */
export interface ProxyTargetingTemplate {
  field: "username" | "password";
  country?: string;
  session?: string;
  countryCase?: "lower" | "upper";
}

export function applyTargeting(login: ProxyLogin, tpl: ProxyTargetingTemplate, t: ProxyTargeting): ProxyLogin {
  let add = "";
  if (t.country && tpl.country) add += tpl.country.replace("{c}", tpl.countryCase === "upper" ? t.country.toUpperCase() : t.country.toLowerCase());
  if (t.session && tpl.session) add += tpl.session.replace("{s}", t.session);
  return tpl.field === "username" ? { username: login.username + add, password: login.password } : { username: login.username, password: login.password + add };
}

export interface SubUserProxyProvider {
  readonly name: string;
  readonly mode: "subuser";
  endpoint(): ProxyEndpoint;
  targeting(): ProxyTargetingTemplate;
  /** Create a sub-account with this much traffic available (GB). */
  createSubUser(name: string, gb: number): Promise<ProxySubUser>;
  /** Make exactly `gb` GB available from now on (the monthly refill, or a changed cap). */
  setAvailableGb(id: string, gb: number): Promise<void>;
  /** Traffic used since the account was made, GB (the server diffs it per month). */
  usedGb(id: string): Promise<number>;
  /** Deleting an already-gone sub-account is not an error. */
  deleteSubUser(id: string): Promise<void>;
}

export interface RelayProxyProvider {
  readonly name: string;
  readonly mode: "relay";
  endpoint(): ProxyEndpoint;
  /** The organisation's login with targeting applied. Never leaves the server. */
  login(t: ProxyTargeting): ProxyLogin;
  /** USD per GB of traffic (both directions), for the spend view. */
  perGbUsd: number;
}

export type ProxyProvider = SubUserProxyProvider | RelayProxyProvider;

export interface ToolProviders {
  search: SearchProvider | null;
  fetch: FetchProvider | null;
  proxy: ProxyProvider | null;
}
