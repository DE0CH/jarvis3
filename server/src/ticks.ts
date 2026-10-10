// Background loops: idle auto-pause, per-user machine-hour caps, the instance budget guard
// (wakeups.ts and schedules.ts have their own ticks, run from app.ts after these).
// (Directory sync runs on its own interval, see app.ts.) Each tick is safe to run at any time.
import type { Ctx } from "./ctx.ts";
import { addNotice, isAdminRole } from "./ctx.ts";
import type { UserRow } from "./rows.ts";
import { monthKey } from "./clock.ts";
import { kvGet, kvSet } from "./db.ts";
import { applySample, budgetState, budgetThresholds, hourlyMachineCostUSD, limitsFor, machineHoursCapReached, saveBudget } from "./spend.ts";
import { listSuggestions, refreshSuggestions } from "./suggestions.ts";
import { liveTasksOf, pauseTask } from "./tasks.ts";
import type { TaskRow } from "./rows.ts";
import { hasPending } from "./inbox.ts";

function tryPause(ctx: Ctx, t: TaskRow, reason: "idle" | "machine_hours_cap" | "instance_budget"): boolean {
  try {
    pauseTask(ctx, t, reason);
    return true;
  } catch (e) {
    ctx.log("tick: pause refused", { task: t.id, reason, error: (e as Error).message });
    return false;
  }
}

export function idleTick(ctx: Ctx): string[] {
  if (!ctx.config.idleMinutes) return [];
  const cutoff = ctx.clock.now() - ctx.config.idleMinutes * 60_000;
  const paused: string[] = [];
  for (const t of liveTasksOf(ctx, null)) {
    // a task with a wakeup message on its way isn't idle: it is about to get a turn
    if (t.state === "idle" && t.idle_since !== null && t.idle_since <= cutoff && !hasPending(ctx, t.id) && tryPause(ctx, t, "idle")) paused.push(t.id);
  }
  return paused;
}

export function capTick(ctx: Ctx): string[] {
  const paused: string[] = [];
  const users = ctx.db.prepare("SELECT * FROM users WHERE status = 'active'").all() as unknown as UserRow[];
  for (const u of users) {
    if (!machineHoursCapReached(ctx, u)) continue;
    const live = liveTasksOf(ctx, u.id);
    for (const t of live) if (tryPause(ctx, t, "machine_hours_cap")) paused.push(t.id);
    // once per month and cap: an admin who raises the cap and sees it reached again is told again
    const flag = `notice:cap:${u.id}:${monthKey(ctx.clock.now())}:${limitsFor(ctx, u).machineHoursPerMonth}`;
    if (!kvGet<boolean>(ctx.db, flag)) {
      kvSet(ctx.db, flag, true);
      const cap = limitsFor(ctx, u).machineHoursPerMonth;
      addNotice(ctx, u.id, "machine_hours_cap", `You have used this month's ${cap} machine hours. Your tasks are paused until next month or until an admin raises your limit.`);
      for (const a of admins(ctx))
        if (a.id !== u.id) addNotice(ctx, a.id, "machine_hours_cap", `${u.email} reached their monthly machine-hour cap (${cap} h); their tasks were paused. You can raise it on the Users page.`);
    }
  }
  return paused;
}

function admins(ctx: Ctx): UserRow[] {
  return (ctx.db.prepare("SELECT * FROM users WHERE status = 'active'").all() as unknown as UserRow[]).filter((u) => isAdminRole(ctx.config, u.role));
}

export async function budgetTick(ctx: Ctx): Promise<{ enforce: boolean; paused: string[] }> {
  const { capUsd, warnUsd } = budgetThresholds(ctx);
  const machines = await ctx.machines.list();
  const ratePerHour = machines.filter((m) => m.state === "started").reduce((s, m) => s + hourlyMachineCostUSD(m.guest), 0);
  const r = applySample(budgetState(ctx), { nowMs: ctx.clock.now(), ratePerHour, capUsd, warnUsd });
  saveBudget(ctx, r.state);
  const paused: string[] = [];
  if (r.enforce) for (const t of liveTasksOf(ctx, null)) if (tryPause(ctx, t, "instance_budget")) paused.push(t.id);
  if (r.capNotice) {
    for (const a of admins(ctx)) addNotice(ctx, a.id, "instance_budget", `The instance's machine budget (USD ${capUsd}) for ${r.state.month} is used up; every task was paused.`);
    const owners = new Set(paused.map((id) => (ctx.db.prepare("SELECT user_id FROM tasks WHERE id = ?").get(id) as { user_id: string }).user_id));
    for (const o of owners) addNotice(ctx, o, "instance_budget", "Your tasks were paused: the instance's machine budget for this month is used up.");
  } else if (r.warnNotice) {
    for (const a of admins(ctx)) addNotice(ctx, a.id, "instance_budget", `The instance's machine spend for ${r.state.month} passed USD ${warnUsd} (cap USD ${capUsd}).`);
  }
  return { enforce: r.enforce, paused };
}

/** How often the background loop re-checks open "Suggest for everyone" pull requests. */
export const SUGGESTION_POLL_MS = 5 * 60_000;

export async function suggestionTick(ctx: Ctx): Promise<void> {
  if (!ctx.forge) return;
  await refreshSuggestions(ctx, listSuggestions(ctx, null), SUGGESTION_POLL_MS);
}
