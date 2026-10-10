// Tasks (sessions): create, pause (snapshot -> destroy), resume (new machine from the snapshot),
// destroy (archive first). One lifecycle operation per task at a time; another while one runs is
// refused with 409 busy (never queued). Ported in spirit from Jarvis 1 (server.js, archive.js,
// paused.js), per user and without any Claude-shaped state.
//
// Storage layout in the bucket:
//   snapshots/<taskId>/state.tar.gz           the pause snapshot (overwritten by each pause)
//   archives/<userId>/<taskId>/state.tar.gz   the final state, written by Destroy
//   archives/<userId>/<taskId>/task.json      the task record at Destroy
import type { CreateTaskRequest, TaskState, TaskView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice } from "./ctx.ts";
import type { TaskRow, UserRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { mintToken, randomId, sha256hex } from "./crypto.ts";
import { httpError, notFound } from "./errors.ts";
import { ensureKey } from "./userkeys.ts";
import { budgetCapped, machineHoursCapReached, startRun, stopRuns } from "./spend.ts";

export type BusyKind = "creating" | "pausing" | "resuming" | "destroying";
export type PauseReason = "user" | "idle" | "machine_hours_cap" | "instance_budget" | "offboarded";

/** Live states: a machine exists (or is being made). */
export const LIVE: ReadonlySet<TaskState> = new Set<TaskState>(["starting", "running", "idle"]);

const daemonAad = (taskId: string) => `daemon:${taskId}`;
export const snapshotKey = (taskId: string) => `snapshots/${taskId}/state.tar.gz`;
export const archiveKey = (userId: string, taskId: string, file = "state.tar.gz") => `archives/${userId}/${taskId}/${file}`;

export function getTask(ctx: Ctx, id: string): TaskRow | null {
  return (ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined) ?? null;
}

export function taskView(ctx: Ctx, t: TaskRow): TaskView {
  const b = ctx.locks.get(t.id);
  return {
    id: t.id,
    userId: t.user_id,
    title: t.title,
    model: t.model,
    state: t.state,
    busy: b ? { kind: b.kind, since: iso(b.since) } : null,
    error: t.error,
    pausedReason: (t.paused_reason as TaskView["pausedReason"]) ?? null,
    createdAt: iso(t.created_at),
    updatedAt: iso(t.updated_at),
    connected: ctx.hub.isConnected(t.id),
    agentId: t.agent_id ?? null,
  };
}

function update(ctx: Ctx, id: string, patch: Partial<Omit<TaskRow, "id">>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  ctx.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null), ctx.clock.now(), id);
}

function lock(ctx: Ctx, id: string, kind: BusyKind): void {
  const b = ctx.locks.get(id);
  if (b) throw httpError("busy", `task is ${b.kind} — try again once that has finished`);
  ctx.locks.set(id, { kind, since: ctx.clock.now() });
}
const unlock = (ctx: Ctx, id: string) => ctx.locks.delete(id);

function userRow(ctx: Ctx, id: string): UserRow {
  return ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow;
}

function checkCaps(ctx: Ctx, user: UserRow): void {
  if (budgetCapped(ctx)) throw httpError("instance_budget", "the instance's machine budget for this month is used up");
  if (machineHoursCapReached(ctx, user)) throw httpError("machine_hours_cap", "your machine hours for this month are used up");
}

// ---- machines --------------------------------------------------------------------------------

