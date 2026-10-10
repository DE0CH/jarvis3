// Tier 0 tools: per-user caps, metering, and the session-facing calls (docs/TOOLS.md).
//
// Web search and page fetching are server-metered: the session asks the server (through
// jarvis-agent's socket, which holds the session token), the server reserves the call's most
// possible cost against the user's monthly cap (and the instance's, if set) in one transaction,
// calls the provider with the organisation's key, and settles the reservation with the real cost.
// Two calls racing for the last cents can't both pass: the reservation is what is checked.
//
// Proxies are capped either by the provider (a per-user sub-account whose traffic allocation the
// server sets every month) or by the server's relay (tools/relay.ts counts the bytes).
import type * as A from "../api-types.ts";
import type { Ctx } from "../ctx.ts";
import { addNotice, isAdminRole } from "../ctx.ts";
import type { ProxyUserRow, TaskRow, UserRow } from "../rows.ts";
import { monthKey } from "../clock.ts";
import { kvGet, kvSet, tx } from "../db.ts";
import { HttpError, httpError } from "../errors.ts";
import type { FetchRequest, ProxyLogin, SearchRequest, SubUserProxyProvider } from "./types.ts";

/** Most of a fetched page the server hands back (the rest is cut, `truncated`). */
export const MAX_FETCH_BODY = 2 * 1024 * 1024;
/** How often subuser proxy usage is read back from the provider. */
export const PROXY_USAGE_REFRESH_MS = 15 * 60_000;
export const GB = 1e9;

