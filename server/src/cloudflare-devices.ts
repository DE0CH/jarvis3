// Per-device Cloudflare Access service tokens (Jarvis 1's lib/devices.js idea). The Access app
// admits any service token of the account; the server maps a token's client id to its user.
import type { DeviceTokenIssuer, ServiceToken } from "./providers.ts";
import { httpError } from "./errors.ts";

export class CloudflareDeviceTokens implements DeviceTokenIssuer {
  readonly #token: string;
  readonly #account: string;
  readonly #fetch: typeof fetch;
  constructor(apiToken: string, accountId: string, f: typeof fetch = globalThis.fetch) {
    this.#token = apiToken;
    this.#account = accountId;
    this.#fetch = f;
  }
  async #cf<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.#fetch(`https://api.cloudflare.com/client/v4/accounts/${this.#account}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] };
    if (!j.success) {
      const err = httpError("upstream", `Cloudflare ${method} ${path}: ${r.status} ${JSON.stringify(j.errors || []).slice(0, 200)}`);
      throw Object.assign(err, { cfStatus: r.status });
    }
    return j.result as T;
  }
  async mint(name: string): Promise<ServiceToken> {
    const t = await this.#cf<{ id: string; client_id: string; client_secret: string }>("POST", "/access/service_tokens", {
      name: name.slice(0, 100),
      duration: "forever",
    });
    return { id: t.id, clientId: t.client_id, clientSecret: t.client_secret };
  }
  async revoke(id: string): Promise<void> {
    try {
      await this.#cf("DELETE", `/access/service_tokens/${id}`);
    } catch (e) {
      if ((e as { cfStatus?: number }).cfStatus === 404) return;
      throw e;
    }
  }
}