async function launch(ctx: Ctx, task: TaskRow, user: UserRow, o: { firstPrompt?: string; restore: boolean }): Promise<void> {
  const key = await ensureKey(ctx, user);
  const token = mintToken();
  const env: Record<string, string> = {
    JARVIS_URL: ctx.config.publicUrl,
    JARVIS_TASK_ID: task.id,
    JARVIS_SESSION_TOKEN: token,
    JARVIS_DAEMON_PATH: ctx.config.daemonPath,
    CF_ACCESS_CLIENT_ID: ctx.config.access.sessionGateClientId,
    CF_ACCESS_CLIENT_SECRET: ctx.sessionGateClientSecret,
    OPENROUTER_API_KEY: key,
    JARVIS_MODEL: task.model,
    PASEO_PASSWORD: ctx.sealer.open(task.daemon_password_sealed, daemonAad(task.id)),
  };
  if (o.firstPrompt) env.JARVIS_FIRST_PROMPT = o.firstPrompt;
  if (o.restore) env.JARVIS_RESTORE_URL = await ctx.blobs.presignGet(snapshotKey(task.id), ctx.config.presignSeconds ?? 3600);
  // the token must be known before the machine can dial in
  update(ctx, task.id, { session_token_hash: sha256hex(token) });
  const m = await ctx.machines.create({
    name: `task-${task.id}`,
    image: ctx.config.machines.image,
    env,
    metadata: { jarvisTask: task.id, jarvisUser: user.id, jarvisInstance: ctx.config.instanceName },
    guest: ctx.config.machines.guest,
  });
  update(ctx, task.id, { machine_id: m.id });
  try {
    await ctx.machines.start(m.id);
  } catch (e) {
    await ctx.machines.destroy(m.id).catch(() => {});
    update(ctx, task.id, { machine_id: null });
    throw e;
  }
  startRun(ctx, task.id, user.id, m.id);
}

/** Tear down the machine side of a task (after its state is safe elsewhere). */
async function release(ctx: Ctx, task: TaskRow): Promise<void> {
  ctx.hub.closeTask(task.id);
  if (task.machine_id) await ctx.machines.destroy(task.machine_id);
  stopRuns(ctx, task.id);
  update(ctx, task.id, { machine_id: null, session_token_hash: null, idle_since: null });
}

/**
 * Snapshot contract with the session image (docs/API.md): `jarvis-snapshot start <run> <url>`
 * starts a detached upload of the session's state to the presigned PUT url and prints "started";
 * `jarvis-snapshot status <run>` prints "running", "ok <bytes>" or "failed <message>".
 */
export async function runSnapshot(ctx: Ctx, machineId: string, key: string): Promise<void> {
  const url = await ctx.blobs.presignPut(key, ctx.config.presignSeconds ?? 3600);
  const run = randomId(6);
  const s = await ctx.machines.exec(machineId, ["/usr/local/bin/jarvis-snapshot", "start", run, url], 30);
  if (!/started/.test(s.stdout)) throw new Error(`snapshot did not start: ${(s.stderr || `exit ${s.exitCode}`).slice(0, 200)}`);
  const deadline = ctx.clock.now() + ctx.snapshotTimeoutMs;
  let misses = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, ctx.snapshotPollMs));
    let out = "";
    try {
      out = (await ctx.machines.exec(machineId, ["/usr/local/bin/jarvis-snapshot", "status", run], 15)).stdout.trim();
      misses = 0;
    } catch (e) {
      if (++misses >= 5) throw new Error(`lost contact with the machine while snapshotting: ${(e as Error).message}`);
      continue;
    }
    if (out.startsWith("ok")) break;
    if (out.startsWith("failed")) throw new Error(`snapshot failed: ${out.slice(7, 300)}`);
    if (ctx.clock.now() > deadline) throw new Error("snapshot timed out");
  }
  if (!(await ctx.blobs.exists(key))) throw new Error("snapshot reported ok but the object is missing");
}

// ---- operations ---------------------------------------------------------------------------------