const round = (n: number, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

export function toolsEnabled(ctx: Ctx): { search: boolean; fetch: boolean; proxy: boolean } {
  return { search: !!ctx.tools.search, fetch: !!ctx.tools.fetch, proxy: !!ctx.tools.proxy };
}
/** For MeView.features: present only when the instance has a Tier 0 tool. */
export function featureFlag(ctx: Ctx): { tools?: { search: boolean; fetch: boolean; proxy: boolean } } {
  return anyTools(ctx) ? { tools: toolsEnabled(ctx) } : {};
}
const anyTools = (ctx: Ctx) => !!(ctx.tools.search || ctx.tools.fetch || ctx.tools.proxy);

// ---- caps ----------------------------------------------------------------------------------------

export interface ToolCaps {
  webCapUsd: number | null;
  webOverride: boolean;
  proxyCapGb: number | null;
  proxyOverride: boolean;
}

export function toolCaps(ctx: Ctx, user: UserRow): ToolCaps {
  const role = ctx.config.roles[user.role];
  return {
    webCapUsd: user.tools_limit_override_set ? user.tools_limit_override : (role?.toolsMonthlyUsd ?? 0),
    webOverride: !!user.tools_limit_override_set,
    proxyCapGb: user.proxy_limit_override_set ? user.proxy_limit_override : (role?.proxyMonthlyGb ?? 0),
    proxyOverride: !!user.proxy_limit_override_set,
  };
}

/** Search + fetch spend counted against a month (reserved calls included), for one user or everyone. */
export function webSpent(ctx: Ctx, userId: string | null, month = monthKey(ctx.clock.now())): { usd: number; calls: number } {
  const r = (
    userId
      ? ctx.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS usd, COUNT(*) AS n FROM tool_usage WHERE user_id = ? AND month = ? AND tool IN ('search','fetch') AND state != 'failed'").get(userId, month)
      : ctx.db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS usd, COUNT(*) AS n FROM tool_usage WHERE month = ? AND tool IN ('search','fetch') AND state != 'failed'").get(month)
  ) as { usd: number; n: number };
  return { usd: r.usd, calls: r.n };
}

/** Relayed proxy bytes recorded for a month (relay mode). */
export function relayBytes(ctx: Ctx, userId: string | null, month = monthKey(ctx.clock.now())): number {
  const r = (
    userId
      ? ctx.db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM tool_usage WHERE user_id = ? AND month = ? AND tool = 'proxy'").get(userId, month)
      : ctx.db.prepare("SELECT COALESCE(SUM(bytes),0) AS b FROM tool_usage WHERE month = ? AND tool = 'proxy'").get(month)
  ) as { b: number };
  return r.b;
}

/** Tell the user and the admins once per (month, cap) that a tools cap stopped a call. */
export function capNotice(ctx: Ctx, user: UserRow, what: "web" | "proxy" | "instance", cap: number | null): void {
  const flag = `notice:tools:${what}:${what === "instance" ? "all" : user.id}:${monthKey(ctx.clock.now())}:${cap}`;
  if (kvGet<boolean>(ctx.db, flag)) return;
  kvSet(ctx.db, flag, true);
  const admins = (ctx.db.prepare("SELECT * FROM users WHERE status = 'active'").all() as unknown as UserRow[]).filter((u) => isAdminRole(ctx.config, u.role));
  if (what === "instance") {
    for (const a of admins) addNotice(ctx, a.id, "tools_cap", `The instance's web-tools budget (USD ${cap}) for this month is used up; web search and page fetching stop for everyone until next month or a higher cap.`);
    if (!admins.some((a) => a.id === user.id)) addNotice(ctx, user.id, "tools_cap", "Web search and page fetching are paused for everyone: the instance's budget for this month is used up.");
    return;
  }
  const label = what === "web" ? `web search and page fetching (USD ${cap} a month)` : `proxy traffic (${cap} GB a month)`;
  addNotice(ctx, user.id, "tools_cap", `You have used this month's ${label}. Your tasks can't use it again until next month or until an admin raises your limit.`);
  for (const a of admins) if (a.id !== user.id) addNotice(ctx, a.id, "tools_cap", `${user.email} reached their monthly cap on ${label}. You can raise it on the Users page.`);
}

/**
 * Reserve `maxUsd` against the user's monthly web cap and the instance's; 429 tools_cap when it
 * doesn't fit. Returns the ledger row id to settle.
 */
export function reserve(ctx: Ctx, user: UserRow, task: TaskRow | null, tool: "search" | "fetch", provider: string, maxUsd: number): number {
  const month = monthKey(ctx.clock.now());
  const caps = toolCaps(ctx, user);
  const instanceCap = ctx.config.tools?.monthlyUsd ?? null;
  let refused: "web" | "instance" | null = null;
  const id = tx(ctx.db, () => {
    if (caps.webCapUsd !== null && webSpent(ctx, user.id, month).usd + maxUsd > caps.webCapUsd + 1e-9) {
      refused = "web";
      return 0;
    }
    if (instanceCap !== null && webSpent(ctx, null, month).usd + maxUsd > instanceCap + 1e-9) {
      refused = "instance";
      return 0;
    }
    const r = ctx.db
      .prepare("INSERT INTO tool_usage(user_id, task_id, tool, provider, state, cost_usd, month, created_at) VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)")
      .run(user.id, task?.id ?? null, tool, provider, maxUsd, month, ctx.clock.now());
    return Number(r.lastInsertRowid);
  });
  if (refused === "web") {
    capNotice(ctx, user, "web", caps.webCapUsd);
    throw httpError("tools_cap", `this month's web-tools allowance (USD ${caps.webCapUsd}) is used up; it renews on the 1st, or an admin can raise it`);
  }
  if (refused === "instance") {
    capNotice(ctx, user, "instance", instanceCap);
    throw httpError("tools_cap", "the instance's web-tools budget for this month is used up");
  }
  return id;
}

export function settle(ctx: Ctx, id: number, costUsd: number): void {
  ctx.db.prepare("UPDATE tool_usage SET state = 'done', cost_usd = ? WHERE id = ?").run(round(Math.max(0, costUsd)), id);
}
export function release(ctx: Ctx, id: number): void {
  ctx.db.prepare("UPDATE tool_usage SET state = 'failed', cost_usd = 0 WHERE id = ?").run(id);
}

/** At start-up: reservations left by a crash count as spent at their reserved (highest) cost. */
export function settleStaleReservations(ctx: Ctx): void {
  ctx.db.prepare("UPDATE tool_usage SET state = 'done' WHERE state = 'reserved'").run();
}

// ---- session calls ----------------------------------------------------------------------------------

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const COUNTRY = /^[a-zA-Z]{2}$/;

export function parseSearch(body: unknown): SearchRequest {
  const b = (body ?? {}) as A.WebSearchRequest;
  const query = str(b.query, 2000)?.trim();
  if (!query) throw httpError("bad_request", "query must be 1..2000 characters");
  const n = b.numResults ?? 10;
  if (!Number.isInteger(n) || n < 1 || n > 20) throw httpError("bad_request", "numResults must be 1..20");
  const textChars = b.textChars ?? 0;
  if (!Number.isInteger(textChars) || textChars < 0 || textChars > 20_000) throw httpError("bad_request", "textChars must be 0..20000");
  if (b.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(b.since))) throw httpError("bad_request", "since must be YYYY-MM-DD");
  if (b.includeDomains !== undefined && (!Array.isArray(b.includeDomains) || b.includeDomains.length > 20 || !b.includeDomains.every((d) => typeof d === "string" && /^[a-z0-9.-]{1,253}$/i.test(d)))) {
    throw httpError("bad_request", "includeDomains must be up to 20 domain names");
  }
  if (b.country !== undefined && !COUNTRY.test(String(b.country))) throw httpError("bad_request", "country must be two letters");
  return {
    query,
    numResults: n,
    ...(textChars ? { textChars } : {}),
    ...(b.since ? { since: b.since } : {}),
    ...(b.includeDomains?.length ? { includeDomains: b.includeDomains } : {}),
    ...(b.country ? { country: b.country.toLowerCase() } : {}),
  };
}

