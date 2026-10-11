// IPRoyal residential sub-users (docs.iproyal.com/proxies/residential/api/sub-users, 2026-10-10):
// each user gets a sub-user whose traffic is a prepaid GB bucket taken from the main account, so the
// provider itself stops it at its allocation. The bucket doesn't refill by itself: the server sets
// it every month (give-traffic / take-traffic). Deleting a sub-user returns its unused GB.
//   POST   /residential-subusers {username, password, traffic}       -> SubuserResource
//   GET    /residential-subusers/{hash}                              -> SubuserResource
//   POST   /residential-subusers/{hash}/give-traffic {amount}
//   POST   /residential-subusers/{hash}/take-traffic {amount}
//   DELETE /residential-subusers/{hash}
// SubuserResource: {hash, username, password, traffic_available, traffic_used} (GB).
// Proxy: geo.iproyal.com:12321 (HTTP); targeting on the password: _country-de, _session-<8>_lifetime-30m.
import { randomBytes } from "node:crypto";
import type { ProxyEndpoint, ProxySubUser, ProxyTargetingTemplate, SubUserProxyProvider } from "./types.ts";
import { callJson, num, strSetting, type AdapterOptions } from "./http.ts";

const BASE = "https://resi-api.iproyal.com/v1";

interface Subuser {
  hash: string;
  username: string;
  password: string;
  traffic_available: number;
  traffic_used: number;
}

export class IPRoyalProxy implements SubUserProxyProvider {
  readonly name = "iproyal";
  readonly mode = "subuser" as const;
  readonly #o: AdapterOptions;
  readonly #f: typeof fetch;
  constructor(o: AdapterOptions) {
    this.#o = o;
    this.#f = o.fetch ?? globalThis.fetch;
  }
  #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return callJson<T>(this.#f, "IPRoyal", (this.#o.baseUrl ?? BASE) + path, {
      method,
      headers: { Authorization: `Bearer ${this.#o.key}`, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  endpoint(): ProxyEndpoint {
    return { host: strSetting(this.#o.settings, "host", "geo.iproyal.com"), port: num(this.#o.settings?.port, 12321) };
  }
  targeting(): ProxyTargetingTemplate {
    return { field: "password", country: "_country-{c}", session: "_session-{s}_lifetime-30m", countryCase: "lower" };
  }
  async createSubUser(name: string, gb: number): Promise<ProxySubUser> {
    // IPRoyal usernames: letters, digits, underscores
    const username = name.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
    // IPRoyal refuses passwords over 16 characters (422 "must not be greater than 16 characters", 2026-10-11)
    const password = randomBytes(12).toString("base64url").replace(/[-_]/g, "x");
    const s = await this.#call<Subuser>("POST", "/residential-subusers", { username, password, traffic: gb });
    return { id: s.hash, login: { username: s.username || username, password: s.password || password } };
  }
  async #get(id: string): Promise<Subuser> {
    return this.#call<Subuser>("GET", `/residential-subusers/${encodeURIComponent(id)}`);
  }
  async setAvailableGb(id: string, gb: number): Promise<void> {
    const s = await this.#get(id);
    const diff = Math.round((gb - num(s.traffic_available, 0)) * 1000) / 1000;
    if (diff > 0) await this.#call("POST", `/residential-subusers/${encodeURIComponent(id)}/give-traffic`, { amount: diff });
    else if (diff < 0) await this.#call("POST", `/residential-subusers/${encodeURIComponent(id)}/take-traffic`, { amount: -diff });
  }
  async usedGb(id: string): Promise<number> {
    return num((await this.#get(id)).traffic_used, 0);
  }
  async deleteSubUser(id: string): Promise<void> {
    try {
      await this.#call("DELETE", `/residential-subusers/${encodeURIComponent(id)}`);
    } catch (e) {
      if (/answered 404/.test((e as Error).message)) return;
      throw e;
    }
  }
}