export function createTask(ctx: Ctx, user: UserRow, body: CreateTaskRequest): Promise<TaskRow> {
  const prompt = body?.prompt;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 16000) throw httpError("bad_request", "prompt must be 1..16000 characters");
  const model = body.model ?? ctx.config.defaultModel;
  if (!ctx.config.models.some((m) => m.id === model)) throw httpError("bad_request", `model must be one of the instance's models`);
  const requestId = body.requestId ?? null;
  if (requestId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw httpError("bad_request", "requestId must be [A-Za-z0-9_-]{1,64}");
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 120)) throw httpError("bad_request", "title must be ≤ 120 characters");
  if (requestId) {
    const dup = ctx.db.prepare("SELECT * FROM tasks WHERE user_id = ? AND request_id = ?").get(user.id, requestId) as TaskRow | undefined;
    if (dup) return Promise.resolve(dup);
  }
  checkCaps(ctx, user);
  return (async () => {
    // the key first, in the request: an OpenRouter failure is the caller's 502, and no task is left behind
    await ensureKey(ctx, user);
    const id = randomId(8);
    const now = ctx.clock.now();
    const title = (body.title?.trim() || prompt.trim().split("\n")[0]!.slice(0, 80)).trim();
    const pw = mintToken();
    ctx.db
      .prepare(
        "INSERT INTO tasks(id, user_id, title, model, state, daemon_password_sealed, request_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?)",
      )
      .run(id, user.id, title, model, ctx.sealer.seal(pw, daemonAad(id)), requestId, now, now);
    const task = getTask(ctx, id)!;
    lock(ctx, id, "creating");
    ctx.ops.run(
      (async () => {
        try {
          await launch(ctx, task, user, { firstPrompt: prompt, restore: false });
        } catch (e) {
          const msg = (e as Error).message.slice(0, 300);
          update(ctx, id, { state: "failed", error: `could not start the machine: ${msg}`, session_token_hash: null });
          addNotice(ctx, user.id, "task_failed", `Task "${title}" could not start.`, id);
        } finally {
          unlock(ctx, id);
        }
      })(),
      ctx.log,
      `create ${id}`,
    );
    return getTask(ctx, id)!;
  })();
}

/**
 * Pause = snapshot, then destroy the machine. Returns once the job has STARTED (state pausing).
 * `force` (offboarding): if the snapshot fails, destroy the machine anyway.
 */
export function pauseTask(ctx: Ctx, task: TaskRow, reason: PauseReason, o: { force?: boolean } = {}): void {
  if (!LIVE.has(task.state)) throw httpError("conflict", `a ${task.state} task can't be paused`);
  lock(ctx, task.id, "pausing");
  const prev = task.state;
  update(ctx, task.id, { state: "pausing", error: null });
  ctx.ops.run(
    (async () => {
      try {
        let snapshotError: string | null = null;
        if (task.machine_id) {
          try {
            await runSnapshot(ctx, task.machine_id, snapshotKey(task.id));
            update(ctx, task.id, { has_snapshot: 1 });
          } catch (e) {
            snapshotError = (e as Error).message;
          }
        }
        if (snapshotError && !o.force) {
          update(ctx, task.id, { state: prev, error: `pause failed, the task keeps running: ${snapshotError}` });
          return;
        }
        await release(ctx, getTask(ctx, task.id)!);
        update(ctx, task.id, {
          state: "paused",
          paused_reason: reason,
          error: snapshotError ? `the snapshot failed, the machine was stopped anyway: ${snapshotError}` : null,
        });
      } finally {
        unlock(ctx, task.id);
      }
    })(),
    ctx.log,
    `pause ${task.id}`,
  );
}

export function resumeTask(ctx: Ctx, task: TaskRow): void {
  if (task.state !== "paused") throw httpError("conflict", `a ${task.state} task can't be resumed`);
  const user = userRow(ctx, task.user_id);
  if (user.status !== "active") throw httpError("conflict", "the task's owner is not an active member");
  checkCaps(ctx, user);
  lock(ctx, task.id, "resuming");
  update(ctx, task.id, { state: "starting", error: null, paused_reason: null });
  ctx.ops.run(
    (async () => {
      try {
        await launch(ctx, task, user, { restore: !!task.has_snapshot });
      } catch (e) {
        update(ctx, task.id, { state: "paused", session_token_hash: null, error: `could not resume: ${(e as Error).message.slice(0, 300)}` });
      } finally {
        unlock(ctx, task.id);
      }
    })(),
    ctx.log,
    `resume ${task.id}`,
  );
}

