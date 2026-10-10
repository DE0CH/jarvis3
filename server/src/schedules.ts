// Scheduled tasks: a person sets a prompt to run as a NEW task of theirs on a cron schedule, in
// their time zone. At each firing the server starts the task as New task would (the owner's key,
// layers and caps), with the schedule's prompt as the first message, or records why it didn't:
//
//   skipped_budget   the instance's machine budget for the month is used up
//   skipped_cap      the owner's machine-hour cap for the month is reached
//   skipped_overlap  the previous run's task is still live (starting, running or idle): one run at a time
//   missed           the server was down at the time and is back more than `missedGraceMinutes` late
//   failed           the task could not be made (e.g. OpenRouter refused the key)
//
// A schedule fires at most every `minIntervalMinutes` (60 by default) and a person has at most
// `maxPerUser` of them, so a schedule can't burn machine hours faster than a person pressing New
// task would. Skips and failures leave the owner a notice when the result changes (not at every
// firing, so an hourly schedule at the cap doesn't flood them).
import type { CreateScheduleRequest, ScheduleDetail, SchedulePreview, ScheduleRunResult, ScheduleRunView, ScheduleView, UpdateScheduleRequest } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice } from "./ctx.ts";
import type { TaskRow, UserRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { HttpError, httpError } from "./errors.ts";
import { scheduleLimits } from "./config.ts";
import { CronError, localParts, nextRun, nextRuns, parseCron, shortestGapMinutes, validTimeZone, type Cron } from "./cron.ts";
import { budgetCapped, machineHoursCapReached } from "./spend.ts";
import { createTask } from "./tasks.ts";

export interface ScheduleRow {
  id: string;
  user_id: string;
  title: string;
  prompt: string;
  model: string;
  cron: string;
  time_zone: string;
  enabled: number;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: number;
  schedule_id: string;
  user_id: string;
  due_at: number;
  ran_at: number;
  manual: number;
  result: ScheduleRunResult;
  task_id: string | null;
  error: string | null;
}

const MAX_PROMPT = 16000;
const MAX_TITLE = 120;

const runView = (r: RunRow): ScheduleRunView => ({
  id: r.id,
  scheduleId: r.schedule_id,
  dueAt: iso(r.due_at),
  ranAt: iso(r.ran_at),
  manual: !!r.manual,
  result: r.result,
  taskId: r.task_id,
  error: r.error,
});

function lastRun(ctx: Ctx, scheduleId: string): RunRow | null {
  return (ctx.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1").get(scheduleId) as RunRow | undefined) ?? null;
}

export function scheduleView(ctx: Ctx, s: ScheduleRow): ScheduleView {
  const last = lastRun(ctx, s.id);
  return {
    id: s.id,
    userId: s.user_id,
    title: s.title,
    prompt: s.prompt,
    model: s.model,
    cron: s.cron,
    timeZone: s.time_zone,
    enabled: !!s.enabled,
    nextRunAt: s.next_run_at === null ? null : iso(s.next_run_at),
    lastRun: last ? runView(last) : null,
    createdAt: iso(s.created_at),
    updatedAt: iso(s.updated_at),
  };
}

export function scheduleDetail(ctx: Ctx, s: ScheduleRow): ScheduleDetail {
  const runs = ctx.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 50").all(s.id) as unknown as RunRow[];
  return { ...scheduleView(ctx, s), runs: runs.map(runView) };
}

export function getSchedule(ctx: Ctx, id: string): ScheduleRow | null {
  return (ctx.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as ScheduleRow | undefined) ?? null;
}

export function listSchedules(ctx: Ctx, userId: string | null): ScheduleRow[] {
  return (
    userId
      ? ctx.db.prepare("SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at DESC").all(userId)
      : ctx.db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all()
  ) as unknown as ScheduleRow[];
}

// ---- validation -------------------------------------------------------------------------------------------

const bad = (m: string) => httpError("bad_request", m);

/** The expression and zone, checked against the instance's minimum interval. */
function checkTiming(ctx: Ctx, cronText: unknown, tz: unknown): { cron: Cron; tz: string } {
  if (!validTimeZone(tz)) throw bad("timeZone must be an IANA time zone, e.g. Europe/London");
  let cron: Cron;
  try {
    cron = parseCron(cronText);
  } catch (e) {
    throw bad(`cron: ${(e as CronError).message}`);
  }
  const { minIntervalMinutes } = scheduleLimits(ctx.config);
  const gap = shortestGapMinutes(cron, tz, ctx.clock.now());
  if (gap !== null && gap < minIntervalMinutes) throw bad(`a schedule may run at most every ${minIntervalMinutes} minutes on this instance`);
  if (nextRun(cron, tz, ctx.clock.now()) === null) throw bad("that schedule never runs");
  return { cron, tz };
}

/** What the form shows while the person types an expression. */
export function preview(ctx: Ctx, body: { cron?: unknown; timeZone?: unknown }): SchedulePreview {
  try {
    const { cron, tz } = checkTiming(ctx, body?.cron, body?.timeZone);
    const next = nextRuns(cron, tz, ctx.clock.now(), 5).map((t) => ({ at: iso(t), local: localText(t, tz) }));
    return { ok: true, error: null, next };
  } catch (e) {
    return { ok: false, error: (e as Error).message, next: [] };
  }
}

const localText = (t: number, tz: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t)).replace(",", "");

function checkPrompt(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > MAX_PROMPT) throw bad(`prompt must be 1..${MAX_PROMPT} characters`);
  return v;
}
function checkTitle(v: unknown, prompt: string): string {
  if (v !== undefined && v !== null && (typeof v !== "string" || v.length > MAX_TITLE)) throw bad(`title must be ≤ ${MAX_TITLE} characters`);
  return ((typeof v === "string" && v.trim()) || prompt.trim().split("\n")[0]!.slice(0, 80)).trim();
}
function checkModel(ctx: Ctx, v: unknown): string {
  const model = v ?? ctx.config.defaultModel;
  if (typeof model !== "string" || !ctx.config.models.some((m) => m.id === model)) throw bad("model must be one of the instance's models");
  return model;
}

