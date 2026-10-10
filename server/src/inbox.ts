// A task's inbox: messages the server has for the task's agent (wakeups). The session long-polls
// GET /api/session/inbox, hands each message to the task's main agent as a new user message once
// the agent is not mid-turn, then acks it. Never typed into anything, never an answer to a pending
// question (lessons from Jarvis 1, lessons/52). Delivery is at least once: the session keeps the ids
// it delivered and acks a repeat without delivering it again.
import type { InboxMessage } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { httpError } from "./errors.ts";

interface InboxRow {
  id: string;
  task_id: string;
  source: "wakeup";
  source_id: string;
  text: string;
  created_at: number;
  delivered_at: number | null;
}

const view = (r: InboxRow): InboxMessage => ({ id: r.id, source: r.source, sourceId: r.source_id, text: r.text, createdAt: iso(r.created_at) });

export function enqueue(ctx: Ctx, taskId: string, source: "wakeup", sourceId: string, text: string): string {
  const id = randomId(8);
  ctx.db.prepare("INSERT INTO inbox(id, task_id, source, source_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, taskId, source, sourceId, text, ctx.clock.now());
  ctx.inboxBus.emit("message", taskId);
  return id;
}

export function pending(ctx: Ctx, taskId: string): InboxMessage[] {
  const rows = ctx.db.prepare("SELECT * FROM inbox WHERE task_id = ? AND delivered_at IS NULL ORDER BY created_at, rowid LIMIT 20").all(taskId) as unknown as InboxRow[];
  return rows.map(view);
}

export function hasPending(ctx: Ctx, taskId: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM inbox WHERE task_id = ? AND delivered_at IS NULL LIMIT 1").get(taskId);
}

/** Tasks with messages not yet delivered. */
export function tasksWithPending(ctx: Ctx): string[] {
  return (ctx.db.prepare("SELECT DISTINCT task_id FROM inbox WHERE delivered_at IS NULL").all() as { task_id: string }[]).map((r) => r.task_id);
}

/** Long poll: the pending messages, waiting up to `seconds` for one to arrive. */
export function waitPending(ctx: Ctx, taskId: string, seconds: number): Promise<InboxMessage[]> {
  const now = pending(ctx, taskId);
  if (now.length || seconds <= 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      ctx.inboxBus.off("message", onMsg);
      resolve(pending(ctx, taskId));
    };
    const onMsg = (t: string) => {
      if (t === taskId) done();
    };
    const timer = setTimeout(done, seconds * 1000);
    ctx.inboxBus.on("message", onMsg);
  });
}

export function ack(ctx: Ctx, taskId: string, id: string): void {
  const r = ctx.db.prepare("SELECT * FROM inbox WHERE id = ? AND task_id = ?").get(id, taskId) as InboxRow | undefined;
  if (!r) throw httpError("not_found", "no such message");
  if (r.delivered_at === null) ctx.db.prepare("UPDATE inbox SET delivered_at = ? WHERE id = ?").run(ctx.clock.now(), id);
}