/** Destroy = archive first, then delete the machine. `force`: destroy even if archiving fails. */
export function destroyTask(ctx: Ctx, task: TaskRow, o: { force?: boolean } = {}): void {
  if (task.state === "archived") throw httpError("conflict", "the task is already archived");
  lock(ctx, task.id, "destroying");
  const prev = task.state;
  update(ctx, task.id, { state: "destroying", error: null });
  ctx.ops.run(
    (async () => {
      try {
        let archiveError: string | null = null;
        try {
          if (task.machine_id && LIVE.has(prev)) {
            await runSnapshot(ctx, task.machine_id, archiveKey(task.user_id, task.id));
          } else if (task.has_snapshot) {
            await ctx.blobs.copy(snapshotKey(task.id), archiveKey(task.user_id, task.id));
          }
          const t = getTask(ctx, task.id)!;
          await ctx.blobs.put(
            archiveKey(task.user_id, task.id, "task.json"),
            JSON.stringify({ id: t.id, userId: t.user_id, title: t.title, model: t.model, createdAt: iso(t.created_at), archivedAt: iso(ctx.clock.now()) }),
            "application/json",
          );
        } catch (e) {
          archiveError = (e as Error).message;
        }
        if (archiveError && !o.force) {
          update(ctx, task.id, { state: prev, error: `destroy stopped, the archive failed: ${archiveError}` });
          return;
        }
        await release(ctx, getTask(ctx, task.id)!);
        if (task.has_snapshot) await ctx.blobs.delete(snapshotKey(task.id)).catch(() => {});
        update(ctx, task.id, {
          state: "archived",
          archived_at: ctx.clock.now(),
          has_snapshot: 0,
          error: archiveError ? `destroyed without an archive: ${archiveError}` : null,
        });
      } finally {
        unlock(ctx, task.id);
      }
    })(),
    ctx.log,
    `destroy ${task.id}`,
  );
}

// ---- session-reported events ---------------------------------------------------------------------

export function onSessionConnected(ctx: Ctx, taskId: string): void {
  const t = getTask(ctx, taskId);
  if (t && t.state === "starting") update(ctx, taskId, { state: "running", idle_since: null });
}

export function reportStatus(ctx: Ctx, task: TaskRow, body: { activity?: unknown; title?: unknown; agentId?: unknown }): TaskView {
  if (body.activity !== "busy" && body.activity !== "idle") throw httpError("bad_request", "activity must be busy or idle");
  if (body.title !== undefined && (typeof body.title !== "string" || body.title.length > 120)) throw httpError("bad_request", "title must be ≤ 120 characters");
  if (body.agentId !== undefined && (typeof body.agentId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.agentId))) {
    throw httpError("bad_request", "agentId must match [A-Za-z0-9._:-]{1,128}");
  }
  const patch: Partial<TaskRow> = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim();
  if (typeof body.agentId === "string" && body.agentId !== task.agent_id) patch.agent_id = body.agentId;
  if (task.state === "starting" || task.state === "running" || task.state === "idle") {
    if (body.activity === "idle") {
      patch.state = "idle";
      if (task.state !== "idle") patch.idle_since = ctx.clock.now();
    } else {
      patch.state = "running";
      patch.idle_since = null;
    }
  }
  update(ctx, task.id, patch);
  return taskView(ctx, getTask(ctx, task.id)!);
}

// ---- queries ------------------------------------------------------------------------------------------

export function listTasks(ctx: Ctx, o: { userId?: string }): TaskRow[] {
  return (
    o.userId
      ? ctx.db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC").all(o.userId)
      : ctx.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all()
  ) as unknown as TaskRow[];
}

export function liveTasksOf(ctx: Ctx, userId: string | null): TaskRow[] {
  const rows = (
    userId
      ? ctx.db.prepare("SELECT * FROM tasks WHERE user_id = ? AND state IN ('starting','running','idle')").all(userId)
      : ctx.db.prepare("SELECT * FROM tasks WHERE state IN ('starting','running','idle')").all()
  ) as unknown as TaskRow[];
  return rows.filter((t) => !ctx.locks.has(t.id));
}

/** The task a route names, or the uniform 404. */
export function requireTask(ctx: Ctx, id: string): TaskRow {
  const t = getTask(ctx, id);
  if (!t) throw notFound("task");
  return t;
}

export function daemonPassword(ctx: Ctx, task: TaskRow): string {
  return ctx.sealer.open(task.daemon_password_sealed, daemonAad(task.id));
}
