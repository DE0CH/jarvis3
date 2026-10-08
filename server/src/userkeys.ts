// Per-user OpenRouter keys: minted on the user's first task with the monthly limit in force for
// them (role default or admin override), limit changed when an admin overrides it, deleted at
// offboarding. Only OpenRouter's key id (hash), the limit and the sealed key are stored.
import type { Ctx } from "./ctx.ts";
import type { KeyRow, UserRow } from "./rows.ts";
import { limitsFor } from "./spend.ts";

const aad = (userId: string) => `openrouter:${userId}`;

/** Per-user serialisation so two concurrent first tasks mint one key. */
const minting = new Map<string, Promise<string>>();

export function keyRow(ctx: Ctx, userId: string): KeyRow | null {
  return (ctx.db.prepare("SELECT * FROM openrouter_keys WHERE user_id = ?").get(userId) as KeyRow | undefined) ?? null;
}

/** The user's OpenRouter key (plaintext, for a machine's env), minting it if needed. */
export function ensureKey(ctx: Ctx, user: UserRow): Promise<string> {
  const existing = keyRow(ctx, user.id);
  if (existing) return Promise.resolve(ctx.sealer.open(existing.key_sealed, aad(user.id)));
  const inflight = minting.get(user.id);
  if (inflight) return inflight;
  const p = (async () => {
    const limit = limitsFor(ctx, user).openrouterMonthlyUsd;
    const minted = await ctx.keys.create(`${ctx.config.instanceName}: ${user.email}`, limit);
    ctx.db
      .prepare("INSERT INTO openrouter_keys(user_id, hash, key_sealed, limit_usd, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(user.id, minted.hash, ctx.sealer.seal(minted.key, aad(user.id)), limit, ctx.clock.now());
    ctx.log("openrouter key minted", { user: user.id, limit });
    return minted.key;
  })();
  minting.set(user.id, p);
  return p.finally(() => minting.delete(user.id));
}

/** Push the user's current limit to OpenRouter (after an admin override or a role change). */
export async function syncKeyLimit(ctx: Ctx, user: UserRow): Promise<void> {
  const k = keyRow(ctx, user.id);
  if (!k) return;
  const limit = limitsFor(ctx, user).openrouterMonthlyUsd;
  if (k.limit_usd === limit) return;
  await ctx.keys.setLimit(k.hash, limit);
  ctx.db.prepare("UPDATE openrouter_keys SET limit_usd = ? WHERE user_id = ?").run(limit, user.id);
}

export async function revokeKey(ctx: Ctx, userId: string): Promise<boolean> {
  const k = keyRow(ctx, userId);
  if (!k) return false;
  await ctx.keys.delete(k.hash);
  ctx.db.prepare("DELETE FROM openrouter_keys WHERE user_id = ?").run(userId);
  ctx.log("openrouter key revoked", { user: userId });
  return true;
}
