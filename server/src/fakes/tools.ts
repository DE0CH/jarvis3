// In-memory Tier 0 providers for tests and local runs.
import { randomId } from "../crypto.ts";
import type {
  FetchProvider,
  FetchRequest,
  FetchResult,
  Priced,
  ProxyEndpoint,
  ProxyLogin,
  ProxySubUser,
  ProxyTargeting,
  ProxyTargetingTemplate,
  RelayProxyProvider,
  SearchProvider,
  SearchRequest,
  SearchResult,
  SubUserProxyProvider,
} from "../tools/types.ts";
import { applyTargeting } from "../tools/types.ts";

export class FakeSearch implements SearchProvider {
  readonly name = "fake-search";
  readonly calls: SearchRequest[] = [];
  /** Reserved per call, and charged (unless `cost` says otherwise). */
  max = 0.01;
  cost = 0.007;
  fail: string | null = null;
  maxCostUsd(): number {
    return this.max;
  }
  async search(req: SearchRequest): Promise<Priced<SearchResult[]>> {
    this.calls.push(req);
    if (this.fail) throw new Error(this.fail);
    return {
      value: Array.from({ length: Math.min(req.numResults, 3) }, (_, i) => ({ title: `Result ${i + 1} for ${req.query}`, url: `https://example.com/${i + 1}`, snippet: `snippet ${i + 1}` })),
      costUsd: this.cost,
    };
  }
}

export class FakeFetch implements FetchProvider {
  readonly name = "fake-fetch";
  readonly calls: FetchRequest[] = [];
  max = 0.005;
  cost = 0.001;
  body = "<html><body>hello</body></html>";
  fail: string | null = null;
  maxCostUsd(req: FetchRequest): number {
    return req.premium ? this.max * 5 : this.max;
  }
  async fetch(req: FetchRequest): Promise<Priced<FetchResult>> {
    this.calls.push(req);
    if (this.fail) throw new Error(this.fail);
    return { value: { status: 200, contentType: "text/html", body: this.body, finalUrl: req.url }, costUsd: this.cost };
  }
}

/** A provider that caps sub-accounts itself (IPRoyal-like). `use(id, gb)` stands in for traffic. */
export class FakeSubUserProxy implements SubUserProxyProvider {
  readonly name = "fake-subuser";
  readonly mode = "subuser" as const;
  readonly subs = new Map<string, { name: string; login: ProxyLogin; available: number; used: number }>();
  readonly log: string[] = [];
  fail: string | null = null;
  endpoint(): ProxyEndpoint {
    return { host: "proxy.example.net", port: 12321 };
  }
  targeting(): ProxyTargetingTemplate {
    return { field: "password", country: "_country-{c}", session: "_session-{s}" };
  }
  async createSubUser(name: string, gb: number): Promise<ProxySubUser> {
    if (this.fail) throw new Error(this.fail);
    const id = randomId(10);
    const login = { username: name, password: `pw-${randomId(8)}` };
    this.subs.set(id, { name, login, available: gb, used: 0 });
    this.log.push(`create ${name} ${gb}`);
    return { id, login };
  }
  async setAvailableGb(id: string, gb: number): Promise<void> {
    const s = this.subs.get(id);
    if (!s) throw new Error(`no sub-user ${id}`);
    s.available = gb;
    this.log.push(`set ${s.name} ${gb}`);
  }
  async usedGb(id: string): Promise<number> {
    const s = this.subs.get(id);
    if (!s) throw new Error(`no sub-user ${id}`);
    return s.used;
  }
  async deleteSubUser(id: string): Promise<void> {
    const s = this.subs.get(id);
    this.subs.delete(id);
    this.log.push(`delete ${s ? s.name : id}`);
  }
  /** Traffic through a sub-account: refused beyond its allocation, as the provider would. */
  use(id: string, gb: number): boolean {
    const s = this.subs.get(id)!;
    if (gb > s.available) return false;
    s.available -= gb;
    s.used += gb;
    return true;
  }
}

/** A relay provider pointing at a local CONNECT proxy (tests start one). */
export class FakeRelayProxy implements RelayProxyProvider {
  readonly name = "fake-relay";
  readonly mode = "relay" as const;
  perGbUsd = 1;
  readonly logins: ProxyLogin[] = [];
  readonly ep: ProxyEndpoint;
  readonly org: ProxyLogin;
  constructor(ep: ProxyEndpoint, org: ProxyLogin = { username: "org-user", password: "org-secret" }) {
    this.ep = ep;
    this.org = org;
  }
  endpoint(): ProxyEndpoint {
    return this.ep;
  }
  login(t: ProxyTargeting): ProxyLogin {
    const l = applyTargeting(this.org, { field: "password", country: "_country-{c}", session: "_session-{s}" }, t);
    this.logins.push(l);
    return l;
  }
}