// ---- create / change / delete ------------------------------------------------------------------------------

export function createSchedule(ctx: Ctx, user: UserRow, body: CreateScheduleRequest): ScheduleRow {
  if (!body || typeof body !== "object") throw bad("body must be a schedule");
  const prompt = checkPrompt(body.prompt);
  const title = checkTitle(body.title, prompt);
  const model = checkModel(ctx, body.model);
  const { cron, tz } = checkTiming(ctx, body.cron, body.timeZone);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw bad("enabled must be true or false");
  const enabled = body.enabled ?? true;
  const { maxPerUser } = scheduleLimits(ctx.config);
  const n = (ctx.db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE user_id = ?").get(user.id) as { n: number }).n;
  if (n >= maxPerUser) throw httpError("too_many_requests", `you can have at most ${maxPerUser} schedules`);
  const id = randomId(8);
  const now = ctx.clock.now();
  ctx.db
    .prepare("INSERT INTO schedules(id, user_id, title, prompt, model, cron, time_zone, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, user.id, title, prompt, model, cron.source, tz, enabled ? 1 : 0, enabled ? nextRun(cron, tz, now) : null, now, now);
  return getSchedule(ctx, id)!;
}

export function updateSchedule(ctx: Ctx, s: ScheduleRow, body: UpdateScheduleRequest): ScheduleRow {
  if (!body || typeof body !== "object") throw bad("body must be a schedule change");
  const prompt = body.prompt === undefined ? s.prompt : checkPrompt(body.prompt);
  const title = body.title === undefined ? s.title : checkTitle(body.title, prompt);
  const model = body.model === undefined ? s.model : checkModel(ctx, body.model);
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw bad("enabled must be true or false");
  const enabled = body.enabled ?? !!s.enabled;
  const timingChanged = body.cron !== undefined || body.timeZone !== undefined;
  const { cron, tz } = timingChanged ? checkTiming(ctx, body.cron ?? s.cron, body.timeZone ?? s.time_zone) : { cron: parseCron(s.cron), tz: s.time_zone };
  const now = ctx.clock.now();
  // re-plan when the timing changes or the schedule is switched on; otherwise keep the next firing
  const next = !enabled ? null : timingChanged || !s.enabled || s.next_run_at === null ? nextRun(cron, tz, now) : s.next_run_at;
  ctx.db
    .prepare("UPDATE schedules SET title = ?, prompt = ?, model = ?, cron = ?, time_zone = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
    .run(title, prompt, model, cron.source, tz, enabled ? 1 : 0, next, now, s.id);
  return getSchedule(ctx, s.id)!;
}

/** The schedule and its run history go; tasks it started stay (they are the owner's tasks). */
export function deleteSchedule(ctx: Ctx, s: ScheduleRow): void {
  ctx.db.prepare("DELETE FROM schedules WHERE id = ?").run(s.id);
}

// ---- firing ------------------------------------------------------------------------------------------------

function record(ctx: Ctx, s: ScheduleRow, o: { dueAt: number; manual: boolean; result: ScheduleRunResult; taskId?: string | null; error?: string | null }): RunRow {
  const r = ctx.db
    .prepare("INSERT INTO schedule_runs(schedule_id, user_id, due_at, ran_at, manual, result, task_id, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(s.id, s.user_id, o.dueAt, ctx.clock.now(), o.manual ? 1 : 0, o.result, o.taskId ?? null, o.error ?? null);
  return ctx.db.prepare("SELECT * FROM schedule_runs WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as RunRow;
}

const SKIP_TEXT: Partial<Record<ScheduleRunResult, string>> = {
  skipped_cap: "your machine hours for this month are used up",
  skipped_budget: "the instance's machine budget for this month is used up",
  skipped_overlap: "its previous run is still going",
  missed: "the instance was unavailable at the time",
};

/** Tell the owner when a run didn't start, once per change of outcome. */
function noticeIfChanged(ctx: Ctx, s: ScheduleRow, prev: RunRow | null, run: RunRow): void {
  if (run.result === "started" || run.manual) return;
  if (prev && prev.result === run.result) return;
  const why = run.result === "failed" ? `it could not start: ${run.error ?? "unknown error"}` : SKIP_TEXT[run.result];
  addNotice(ctx, s.user_id, "schedule_skipped", `The scheduled task "${s.title}" did not run: ${why}.`);
}

function runTitle(s: ScheduleRow, at: number): string {
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: s.time_zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at)).replace(",", "");
  return `${s.title.slice(0, 100)} · ${when}`;
}

function firstPrompt(s: ScheduleRow, at: number, manual: boolean): string {
  const when = `${new Intl.DateTimeFormat("en-GB", { timeZone: s.time_zone, dateStyle: "full", timeStyle: "short" }).format(new Date(at))} (${s.time_zone})`;
  const how = manual ? "started by hand from its schedule" : `run by its schedule (${s.cron})`;
  return `[Scheduled task "${s.title}", ${how}, ${when}. Post the result to this task's channel with jarvis_post when done.]\n\n${s.prompt}`;
}

/** One firing: start the run's task, or record why not. */
export async function fire(ctx: Ctx, s: ScheduleRow, o: { dueAt: number; manual: boolean }): Promise<{ run: RunRow; task: TaskRow | null }> {
  const prev = lastRun(ctx, s.id);
  const user = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(s.user_id) as unknown as UserRow;
  const skip = (result: ScheduleRunResult, error: string | null = null) => {
    const run = record(ctx, s, { ...o, result, error });
    noticeIfChanged(ctx, s, prev, run);
    return { run, task: null };
  };
  if (!user || user.status !== "active") return skip("failed", "the owner is not an active member");
  if (budgetCapped(ctx)) return skip("skipped_budget");
  if (machineHoursCapReached(ctx, user)) return skip("skipped_cap");
  const live = ctx.db.prepare(`SELECT id FROM tasks WHERE schedule_id = ? AND state IN ('starting','running','idle','pausing')`).get(s.id);
  if (live) return skip("skipped_overlap");
  try {
    const task = await createTask(ctx, user, { prompt: firstPrompt(s, o.dueAt, o.manual), model: s.model, title: runTitle(s, o.dueAt) }, { scheduleId: s.id });
    const run = record(ctx, s, { ...o, result: "started", taskId: task.id });
    noticeIfChanged(ctx, s, prev, run);
    return { run, task };
  } catch (e) {
    const he = e instanceof HttpError ? e : null;
    if (he?.code === "machine_hours_cap") return skip("skipped_cap");
    if (he?.code === "instance_budget") return skip("skipped_budget");
    return skip("failed", (e as Error).message.slice(0, 300));
  }
}

/** "Run now": a firing outside the schedule (caps and the one-run-at-a-time rule still apply). */
export async function runNow(ctx: Ctx, s: ScheduleRow): Promise<{ run: ScheduleRunView; task: TaskRow | null }> {
  const r = await fire(ctx, s, { dueAt: ctx.clock.now(), manual: true });
  return { run: runView(r.run), task: r.task };
}

/** Every due schedule of an active owner fires once; the next firing is planned before the run starts. */
export async function scheduleTick(ctx: Ctx): Promise<number> {
  let fired = 0;
  {
    const now = ctx.clock.now();
    const due = ctx.db
      .prepare(
        `SELECT s.* FROM schedules s JOIN users u ON u.id = s.user_id
         WHERE s.enabled = 1 AND s.next_run_at IS NOT NULL AND s.next_run_at <= ? AND u.status = 'active' ORDER BY s.next_run_at`,
      )
      .all(now) as unknown as ScheduleRow[];
    const { missedGraceMinutes } = scheduleLimits(ctx.config);
    for (const s of due) {
      const dueAt = s.next_run_at!;
      let next: number | null = null;
      try {
        next = nextRun(parseCron(s.cron), s.time_zone, now);
      } catch (e) {
        ctx.log("schedule: bad stored expression", { schedule: s.id, error: (e as Error).message });
      }
      ctx.db.prepare("UPDATE schedules SET next_run_at = ? WHERE id = ?").run(next, s.id);
      if (now - dueAt > missedGraceMinutes * 60_000) {
        const prev = lastRun(ctx, s.id);
        noticeIfChanged(ctx, s, prev, record(ctx, s, { dueAt, manual: false, result: "missed" }));
        continue;
      }
      await fire(ctx, s, { dueAt, manual: false }).catch((e: Error) => ctx.log("schedule run failed", { schedule: s.id, error: e.message }));
      fired++;
    }
  }
  return fired;
}