export function parseFetch(body: unknown): FetchRequest {
  const b = (body ?? {}) as A.WebFetchRequest;
  const url = str(b.url, 8000);
  let u: URL;
  try {
    u = new URL(url ?? "");
  } catch {
    throw httpError("bad_request", "url must be an absolute http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw httpError("bad_request", "url must be an absolute http(s) URL");
  for (const k of ["render", "premium"] as const) if (b[k] !== undefined && typeof b[k] !== "boolean") throw httpError("bad_request", `${k} must be true or false`);
  if (b.country !== undefined && !COUNTRY.test(String(b.country))) throw httpError("bad_request", "country must be two letters");
  if (b.format !== undefined && b.format !== "html" && b.format !== "text") throw httpError("bad_request", "format must be html or text");
  return { url: u.toString(), render: !!b.render, premium: !!b.premium, format: b.format ?? "html", ...(b.country ? { country: b.country.toLowerCase() } : {}) };
}

function ownerOf(ctx: Ctx, task: TaskRow): UserRow {
  const u = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(task.user_id) as UserRow | undefined;
  if (!u || u.status !== "active") throw httpError("forbidden", "the task's owner is not an active member");
  return u;
}

async function metered<T>(ctx: Ctx, user: UserRow, task: TaskRow, tool: "search" | "fetch", provider: string, maxUsd: number, call: () => Promise<{ value: T; costUsd: number }>) {
  const id = reserve(ctx, user, task, tool, provider, maxUsd);
  let out;
  try {
    out = await call();
  } catch (e) {
    release(ctx, id);
    ctx.log(`tools: ${tool} failed`, { provider, task: task.id, error: (e as Error).message.slice(0, 300) });
    throw e instanceof HttpError ? e : httpError("upstream", `${provider}: ${(e as Error).message.slice(0, 300)}`);
  }
  // never charge more than was reserved: the reservation is the hard part of the cap
  const cost = Math.min(Math.max(0, out.costUsd), maxUsd);
  settle(ctx, id, cost);
  const caps = toolCaps(ctx, user);
  return { value: out.value, costUsd: round(cost), spentUsd: round(webSpent(ctx, user.id).usd), capUsd: caps.webCapUsd };
}

export async function webSearch(ctx: Ctx, task: TaskRow, body: unknown): Promise<A.WebSearchResponse> {
  const p = ctx.tools.search;
  if (!p) throw httpError("conflict", "web search is not set up on this instance");
  const req = parseSearch(body);
  const user = ownerOf(ctx, task);
  const r = await metered(ctx, user, task, "search", p.name, p.maxCostUsd(req), () => p.search(req));
  return { provider: p.name, results: r.value, costUsd: r.costUsd, spentUsd: r.spentUsd, capUsd: r.capUsd };
}

export async function webFetch(ctx: Ctx, task: TaskRow, body: unknown): Promise<A.WebFetchResponse> {
  const p = ctx.tools.fetch;
  if (!p) throw httpError("conflict", "page fetching is not set up on this instance");
  const req = parseFetch(body);
  const user = ownerOf(ctx, task);
  const r = await metered(ctx, user, task, "fetch", p.name, p.maxCostUsd(req), () => p.fetch(req));
  const truncated = r.value.body.length > MAX_FETCH_BODY;
  return {
    provider: p.name,
    status: r.value.status,
    contentType: r.value.contentType,
    finalUrl: r.value.finalUrl ?? null,
    body: truncated ? r.value.body.slice(0, MAX_FETCH_BODY) : r.value.body,
    truncated,
    costUsd: r.costUsd,
    spentUsd: r.spentUsd,
    capUsd: r.capUsd,
  };
}

// ---- proxies: per-user sub-accounts ("subuser" providers) --------------------------------------------

const proxyAad = (userId: string) => `proxy:${userId}`;
const subuser = (ctx: Ctx): SubUserProxyProvider | null => (ctx.tools.proxy?.mode === "subuser" ? ctx.tools.proxy : null);

export function proxyUserRow(ctx: Ctx, userId: string): ProxyUserRow | null {
  return (ctx.db.prepare("SELECT * FROM proxy_users WHERE user_id = ?").get(userId) as ProxyUserRow | undefined) ?? null;
}

const minting = new Map<string, Promise<ProxyLogin | null>>();

/**
 * The user's sub-account login (minting it with this month's cap on the first task). null when the
 * proxy isn't a subuser provider or the user's cap is 0.
 */
export function ensureProxyUser(ctx: Ctx, user: UserRow): Promise<ProxyLogin | null> {
  const p = subuser(ctx);
  if (!p) return Promise.resolve(null);
  const existing = proxyUserRow(ctx, user.id);
  if (existing) return Promise.resolve(JSON.parse(ctx.sealer.open(existing.login_sealed, proxyAad(user.id))) as ProxyLogin);
  const cap = toolCaps(ctx, user).proxyCapGb;
  if (!cap) return Promise.resolve(null); // 0 = no proxy for this user (null is refused at start-up for subuser providers)
  const inflight = minting.get(user.id);
  if (inflight) return inflight;
  const run = (async () => {
    const su = await p.createSubUser(`${ctx.config.instanceName}-${user.id}`, cap);
    ctx.db
      .prepare("INSERT INTO proxy_users(user_id, provider, remote_id, login_sealed, month, allocated_gb, baseline_gb, used_gb, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)")
      .run(user.id, p.name, su.id, ctx.sealer.seal(JSON.stringify(su.login), proxyAad(user.id)), monthKey(ctx.clock.now()), cap, ctx.clock.now(), ctx.clock.now());
    ctx.log("proxy sub-account minted", { user: user.id, provider: p.name, gb: cap });
    return su.login;
  })();
  minting.set(user.id, run);
  return run.finally(() => minting.delete(user.id));
}

/** Read the sub-account's use; on a new month, refill it to the cap (the provider has no monthly reset). */
export async function refreshProxyUser(ctx: Ctx, user: UserRow, o: { force?: boolean } = {}): Promise<void> {
  const p = subuser(ctx);
  const row = proxyUserRow(ctx, user.id);
  if (!p || !row) return;
  const now = ctx.clock.now();
  const month = monthKey(now);
  const cap = toolCaps(ctx, user).proxyCapGb ?? 0;
  const newMonth = row.month !== month;
  const capChanged = row.allocated_gb !== cap;
  if (!o.force && !newMonth && !capChanged && row.checked_at !== null && now - row.checked_at < PROXY_USAGE_REFRESH_MS) return;
  const total = await p.usedGb(row.remote_id);
  const baseline = newMonth ? total : row.baseline_gb;
  const used = Math.max(0, total - baseline);
  if (newMonth || capChanged) {
    await p.setAvailableGb(row.remote_id, Math.max(0, cap - used));
    ctx.log("proxy allocation set", { user: user.id, month, capGb: cap, usedGb: round(used, 4) });
  }
  ctx.db
    .prepare("UPDATE proxy_users SET month = ?, allocated_gb = ?, baseline_gb = ?, used_gb = ?, checked_at = ? WHERE user_id = ?")
    .run(month, cap, baseline, used, now, user.id);
  if (cap > 0 && used >= cap) capNotice(ctx, user, "proxy", cap);
}

export async function revokeProxyUser(ctx: Ctx, userId: string): Promise<boolean> {
  const row = proxyUserRow(ctx, userId);
  if (!row) return false;
  const p = subuser(ctx);
  if (p && p.name === row.provider) await p.deleteSubUser(row.remote_id);
  ctx.db.prepare("DELETE FROM proxy_users WHERE user_id = ?").run(userId);
  ctx.log("proxy sub-account revoked", { user: userId });
  return true;
}

/** Background: refill sub-accounts at the month's turn and read their use. */
export async function proxyTick(ctx: Ctx): Promise<void> {
  if (!subuser(ctx)) return;
  const rows = ctx.db.prepare("SELECT u.* FROM users u JOIN proxy_users p ON p.user_id = u.id WHERE u.status = 'active'").all() as unknown as UserRow[];
  for (const u of rows) await refreshProxyUser(ctx, u).catch((e: Error) => ctx.log("proxy usage refresh failed", { user: u.id, error: e.message }));
}

// ---- views ------------------------------------------------------------------------------------------

export function userToolsView(ctx: Ctx, user: UserRow): A.UserToolsView | undefined {
  if (!anyTools(ctx)) return undefined;
  const caps = toolCaps(ctx, user);
  const month = monthKey(ctx.clock.now());
  const spent = webSpent(ctx, user.id, month);
  const pmode = ctx.tools.proxy?.mode ?? null;
  let usedGb = 0;
  if (pmode === "relay") usedGb = relayBytes(ctx, user.id, month) / GB;
  if (pmode === "subuser") {
    const row = proxyUserRow(ctx, user.id);
    usedGb = row && row.month === month ? row.used_gb : 0;
  }
  return {
    month,
    web:
      ctx.tools.search || ctx.tools.fetch
        ? {
            capUsd: caps.webCapUsd,
            override: caps.webOverride,
            spentUsd: round(spent.usd, 4),
            calls: spent.calls,
            capReached: caps.webCapUsd !== null && spent.usd >= caps.webCapUsd - 1e-9,
          }
        : null,
    proxy: pmode
      ? { mode: pmode, capGb: caps.proxyCapGb, override: caps.proxyOverride, usedGb: round(usedGb, 9), capReached: caps.proxyCapGb !== null && usedGb >= caps.proxyCapGb }
      : null,
  };
}

export function sessionToolsView(ctx: Ctx, task: TaskRow): A.SessionToolsView {
  const user = ownerOf(ctx, task);
  const v = userToolsView(ctx, user);
  return {
    search: !!ctx.tools.search,
    fetch: !!ctx.tools.fetch,
    proxy: ctx.tools.proxy?.mode ?? null,
    web: v?.web ? { capUsd: v.web.capUsd, spentUsd: v.web.spentUsd } : null,
    proxyUsage: v?.proxy ? { capGb: v.proxy.capGb, usedGb: v.proxy.usedGb } : null,
  };
}

export function adminToolsView(ctx: Ctx): A.ToolsAdminView {
  const month = monthKey(ctx.clock.now());
  const spent = webSpent(ctx, null, month);
  const cap = ctx.config.tools?.monthlyUsd ?? null;
  const p = ctx.tools.proxy;
  let proxyUsedGb = 0;
  if (p?.mode === "relay") proxyUsedGb = relayBytes(ctx, null, month) / GB;
  if (p?.mode === "subuser") {
    const r = ctx.db.prepare("SELECT COALESCE(SUM(used_gb),0) AS g FROM proxy_users WHERE month = ?").get(month) as { g: number };
    proxyUsedGb = r.g;
  }
  return {
    month,
    search: ctx.tools.search ? { provider: ctx.tools.search.name } : null,
    fetch: ctx.tools.fetch ? { provider: ctx.tools.fetch.name } : null,
    proxy: p ? { provider: p.name, mode: p.mode } : null,
    web: { spentUsd: round(spent.usd, 4), calls: spent.calls, capUsd: cap, capReached: cap !== null && spent.usd >= cap - 1e-9 },
    proxyUsedGb: round(proxyUsedGb, 9),
  };
}
