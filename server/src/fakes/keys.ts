import type { KeyProvisioner, MintedKey } from "../providers.ts";
import { randomId } from "../crypto.ts";

/** In-memory OpenRouter management API. */
export class FakeKeys implements KeyProvisioner {
  readonly keys = new Map<string, { name: string; key: string; limit: number | null; reset: "monthly" | null }>();
  readonly log: string[] = [];
  fail: string | null = null;
  async create(name: string, limitUsd: number | null): Promise<MintedKey> {
    if (this.fail) throw new Error(this.fail);
    const hash = randomId(16);
    const key = `sk-or-v1-fake-${randomId(16)}`;
    this.keys.set(hash, { name, key, limit: limitUsd, reset: limitUsd === null ? null : "monthly" });
    this.log.push(`create ${name} ${limitUsd}`);
    return { hash, key };
  }
  async setLimit(hash: string, limitUsd: number | null): Promise<void> {
    const k = this.keys.get(hash);
    if (!k) throw new Error(`no key ${hash}`);
    k.limit = limitUsd;
    k.reset = limitUsd === null ? null : "monthly";
    this.log.push(`limit ${k.name} ${limitUsd}`);
  }
  async delete(hash: string): Promise<void> {
    const k = this.keys.get(hash);
    this.keys.delete(hash);
    this.log.push(`delete ${k ? k.name : hash}`);
  }
}
