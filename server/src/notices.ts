// In-app notices (caps, budget, failed tasks, offboarding) and their read marks.
import type { MarkNoticesReadRequest, NoticeView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { iso } from "./clock.ts";
import { httpError } from "./errors.ts";

interface NoticeRow {
  id: string;
  kind: NoticeView["kind"];
  text: string;
  task_id: string | null;
  approval_id: string | null;
  created_at: number;
  read_at: number | null;
}

export function listNotices(ctx: Ctx, userId: string): NoticeView[] {
  const rows = ctx.db.prepare("SELECT * FROM notices WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").all(userId) as unknown as NoticeRow[];
  return rows.map((n) => ({ id: n.id, kind: n.kind, text: n.text, taskId: n.task_id, approvalId: n.approval_id, createdAt: iso(n.created_at), read: n.read_at !== null }));
}

export function unreadCount(ctx: Ctx, userId: string): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM notices WHERE user_id = ? AND read_at IS NULL").get(userId) as { n: number }).n;
}

/** Mark the user's notices read: all, or those created up to (and including) notice `upTo`. */
export function markRead(ctx: Ctx, userId: string, body: MarkNoticesReadRequest | undefined): number {
  const now = ctx.clock.now();
  const upTo = body?.upTo;
  if (upTo === undefined) {
    ctx.db.prepare("UPDATE notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(now, userId);
  } else {
    if (typeof upTo !== "string") throw httpError("bad_request", "upTo must be a notice id");
    const n = ctx.db.prepare("SELECT rowid AS r, created_at FROM notices WHERE id = ? AND user_id = ?").get(upTo, userId) as { r: number; created_at: number } | undefined;
    if (!n) throw httpError("not_found", "no such notice");
    ctx.db
      .prepare("UPDATE notices SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND (created_at < ? OR (created_at = ? AND rowid <= ?))")
      .run(now, userId, n.created_at, n.created_at, n.r);
  }
  return unreadCount(ctx, userId);
}
