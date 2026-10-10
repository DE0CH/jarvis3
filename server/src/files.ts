// The users' files (docs/API.md section 13): each user's own folder of files, kept in the bucket
// under files/<userId>/<object id> with the listing in SQLite. The app uploads, downloads, renames
// and deletes them; a session downloads its owner's files at boot (~/files) and saves new ones back
// with `jarvis-files save`. A path is only a name in the database, so a rename never touches the
// bucket, and a replaced file's old object is deleted only once the new one is recorded.
//
// Jarvis 1's content stores are the analogue (named folders on the Storage Box synced into
// ~/content/<store>/); here the folder is per user, and only the server holds storage credentials.
import { Transform } from "node:stream";
import type { IncomingMessage } from "node:http";
import type { FileLink, FileList, FileView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { filesConfig } from "./config.ts";
import { tx } from "./db.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { httpError } from "./errors.ts";

export interface FileRow {
  user_id: string;
  path: string;
  size: number;
  content_type: string;
  source: "user" | "session";
  task_id: string | null;
  object_key: string;
  created_at: number;
  updated_at: number;
}

/** At most this many files per user. */
export const MAX_FILES = 10_000;
/** Lifetime of a download link. */
export const LINK_SECONDS = 600;

/**
 * A file path: relative, "/"-separated, 1..512 characters, segments of 1..255 characters, no "."
 * or ".." segment, no control characters or backslashes. Leading/trailing slashes are dropped.
 */
export function filePath(raw: unknown): string {
  const p = String(raw ?? "").replace(/^\/+|\/+$/g, "");
  const segs = p.split("/");
  if (!p || p.length > 512 || /[\x00-\x1f\x7f\\]/.test(p) || segs.some((s) => !s || s === "." || s === ".." || s.length > 255)) {
    throw httpError("bad_request", "a file path is 1..512 characters of /-separated names (no '.', '..', control characters or backslashes)");
  }
  return p;
}

const TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The Content-Type to record: the uploader's (if it is a plain type), else a guess from the name. */
export function contentTypeFor(path: string, given: string | undefined): string {
  const g = String(given || "").split(";")[0]!.trim().toLowerCase();
  if (g && g !== "application/octet-stream" && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(g)) return g;
  return TYPES[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
}

export const baseName = (path: string): string => path.split("/").pop()!;

export function fileView(r: FileRow): FileView {
  return { path: r.path, size: r.size, contentType: r.content_type, updatedAt: iso(r.updated_at), source: r.source, taskId: r.task_id };
}

export function getFile(ctx: Ctx, userId: string, path: string): FileRow | null {
  return (ctx.db.prepare("SELECT * FROM files WHERE user_id = ? AND path = ?").get(userId, path) as FileRow | undefined) ?? null;
}

export function requireFile(ctx: Ctx, userId: string, path: string): FileRow {
  const f = getFile(ctx, userId, path);
  if (!f) throw httpError("not_found", "no such file");
  return f;
}

const usedBytes = (ctx: Ctx, userId: string): number =>
  Number((ctx.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE user_id = ?").get(userId) as { n: number }).n);

export function listFiles(ctx: Ctx, userId: string): FileList {
  const rows = ctx.db.prepare("SELECT * FROM files WHERE user_id = ? ORDER BY path").all(userId) as unknown as FileRow[];
  const fc = filesConfig(ctx.config);
  return { files: rows.map(fileView), usedBytes: usedBytes(ctx, userId), quotaBytes: fc.quotaBytes, maxFileBytes: fc.maxFileBytes };
}

/**
 * Store a file from a request body (raw bytes, Content-Length required). Returns the file and
 * whether it is new. Over the per-file limit or the quota: 413 `too_large`, before anything is read.
 */
export async function putFile(
  ctx: Ctx,
  userId: string,
  rawPath: string,
  req: IncomingMessage,
  o: { source: "user" | "session"; taskId: string | null },
): Promise<{ file: FileRow; created: boolean }> {
  const path = filePath(rawPath);
  const lengthHeader = req.headers["content-length"];
  if (lengthHeader === undefined || !/^\d+$/.test(String(lengthHeader))) throw httpError("bad_request", "a file upload needs a Content-Length");
  const length = Number(lengthHeader);
  const fc = filesConfig(ctx.config);
  if (length > fc.maxFileBytes) throw httpError("too_large", `the file is ${length} bytes; the limit is ${fc.maxFileBytes} bytes per file`);
  const fits = (): void => {
    const old = getFile(ctx, userId, path);
    if (!old && (ctx.db.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id = ?").get(userId) as { n: number }).n >= MAX_FILES) {
      throw httpError("too_large", `at most ${MAX_FILES} files per person`);
    }
    const after = usedBytes(ctx, userId) - (old?.size ?? 0) + length;
    if (after > fc.quotaBytes) throw httpError("too_large", `this would use ${after} of your ${fc.quotaBytes} bytes of storage`);
  };
  fits();
  for (const prefix of ancestors(path)) {
    if (getFile(ctx, userId, prefix)) throw httpError("conflict", `"${prefix}" is a file, not a folder`);
  }
  if ((ctx.db.prepare("SELECT 1 FROM files WHERE user_id = ? AND path LIKE ? ESCAPE '\\' LIMIT 1").get(userId, likePrefix(path)) as unknown) !== undefined) {
    throw httpError("conflict", `"${path}" is a folder`);
  }
  const key = `files/${userId}/${randomId(12)}`;
  const type = contentTypeFor(path, req.headers["content-type"]);
  let seen = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > length ? httpError("bad_request", "the body is longer than its Content-Length") : null, chunk);
    },
  });
  req.on("error", (e) => counter.destroy(e));
  req.on("aborted", () => counter.destroy(httpError("bad_request", "the upload was cut off")));
  try {
    await ctx.blobs.putStream(key, req.pipe(counter), length, type);
  } catch (e) {
    await ctx.blobs.delete(key).catch(() => {});
    throw e;
  }
  if (seen !== length) {
    await ctx.blobs.delete(key).catch(() => {});
    throw httpError("bad_request", `the upload was cut off (${seen} of ${length} bytes)`);
  }
  let old: FileRow | null = null;
  try {
    tx(ctx.db, () => {
      fits(); // again: another upload may have finished meanwhile
      old = getFile(ctx, userId, path);
      const now = ctx.clock.now();
      ctx.db
        .prepare(
          `INSERT INTO files(user_id, path, size, content_type, source, task_id, object_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, path) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, source = excluded.source,
             task_id = excluded.task_id, object_key = excluded.object_key, updated_at = excluded.updated_at`,
        )
        .run(userId, path, length, type, o.source, o.taskId, key, now, now);
    });
  } catch (e) {
    await ctx.blobs.delete(key).catch(() => {});
    throw e;
  }
  const replaced = old as FileRow | null;
  if (replaced) await ctx.blobs.delete(replaced.object_key).catch((e: Error) => ctx.log("old file object not deleted", { key: replaced.object_key, error: e.message }));
  return { file: getFile(ctx, userId, path)!, created: !replaced };
}

/** "a/b/c.txt" -> ["a", "a/b"] */
function ancestors(path: string): string[] {
  const segs = path.split("/");
  return segs.slice(0, -1).map((_, i) => segs.slice(0, i + 1).join("/"));
}
const likePrefix = (path: string): string => path.replace(/[\\%_]/g, (c) => "\\" + c) + "/%";

export async function fileLink(ctx: Ctx, f: FileRow): Promise<FileLink> {
  const url = await ctx.blobs.presignGet(f.object_key, LINK_SECONDS, { downloadName: baseName(f.path) });
  return { url, expiresAt: iso(ctx.clock.now() + LINK_SECONDS * 1000) };
}

export async function deleteFile(ctx: Ctx, userId: string, rawPath: string): Promise<void> {
  const f = requireFile(ctx, userId, filePath(rawPath));
  ctx.db.prepare("DELETE FROM files WHERE user_id = ? AND path = ?").run(userId, f.path);
  await ctx.blobs.delete(f.object_key).catch((e: Error) => ctx.log("file object not deleted", { key: f.object_key, error: e.message }));
}

export function moveFile(ctx: Ctx, userId: string, body: { from?: unknown; to?: unknown }): FileRow {
  const from = filePath(body?.from);
  const to = filePath(body?.to);
  return tx(ctx.db, () => {
    const f = requireFile(ctx, userId, from);
    if (from === to) return f;
    if (getFile(ctx, userId, to)) throw httpError("conflict", `"${to}" already exists`);
    for (const prefix of ancestors(to)) if (getFile(ctx, userId, prefix)) throw httpError("conflict", `"${prefix}" is a file, not a folder`);
    if (ctx.db.prepare("SELECT 1 FROM files WHERE user_id = ? AND path LIKE ? ESCAPE '\\' LIMIT 1").get(userId, likePrefix(to)) !== undefined) {
      throw httpError("conflict", `"${to}" is a folder`);
    }
    ctx.db.prepare("UPDATE files SET path = ?, updated_at = ? WHERE user_id = ? AND path = ?").run(to, ctx.clock.now(), userId, from);
    return getFile(ctx, userId, to)!;
  });
}

/** The first prompt's attachments: paths in the user's files, at most 20, each must exist. */
export function checkAttachments(ctx: Ctx, userId: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw httpError("bad_request", "attachments must be a list of at most 20 file paths");
  const out: string[] = [];
  for (const r of raw) {
    const p = filePath(r);
    if (!getFile(ctx, userId, p)) throw httpError("bad_request", `attachment "${p}" is not in your files`);
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
