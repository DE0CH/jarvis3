// Wakeups: a task asks to be woken (Jarvis 1's schedule-wakeup, crons and conditional-wakeup, made
// per task and per user). At the due time, or when an HTTP check passes, the server puts the
// wakeup's prompt in the task's inbox (inbox.ts) and, if the task is paused, resumes it; the session
// hands the prompt to the task's agent. Every wakeup belongs to its task: destroying the task (or
// offboarding its owner) cancels it, and nothing runs on its own.
//
//   time    `at` once, or `cron` (+ zone) repeatedly until cancelled or `expires_at`
//   check   every `interval_seconds` the server GETs a public HTTPS URL (httpcheck.ts); on a pass
//           the prompt is delivered; at `expires_at` it gives up and delivers `fail_prompt` (or,
//           without one, leaves the owner a notice)
//
// A wakeup that can't resume its task (the owner's machine-hour cap, the instance budget) leaves
// its message in the inbox and the owner a notice; the message arrives when the task next starts.
import { createHash } from "node:crypto";
import type { ArmWakeupRequest, SessionWakeupRequest, WakeupCheck, WakeupView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice } from "./ctx.ts";
import type { TaskRow, UserRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { HttpError, httpError, notFound } from "./errors.ts";
import { wakeupLimits } from "./config.ts";
import { CronError, nextRun, parseCron, shortestGapMinutes, validTimeZone } from "./cron.ts";
import { checkUrl } from "./httpcheck.ts";
import { enqueue, tasksWithPending } from "./inbox.ts";
import { kvGet, kvSet } from "./db.ts";
import { getTask, resumeTask } from "./tasks.ts";

export interface WakeupRow {
  id: string;
  task_id: string;
  user_id: string;
  name: string;
  kind: "time" | "check";
  prompt: string;
  fail_prompt: string | null;
  at: number | null;
  cron: string | null;
  time_zone: string | null;
  check_spec: string | null;
  interval_seconds: number | null;
  expires_at: number | null;
  state: WakeupView["state"];
  baseline: string | null;
  checks: number;
  fired_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  set_by: "task" | "owner";
}

const DAY = 24 * 3600_000;
const MAX_AHEAD = 365 * DAY;
const MAX_CHECK_LIFE = 30 * DAY;
const DEFAULT_CHECK_LIFE = 7 * DAY;
const MAX_PROMPT = 4000;
/** Checks run per tick at most (the rest wait for the next minute). */
const CHECKS_PER_TICK = 50;

export function wakeupView(w: WakeupRow): WakeupView {
  return {
    id: w.id,
    taskId: w.task_id,
    userId: w.user_id,
    name: w.name,
    kind: w.kind,
    prompt: w.prompt,
    failPrompt: w.fail_prompt,
    at: w.at === null ? null : iso(w.at),
    cron: w.cron,
    timeZone: w.time_zone,
    check: w.check_spec ? (JSON.parse(w.check_spec) as WakeupCheck) : null,
    intervalSeconds: w.interval_seconds,
    expiresAt: w.expires_at === null ? null : iso(w.expires_at),
    state: w.state,
    firedAt: w.fired_at === null ? null : iso(w.fired_at),
    lastError: w.last_error,
    checks: w.checks,
    createdAt: iso(w.created_at),
    setBy: w.set_by,
  };
}

function update(ctx: Ctx, id: string, patch: Partial<Omit<WakeupRow, "id">>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  ctx.db
    .prepare(`UPDATE wakeups SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null), ctx.clock.now(), id);
}

export function getWakeup(ctx: Ctx, id: string): WakeupRow | null {
  return (ctx.db.prepare("SELECT * FROM wakeups WHERE id = ?").get(id) as WakeupRow | undefined) ?? null;
}

/** Armed wakeups first (soonest first), then the latest settled ones. */
export function listWakeups(ctx: Ctx, o: { userId?: string | null; taskId?: string }): WakeupRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (o.userId) (where.push("user_id = ?"), args.push(o.userId));
  if (o.taskId) (where.push("task_id = ?"), args.push(o.taskId));
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return ctx.db
    .prepare(`SELECT * FROM wakeups ${w} ORDER BY state = 'armed' DESC, CASE WHEN state = 'armed' THEN at END ASC, updated_at DESC LIMIT 200`)
    .all(...args) as unknown as WakeupRow[];
}

// ---- arming (the session, or the owner from the app) ------------------------------------------------------------------------------

const bad = (m: string) => httpError("bad_request", m);

function text(v: unknown, what: string, max: number, required: boolean): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw bad(`${what} is required`);
    return null;
  }
  if (typeof v !== "string" || !v.trim() || v.length > max) throw bad(`${what} must be 1..${max} characters`);
  return v.trim();
}

function time(v: unknown, what: string): number {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) throw bad(`${what} must be an ISO-8601 time`);
  return t;
}

function normalizeCheck(c: unknown): WakeupCheck {
  if (!c || typeof c !== "object") throw bad("check must be an object");
  const x = c as Record<string, unknown>;
  try {
    checkUrl(x.url);
  } catch (e) {
    throw bad((e as Error).message);
  }
  const out: WakeupCheck = { url: x.url as string };
  if (x.status !== undefined) {
    if (!Number.isInteger(x.status) || (x.status as number) < 100 || (x.status as number) > 599) throw bad("check.status must be an HTTP status");
    out.status = x.status as number;
  }
  for (const k of ["contains", "absent"] as const) {
    if (x[k] === undefined) continue;
    if (typeof x[k] !== "string" || !(x[k] as string).length || (x[k] as string).length > 500) throw bad(`check.${k} must be 1..500 characters`);
    out[k] = x[k] as string;
  }
  if (x.changed !== undefined) {
    if (typeof x.changed !== "boolean") throw bad("check.changed must be true or false");
    if (x.changed) out.changed = true;
  }
  if (out.status === undefined && out.contains === undefined && out.absent === undefined && !out.changed) throw bad("check needs a condition: status, contains, absent or changed");
  return out;
}

/** What the agent gets from an owner's wakeup without a message of its own. */
export const OWNER_DEFAULT_PROMPT = "Your user asked, from the app, for this task to be woken now. Pick up where you left off, or check whether anything needs doing.";

/**
 * The task's owner, from the app: wake the task once at `at` (time only; cron and checks are the
 * agent's). Same limits as the session's: at most `maxPerTask` armed, within 365 days. Each one
 * gets its own name, so it never replaces the agent's wakeups or an earlier one of the owner's.
 */
export function armFromOwner(ctx: Ctx, task: TaskRow, body: ArmWakeupRequest): WakeupRow {
  if (!body || typeof body !== "object") throw bad("body must be a wakeup");
  const extra = Object.keys(body).filter((k) => k !== "at" && k !== "prompt");
  if (extra.length) throw bad(`a wakeup from the app takes only at and prompt (not ${extra.join(", ")})`);
  if (body.at === undefined || body.at === null) throw bad("at is required");
  if (task.state === "archived" || task.state === "destroying" || task.state === "failed") throw httpError("conflict", `the task is ${task.state}; it can't be woken`);
  const prompt = text(body.prompt, "prompt", MAX_PROMPT, false) ?? OWNER_DEFAULT_PROMPT;
  return arm(ctx, task, { name: `app-${randomId(3)}`, prompt, at: body.at }, "owner");
}

export function armFromSession(ctx: Ctx, task: TaskRow, body: SessionWakeupRequest): WakeupRow {
  return arm(ctx, task, body, "task");
}

function arm(ctx: Ctx, task: TaskRow, body: SessionWakeupRequest, setBy: WakeupRow["set_by"]): WakeupRow {
  if (!body || typeof body !== "object") throw bad("body must be a wakeup");
  const lim = wakeupLimits(ctx.config);
  const now = ctx.clock.now();
  const name = body.name === undefined || body.name === "" ? "default" : body.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw bad("name must be 1-40 letters, digits, _ or -");
  const prompt = text(body.prompt, "prompt", MAX_PROMPT, true)!;
  const failPrompt = text(body.failPrompt, "failPrompt", MAX_PROMPT, false);
  const given = (["at", "inSeconds", "cron", "check"] as const).filter((k) => body[k] !== undefined && body[k] !== null);
  if (given.length !== 1) throw bad("give exactly one of at, inSeconds, cron or check");
  const until = body.until === undefined || body.until === null ? null : time(body.until, "until");
  const owner = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(task.user_id) as unknown as UserRow;

  let row: Omit<WakeupRow, "id" | "state" | "baseline" | "checks" | "fired_at" | "last_error" | "created_at" | "updated_at" | "set_by">;
  const base = { task_id: task.id, user_id: task.user_id, name, prompt, fail_prompt: null as string | null, cron: null, time_zone: null, check_spec: null, interval_seconds: null, expires_at: null };
  if (given[0] === "at" || given[0] === "inSeconds") {
    if (failPrompt) throw bad("failPrompt is only for check wakeups");
    let at: number;
    if (given[0] === "at") at = time(body.at, "at");
    else {
      const s = Number(body.inSeconds);
      if (!Number.isFinite(s) || s <= 0) throw bad("inSeconds must be a positive number");
      at = now + Math.round(s * 1000);
    }
    if (at <= now) throw bad("the wakeup time is in the past");
    if (at - now > MAX_AHEAD) throw bad("the wakeup is more than 365 days away");
    if (until !== null) throw bad("until is only for cron and check wakeups");
    row = { ...base, kind: "time", at };
  } else if (given[0] === "cron") {
    if (failPrompt) throw bad("failPrompt is only for check wakeups");
    const tz = body.timeZone ?? owner?.time_zone ?? "UTC";
    if (!validTimeZone(tz)) throw bad("timeZone must be an IANA time zone, e.g. Europe/London");
    let cron;
    try {
      cron = parseCron(body.cron);
    } catch (e) {
      throw bad(`cron: ${(e as CronError).message}`);
    }
    const gap = shortestGapMinutes(cron, tz, now);
    if (gap !== null && gap < lim.minIntervalMinutes) throw bad(`a recurring wakeup may fire at most every ${lim.minIntervalMinutes} minutes`);
    if (until !== null && (until <= now || until - now > MAX_AHEAD)) throw bad("until must be within the next 365 days");
    const at = nextRun(cron, tz, now);
    if (at === null || (until !== null && at > until)) throw bad("that schedule never fires");
    row = { ...base, kind: "time", at, cron: cron.source, time_zone: tz, expires_at: until };
  } else {
    const check = normalizeCheck(body.check);
    const interval = body.intervalSeconds === undefined ? Math.max(300, lim.minCheckSeconds) : Number(body.intervalSeconds);
    if (!Number.isInteger(interval) || interval < lim.minCheckSeconds || interval > 86400) throw bad(`intervalSeconds must be ${lim.minCheckSeconds}..86400`);
    const expires = until ?? now + DEFAULT_CHECK_LIFE;
    if (expires <= now || expires - now > MAX_CHECK_LIFE) throw bad("until must be within the next 30 days");
    row = { ...base, kind: "check", at: now, fail_prompt: failPrompt, check_spec: JSON.stringify(check), interval_seconds: interval, expires_at: expires };
  }

  const armed = ctx.db.prepare("SELECT id, name FROM wakeups WHERE task_id = ? AND state = 'armed'").all(task.id) as { id: string; name: string }[];
  const same = armed.find((w) => w.name === name);
  if (!same && armed.length >= lim.maxPerTask) throw httpError("too_many_requests", `a task may have at most ${lim.maxPerTask} armed wakeups`);
  const id = randomId(8);
  ctx.db.exec("BEGIN IMMEDIATE");
  try {
    if (same) update(ctx, same.id, { state: "cancelled", last_error: "replaced by a wakeup with the same name" });
    ctx.db
      .prepare(
        `INSERT INTO wakeups(id, task_id, user_id, name, kind, prompt, fail_prompt, at, cron, time_zone, check_spec, interval_seconds, expires_at, state, created_at, updated_at, set_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', ?, ?, ?)`,
      )
      .run(id, row.task_id, row.user_id, row.name, row.kind, row.prompt, row.fail_prompt, row.at, row.cron, row.time_zone, row.check_spec, row.interval_seconds, row.expires_at, now, now, setBy);
    ctx.db.exec("COMMIT");
  } catch (e) {
    ctx.db.exec("ROLLBACK");
    throw e;
  }
  return getWakeup(ctx, id)!;
}

/** Cancel one wakeup (the owner, an admin, or the session by name). */
export function cancelWakeup(ctx: Ctx, w: WakeupRow, why: string): WakeupRow {
  if (w.state !== "armed") throw httpError("conflict", `the wakeup is already ${w.state}`);
  update(ctx, w.id, { state: "cancelled", last_error: why });
  return getWakeup(ctx, w.id)!;
}

export function armedByName(ctx: Ctx, taskId: string, name: string): WakeupRow {
  const w = ctx.db.prepare("SELECT * FROM wakeups WHERE task_id = ? AND name = ? AND state = 'armed'").get(taskId, name) as WakeupRow | undefined;
  if (!w) throw notFound("wakeup");
  return w;
}

/** Every armed wakeup of a task goes with it (destroy, a failed start, offboarding). */
export function cancelForTask(ctx: Ctx, taskId: string, why: string): void {
  ctx.db.prepare("UPDATE wakeups SET state = 'cancelled', last_error = ?, updated_at = ? WHERE task_id = ? AND state = 'armed'").run(why, ctx.clock.now(), taskId);
}

// ---- firing (the tick) -------------------------------------------------------------------------------------

function header(w: WakeupRow, now: number, what: string): string {
  const by = w.set_by === "owner" ? "set by your user from the app" : "set earlier by this task";
  return `[Jarvis wakeup "${w.name}" (${what}), ${by}; now ${iso(now)}]`;
}

/** Put a message in the task's inbox and make sure the task is up to read it. */
function deliver(ctx: Ctx, w: WakeupRow, message: string): void {
  const inboxId = enqueue(ctx, w.task_id, "wakeup", w.id, message);
  wake(ctx, w.task_id, inboxId);
}

/**
 * Resume a paused task that has mail. Refused by a cap or the budget: the message waits and the
 * owner is told once per message (`inboxId`), or once per task when retried from the tick.
 */
export function wake(ctx: Ctx, taskId: string, inboxId: string | null): void {
  const t = getTask(ctx, taskId);
  if (!t || t.state !== "paused" || ctx.locks.has(taskId)) return;
  try {
    resumeTask(ctx, t);
    ctx.log("wakeup: resuming the task", { task: taskId });
  } catch (e) {
    const he = e instanceof HttpError ? e : null;
    if (!inboxId) return; // a retry: the owner was told when the message arrived
    const flag = `notice:wake:${inboxId}`;
    if (kvGet<boolean>(ctx.db, flag)) return;
    kvSet(ctx.db, flag, true);
    const why = he?.code === "machine_hours_cap" ? "your machine hours for this month are used up" : he?.code === "instance_budget" ? "the instance's machine budget for this month is used up" : (he?.message ?? (e as Error).message);
    addNotice(ctx, t.user_id, "wakeup", `Task "${t.title}" has a wakeup waiting but could not start: ${why}. It will get the message when it next starts.`, t.id);
  }
}

function fireTime(ctx: Ctx, w: WakeupRow, now: number): void {
  let next: number | null = null;
  if (w.cron && w.time_zone) {
    next = nextRun(parseCron(w.cron), w.time_zone, now);
    if (next !== null && w.expires_at !== null && next > w.expires_at) next = null;
  }
  // the row first: a crash after this delivers nothing twice
  if (next !== null) update(ctx, w.id, { at: next, fired_at: now, last_error: null });
  else update(ctx, w.id, { state: "fired", fired_at: now, last_error: null });
  deliver(ctx, w, `${header(w, now, w.cron ? `recurring, ${w.cron} ${w.time_zone}` : "timed")}\n${w.prompt}`);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function runCheck(ctx: Ctx, w: WakeupRow, now: number): Promise<void> {
  const check = JSON.parse(w.check_spec!) as WakeupCheck;
  if (w.expires_at !== null && now >= w.expires_at) {
    update(ctx, w.id, { state: "expired", fired_at: now });
    if (w.fail_prompt) deliver(ctx, w, `${header(w, now, `condition check gave up after ${w.checks} checks of ${check.url}`)}\n${w.fail_prompt}`);
    else {
      const t = getTask(ctx, w.task_id);
      addNotice(ctx, w.user_id, "wakeup", `The wakeup "${w.name}" of task "${t?.title ?? w.task_id}" gave up: its condition on ${check.url} never held.`, w.task_id);
    }
    return;
  }
  const nextAt = now + (w.interval_seconds ?? 300) * 1000;
  let res;
  try {
    res = await ctx.checker.get(check.url);
  } catch (e) {
    update(ctx, w.id, { at: nextAt, checks: w.checks + 1, last_error: `check failed: ${(e as Error).message.slice(0, 200)}` });
    return;
  }
  const fresh = getWakeup(ctx, w.id);
  if (!fresh || fresh.state !== "armed") return; // cancelled while the request ran
  let pass = true;
  let baseline = w.baseline;
  if (check.status !== undefined && res.status !== check.status) pass = false;
  if (check.contains !== undefined && !res.body.includes(check.contains)) pass = false;
  if (check.absent !== undefined && res.body.includes(check.absent)) pass = false;
  if (check.changed) {
    const h = sha(res.body);
    if (baseline === null) {
      baseline = h;
      pass = false;
    } else if (h === baseline) pass = false;
  }
  if (!pass) {
    update(ctx, w.id, { at: nextAt, checks: w.checks + 1, baseline, last_error: null });
    return;
  }
  update(ctx, w.id, { state: "fired", fired_at: now, checks: w.checks + 1, baseline, last_error: null });
  deliver(ctx, w, `${header(w, now, `condition met: GET ${check.url} answered HTTP ${res.status}`)}\n${w.prompt}`);
}

/** One pass: due time wakeups, due checks, and paused tasks that still have mail. */
export async function wakeupTick(ctx: Ctx): Promise<void> {
  const now = ctx.clock.now();
  const due = (sql: string) =>
    (ctx.db.prepare(`SELECT w.* FROM wakeups w JOIN users u ON u.id = w.user_id WHERE w.state = 'armed' AND ${sql} AND w.at <= ? AND u.status = 'active' ORDER BY w.at`).all(now) as unknown as WakeupRow[]);
  for (const w of due("w.kind = 'time'")) {
    try {
      fireTime(ctx, w, now);
    } catch (e) {
      ctx.log("wakeup failed", { wakeup: w.id, error: (e as Error).message });
    }
  }
  for (const w of due("w.kind = 'check'").slice(0, CHECKS_PER_TICK)) {
    await runCheck(ctx, w, now).catch((e: Error) => ctx.log("wakeup check failed", { wakeup: w.id, error: e.message }));
  }
  for (const taskId of tasksWithPending(ctx)) {
    const t = getTask(ctx, taskId);
    if (t && t.state === "paused") wake(ctx, taskId, null);
    else if (!t || t.state === "archived" || t.state === "failed") {
      // archived or failed: nobody will read it
      ctx.db.prepare("UPDATE inbox SET delivered_at = ? WHERE task_id = ? AND delivered_at IS NULL").run(now, taskId);
    }
  }
}
