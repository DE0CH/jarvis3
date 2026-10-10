// Channels: each task's outbox. The agent posts results and reports for its owner (Jarvis 1's
// per-session Discord channel, inside the app instead). A post is stored with its task, gives the
// owner a `channel_post` notice, and is listed per task and across the owner's tasks. Reading a
// channel (its owner) marks its posts and their notices read; an admin can read any channel without
// changing what the owner has read.
import type { ChannelPostView, ChannelView, SessionPostRequest } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice } from "./ctx.ts";
import type { TaskRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { httpError } from "./errors.ts";

export interface PostRow {
  id: string;
  task_id: string;
  user_id: string;
  title: string;
  text: string;
  created_at: number;
  read_at: number | null;
}

const MAX_TEXT = 20000;
const MAX_TITLE = 120;
/** Posts one task may make per hour. */
const POSTS_PER_HOUR = 60;

export const postView = (p: PostRow): ChannelPostView => ({
  id: p.id,
  taskId: p.task_id,
  userId: p.user_id,
  title: p.title,
  text: p.text,
  createdAt: iso(p.created_at),
  read: p.read_at !== null,
});

export function post(ctx: Ctx, task: TaskRow, body: SessionPostRequest): PostRow {
  const text = body?.text;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) throw httpError("bad_request", `text must be 1..${MAX_TEXT} characters`);
  if (body.title !== undefined && body.title !== null && (typeof body.title !== "string" || body.title.length > MAX_TITLE)) throw httpError("bad_request", `title must be ≤ ${MAX_TITLE} characters`);
  const now = ctx.clock.now();
  const recent = (ctx.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE task_id = ? AND created_at > ?").get(task.id, now - 3600_000) as { n: number }).n;
  if (recent >= POSTS_PER_HOUR) throw httpError("too_many_requests", `a task may post at most ${POSTS_PER_HOUR} times an hour`);
  const title = (typeof body.title === "string" && body.title.trim()) || text.trim().split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 80);
  const id = randomId(8);
  ctx.db.prepare("INSERT INTO posts(id, task_id, user_id, title, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, task.id, task.user_id, title, text, now);
  addNotice(ctx, task.user_id, "channel_post", `${task.title}: ${title}`, task.id);
  return ctx.db.prepare("SELECT * FROM posts WHERE id = ?").get(id) as unknown as PostRow;
}

export function postsOf(ctx: Ctx, taskId: string): PostRow[] {
  return ctx.db.prepare("SELECT * FROM posts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200").all(taskId) as unknown as PostRow[];
}

export function unreadPosts(ctx: Ctx, userId: string): number {
  return (ctx.db.prepare("SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND read_at IS NULL").get(userId) as { n: number }).n;
}

/** The owner read the channel: its posts and their notices are read. */
export function markRead(ctx: Ctx, task: TaskRow, readerId: string): number {
  if (readerId === task.user_id) {
    const now = ctx.clock.now();
    ctx.db.prepare("UPDATE posts SET read_at = ? WHERE task_id = ? AND read_at IS NULL").run(now, task.id);
    ctx.db.prepare("UPDATE notices SET read_at = ? WHERE user_id = ? AND task_id = ? AND kind = 'channel_post' AND read_at IS NULL").run(now, task.user_id, task.id);
  }
  return unreadPosts(ctx, readerId);
}

/** One entry per task with posts, the most recently active first. `userId` null = everyone's (admin). */
export function channels(ctx: Ctx, userId: string | null): ChannelView[] {
  const rows = ctx.db
    .prepare(
      `SELECT p.task_id, COUNT(*) AS n, SUM(p.read_at IS NULL) AS unread, MAX(p.created_at) AS last
       FROM posts p ${userId ? "WHERE p.user_id = ?" : ""} GROUP BY p.task_id ORDER BY last DESC LIMIT 200`,
    )
    .all(...(userId ? [userId] : [])) as { task_id: string; n: number; unread: number; last: number }[];
  const out: ChannelView[] = [];
  for (const r of rows) {
    const t = ctx.db.prepare("SELECT * FROM tasks WHERE id = ?").get(r.task_id) as TaskRow | undefined;
    const last = ctx.db.prepare("SELECT * FROM posts WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(r.task_id) as unknown as PostRow;
    if (!t) continue;
    out.push({ taskId: t.id, userId: t.user_id, taskTitle: t.title, taskState: t.state, scheduleId: t.schedule_id ?? null, posts: r.n, unread: r.unread, lastPost: postView(last) });
  }
  return out;
}
