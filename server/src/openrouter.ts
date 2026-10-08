// OpenRouter management-key API (docs: openrouter.ai/docs/api/api-reference/api-keys, checked
// 2026-10-08): POST /api/v1/keys {name, limit, limit_reset, include_byok_in_limit} -> 201
// {data:{hash,…}, key}; PATCH /api/v1/keys/{hash} {limit, limit_reset}; DELETE /api/v1/keys/{hash}.
// limit_reset "monthly" makes OpenRouter itself reset the key's usage at midnight UTC on the 1st,
// so the server does not reset limits.
import type { KeyProvisioner, MintedKey } from "./providers.ts";
import { httpError } from "./errors.ts";

const BASE = "https://openrouter.ai/api/v1/keys";

export class OpenRouterKeys implements KeyProvisioner {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  constructor(managementKey: string, opts: { fetch?: typeof fetch; base?: string } = {}) {
    this.#token = managementKey;
    this.#fetch = opts.fetch || globalThis.fetch;
    this.#base = opts.base || BASE;
  }
  async #call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const r = await this.#fetch(this.#base + path, {
      method,
      headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (!r.ok && r.status !== 404) throw httpError("upstream", `OpenRouter ${method} keys${path} -> ${r.status}: ${text.slice(0, 200)}`);
    return { status: r.status, json: (text ? JSON.parse(text) : {}) as T };
  }
  async create(name: string, limitUsd: number | null): Promise<MintedKey> {
    const { status, json } = await this.#call<{ data: { hash: string }; key: string }>("POST", "", {
      name,
      limit: limitUsd,
      limit_reset: limitUsd === null ? null : "monthly",
      include_byok_in_limit: true,
    });
    if (status === 404 || !json.key || !json.data?.hash) throw httpError("upstream", "OpenRouter did not return a key");
    return { hash: json.data.hash, key: json.key };
  }
  async setLimit(hash: string, limitUsd: number | null): Promise<void> {
    const { status } = await this.#call("PATCH", `/${encodeURIComponent(hash)}`, {
      limit: limitUsd,
      limit_reset: limitUsd === null ? null : "monthly",
    });
    if (status === 404) throw httpError("upstream", `OpenRouter key ${hash} not found`);
  }
  async delete(hash: string): Promise<void> {
    await this.#call("DELETE", `/${encodeURIComponent(hash)}`); // 404 = already gone, fine
  }
}
