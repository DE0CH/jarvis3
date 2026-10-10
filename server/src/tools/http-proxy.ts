// Any upstream HTTP proxy that speaks CONNECT with Basic auth, relayed and metered by the server
// (tools/relay.ts); the organisation's login never leaves the server. Presets:
//   evomi   dcp.evomi.com:2000, targeting on the password (_country-US, _session-x), USD 0.45/GB
//           (Evomi has no sub-user API, so it can only be metered here)
//   http    settings.host / settings.port / settings.targeting, pricing.perGbUsd
// The credential is "username:password".
import type { ProxyEndpoint, ProxyLogin, ProxyTargeting, ProxyTargetingTemplate, RelayProxyProvider } from "./types.ts";
import { applyTargeting } from "./types.ts";
import { num, strSetting, type AdapterOptions } from "./http.ts";

const PRESETS: Record<string, { host: string; port: number; targeting: ProxyTargetingTemplate; perGbUsd: number }> = {
  evomi: { host: "dcp.evomi.com", port: 2000, targeting: { field: "password", country: "_country-{c}", session: "_session-{s}", countryCase: "upper" }, perGbUsd: 0.45 },
  http: { host: "", port: 0, targeting: { field: "username" }, perGbUsd: 0 },
};

export class HttpRelayProxy implements RelayProxyProvider {
  readonly name: string;
  readonly mode = "relay" as const;
  readonly perGbUsd: number;
  readonly #ep: ProxyEndpoint;
  readonly #login: ProxyLogin;
  readonly #tpl: ProxyTargetingTemplate;
  constructor(preset: string, o: AdapterOptions) {
    const p = PRESETS[preset];
    if (!p) throw new Error(`unknown proxy preset ${preset}`);
    this.name = preset;
    const i = o.key.indexOf(":");
    if (i < 1) throw new Error(`tools.proxy credential must be "username:password"`);
    this.#login = { username: o.key.slice(0, i), password: o.key.slice(i + 1) };
    this.#ep = { host: strSetting(o.settings, "host", p.host), port: num(o.settings?.port, p.port) };
    if (!this.#ep.host || !this.#ep.port) throw new Error("tools.proxy needs settings.host and settings.port");
    this.#tpl = (o.settings?.targeting as ProxyTargetingTemplate | undefined) ?? p.targeting;
    this.perGbUsd = num(o.pricing?.perGbUsd, p.perGbUsd);
  }
  endpoint(): ProxyEndpoint {
    return this.#ep;
  }
  login(t: ProxyTargeting): ProxyLogin {
    return applyTargeting(this.#login, this.#tpl, t);
  }
}
