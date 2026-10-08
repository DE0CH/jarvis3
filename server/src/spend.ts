// Spend: per-user limits, the per-user monthly machine-hour counter, and the instance-wide
// machine budget guard (Jarvis 1's budget.js idea: integrate the burn rate of everything started).
import type { BudgetView, LimitsView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import type { UserRow } from "./rows.ts";
import type { MachineSpec } from "./providers.ts";
import { iso, monthBounds, monthKey } from "./clock.ts";
import { kvGet, kvSet } from "./db.ts";

export function limitsFor(ctx: Ctx, user: UserRow): LimitsView {
  const role = ctx.config.roles[user.role];
  return {
    openrouterMonthlyUsd: user.openrouter_limit_override_set ? user.openrouter_limit_override : (role?.openrouterMonthlyUsd ?? null),
    openrouterOverride: !!user.openrouter_limit_override_set,
    machineHoursPerMonth: user.machine_hours_override_set ? user.machine_hours_override : (role?.machineHoursPerMonth ?? null),
    machineHoursOverride: !!user.machine_hours_override_set,
  };
}

/** Machine hours a user's tasks ran in the UTC calendar month containing `at`. */
export function machineHours(ctx: Ctx, userId: string, at = ctx.clock.now()): number {
  const { start, end } = monthBounds(at);
  const now = ctx.clock.now();
  const rows = ctx.db
    .prepare("SELECT started_at, stopped_at FROM machine_runs WHERE user_id = ? AND started_at < ? AND (stopped_at IS NULL OR stopped_at > ?)")
    .all(userId, end, start) as { started_at: number; stopped_at: number | null }[];
  let ms = 0;
  for (const r of rows) ms += Math.max(0, Math.min(r.stopped_at ?? now, end) - Math.max(r.started_at, start));
  return ms / 3_600_000;
}

export function machineHoursCapReached(ctx: Ctx, user: UserRow): boolean {
  const cap = limitsFor(ctx, user).machineHoursPerMonth;
  return cap !== null && machineHours(ctx, user.id) >= cap;
}

export function startRun(ctx: Ctx, taskId: string, userId: string, machineId: string): void {
  ctx.db.prepare("INSERT INTO machine_runs(task_id, user_id, machine_id, started_at) VALUES (?, ?, ?, ?)").run(taskId, userId, machineId, ctx.clock.now());
}
export function stopRuns(ctx: Ctx, taskId: string): void {
  ctx.db.prepare("UPDATE machine_runs SET stopped_at = ? WHERE task_id = ? AND stopped_at IS NULL").run(ctx.clock.now(), taskId);
}

// ---- instance budget ------------------------------------------------------------------------------

// Fly rates (USD), from Jarvis 1's budget.js (fly.io/docs/about/pricing, 2026-09).
const HOURS_PER_MONTH = 730;
export const RATES = {
  sharedCpuPerHour: 0.0015,
  performanceCpuPerHour: 0.0315,
  ramPerGbHour: 5 / HOURS_PER_MONTH,
};
/** Longest gap one sample may bill for (the server was down; don't invent days). */
export const MAX_DELTA_H = 6;

export function hourlyMachineCostUSD(guest: MachineSpec["guest"] | undefined): number {
  if (!guest) return 0;
  const cpuRate = guest.cpu_kind === "performance" ? RATES.performanceCpuPerHour : RATES.sharedCpuPerHour;
  return (Number(guest.cpus) || 1) * cpuRate + ((Number(guest.memory_mb) || 0) / 1024) * RATES.ramPerGbHour;
}

export interface BudgetState {
  month: string;
  spentUsd: number;
  lastSampleAt: number | null;
  ratePerHour: number;
  warned: boolean;
  capped: boolean;
}

const fresh = (month: string): BudgetState => ({ month, spentUsd: 0, lastSampleAt: null, ratePerHour: 0, warned: false, capped: false });

/** Pure: fold one burn-rate sample into the month's state (a Riemann sum, as in Jarvis 1). */
export function applySample(
  prev: BudgetState | null,
  o: { nowMs: number; ratePerHour: number; capUsd: number | null; warnUsd: number | null },
): { state: BudgetState; enforce: boolean; capNotice: boolean; warnNotice: boolean } {
  const month = monthKey(o.nowMs);
  const s = prev && prev.month === month ? { ...prev } : fresh(month);
  let dh = s.lastSampleAt === null ? 0 : (o.nowMs - s.lastSampleAt) / 3_600_000;
  if (!(dh > 0)) dh = 0;
  if (dh > MAX_DELTA_H) dh = MAX_DELTA_H;
  // the rate in force since the previous sample is the previous one
  s.spentUsd += s.ratePerHour * dh;
  s.lastSampleAt = o.nowMs;
  s.ratePerHour = o.ratePerHour;
  let enforce = false, capNotice = false, warnNotice = false;
  if (o.capUsd && s.spentUsd >= o.capUsd) {
    enforce = true;
    if (!s.capped) capNotice = true;
    s.capped = true;
    s.warned = true;
  } else if (o.warnUsd && s.spentUsd >= o.warnUsd && !s.warned) {
    warnNotice = true;
    s.warned = true;
  }
  return { state: s, enforce, capNotice, warnNotice };
}

export function budgetThresholds(ctx: Ctx): { capUsd: number | null; warnUsd: number | null } {
  const cap = ctx.config.budget.monthlyUsd || null;
  const warn = ctx.config.budget.warnUsd ?? (cap ? Math.round(cap * 0.8 * 100) / 100 : null);
  return { capUsd: cap, warnUsd: warn || null };
}

export function budgetState(ctx: Ctx): BudgetState {
  const s = kvGet<BudgetState>(ctx.db, "budget");
  const month = monthKey(ctx.clock.now());
  return s && s.month === month ? s : fresh(month);
}
export function saveBudget(ctx: Ctx, s: BudgetState): void {
  kvSet(ctx.db, "budget", s);
}
export function budgetCapped(ctx: Ctx): boolean {
  return budgetState(ctx).capped;
}

export function budgetView(ctx: Ctx): BudgetView {
  const s = budgetState(ctx);
  const t = budgetThresholds(ctx);
  return {
    month: s.month,
    spentUsd: Math.round(s.spentUsd * 10000) / 10000,
    capUsd: t.capUsd,
    warnUsd: t.warnUsd,
    capped: s.capped,
    ratePerHour: s.ratePerHour,
    lastSampleAt: s.lastSampleAt === null ? null : iso(s.lastSampleAt),
  };
}
