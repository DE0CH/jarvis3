// HTTP routes and WebSocket upgrades. Every handler names its target to authorize() first;
// docs/API.md is the human-readable version of this table.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type * as A from "./api-types.ts";
import type { WebApp } from "./web.ts";
import type { Ctx } from "./ctx.ts";
import { authorize, resolvePrincipal, userOf, type Principal, type ResolveDeps, type Target } from "./auth.ts";
import { asHttpError, httpError, HttpError } from "./errors.ts";
import { MAX_RELAY_BODY, pickClientProtocol, relayRequestHeaders } from "./channel.ts";
import * as tasks from "./tasks.ts";
import * as users from "./users.ts";
import * as layers from "./layers.ts";
import * as notices from "./notices.ts";
import { budgetView } from "./spend.ts";
import { iso } from "./clock.ts";
import * as suggestions from "./suggestions.ts";
import { capTick } from "./ticks.ts";
import { archiveKey } from "./tasks.ts";
import * as approvals from "./approvals.ts";
import * as passkeys from "./passkeys.ts";
import { approvalPage, PAGE_HEADERS, passkeysPage, safeReturn } from "./pages.ts";
import * as tools from "./tools/index.ts";
import { checkRelay, parseTarget, runTunnel } from "./tools/relay.ts";
import * as files from "./files.ts";
import * as transcripts from "./transcripts.ts";
import * as schedules from "./schedules.ts";
import * as wakeups from "./wakeups.ts";
import * as inbox from "./inbox.ts";
import * as posts from "./posts.ts";
import { validTimeZone } from "./cron.ts";

export const VERSION = "0.1.0";

/** Lifetime of an archive download link (GET /api/tasks/:id/archive). */
const ARCHIVE_LINK_SECONDS = 600;

interface Req {
  req: IncomingMessage;
  url: URL;
  params: Record<string, string>;
  principal: Principal | null;
  body: () => Promise<unknown>;
}

type Result = { status?: number; json?: unknown; redirect?: string; raw?: { type: string; body: Uint8Array; headers?: Record<string, string> } };
type Handler = (r: Req) => Promise<Result> | Result;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  /** false: no Access identity needed (health only). */
  auth: boolean;
  handler: Handler;
}

export type Routes = Route[];

const ok = (json: unknown, status = 200): Result => ({ json, status });

/** Resolve ":id" = "me" to the caller. */
function userIdParam(r: Req): string {
  const id = r.params.id!;
  if (id === "me") return userOf(r.principal).user.id;
  return id;
}

/** Authorise access to user :id's own things (owner or admin), uniform 404 otherwise. */
function ownedUser(ctx: Ctx, r: Req): { id: string } {
  authorize(r.principal, { kind: "member" });
  const id = userIdParam(r);
  authorize(r.principal, { kind: "owned", ownerId: id, what: "user" });
  users.requireUser(ctx, id);
  return { id };
}

function ownedTask(ctx: Ctx, r: Req) {
  authorize(r.principal, { kind: "member" });
  const t = tasks.getTask(ctx, r.params.id!);
  // a missing task and someone else's task are the same 404
  authorize(r.principal, { kind: "owned", ownerId: t ? t.user_id : "\0none", what: "task" });
  if (!t) throw httpError("not_found", "no such task");
  return t;
}

function sessionTask(ctx: Ctx, r: Req) {
  authorize(r.principal, { kind: "session" });
  const p = r.principal as Extract<Principal, { kind: "session" }>;
  return tasks.getTask(ctx, p.task.id)!;
}

function searchLimit(sp: URLSearchParams): number {
  const raw = sp.get("limit");
  if (raw === null || raw === "") return 30;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) throw httpError("bad_request", "limit must be 1..100");
  return n;
}

function ownedSchedule(ctx: Ctx, r: Req) {
  authorize(r.principal, { kind: "member" });
  const s = schedules.getSchedule(ctx, r.params.id!);
  authorize(r.principal, { kind: "owned", ownerId: s ? s.user_id : "\0none", what: "schedule" });
  if (!s) throw httpError("not_found", "no such schedule");
  return s;
}

function ownedWakeup(ctx: Ctx, r: Req) {
  authorize(r.principal, { kind: "member" });
  const w = wakeups.getWakeup(ctx, r.params.id!);
  authorize(r.principal, { kind: "owned", ownerId: w ? w.user_id : "\0none", what: "wakeup" });
  if (!w) throw httpError("not_found", "no such wakeup");
  return w;
}

/**
 * Whose things a list route shows: the caller's own; `?userId=U` (U or an admin); `?all=1` (admins,
 * everyone's, returned as null).
 */
function listScope(r: Req, what: string): string | null {
  authorize(r.principal, { kind: "member" });
  const { user } = userOf(r.principal);
  if (r.url.searchParams.get("all") === "1") {
    authorize(r.principal, { kind: "admin", what });
    return null;
  }
  const forUser = r.url.searchParams.get("userId");
  if (forUser) {
    authorize(r.principal, { kind: "owned", ownerId: forUser, what: "user" });
    return forUser;
  }
  return user.id;
}

export function defineRoutes(ctx: Ctx): Routes {
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler, o: { auth?: boolean } = {}): void => {
    const keys: string[] = [];
    // ":name" is one segment; a trailing "*" is the rest of the path (a file path), as `path`
    let src = path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), "([^/]+)"));
    if (src.endsWith("/*")) {
      keys.push("path");
      src = src.slice(0, -1) + "(.+)";
    }
    const re = new RegExp("^" + src + "$");
    routes.push({ method, re, keys, auth: o.auth ?? true, handler });
  };

  route("GET", "/api/health", () => ok({ ok: true, version: VERSION } satisfies A.Health), { auth: false });

  // ---- identity -------------------------------------------------------------------------------
  route("GET", "/api/me", (r) => {
    authorize(r.principal, { kind: "member" });
    const { user } = userOf(r.principal);
    return ok({
      ...users.userDetail(ctx, user),
      unreadNotices: notices.unreadCount(ctx, user.id),
      features: { suggestions: suggestions.suggestionsEnabled(ctx), ...tools.featureFlag(ctx), files: true, search: true, schedules: true },
      pendingApprovals: approvals.pendingCount(ctx, userOf(r.principal)),
      isOwner: approvals.isOwner(ctx, user),
      unreadPosts: posts.unreadPosts(ctx, user.id),
    } satisfies A.MeView);
  });

  route("GET", "/api/devices/pair", async (r) => {
    const state = r.url.searchParams.get("state") || "";
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(state)) throw httpError("bad_request", "missing or malformed state");
    const back = (p: Record<string, string>) => ({ redirect: `${ctx.config.devices.appScheme}://paired?` + new URLSearchParams({ state, ...p }).toString() });
    try {
      authorize(r.principal, { kind: "identity-login" });
      const res = await users.pairDevice(ctx, userOf(r.principal).user, {
        name: r.url.searchParams.get("name") || "",
        model: r.url.searchParams.get("model") || "",
      });
      return back({ id: res.id, clientId: res.clientId, clientSecret: res.clientSecret } satisfies Omit<A.PairResult, "state">);
    } catch (e) {
      const he = asHttpError(e);
      return back({ error: he.message, status: String(he.status) });
    }
  });

  route("GET", "/api/devices", (r) => {
    authorize(r.principal, { kind: "member" });
    const { user, isAdmin } = userOf(r.principal);
    const all = r.url.searchParams.get("all") === "1";
    if (all) authorize(r.principal, { kind: "admin", what: "device list" });
    return ok({ devices: users.listDevices(ctx, all && isAdmin ? null : user.id).map(users.deviceView) } satisfies A.DeviceList);
  });

  route("DELETE", "/api/devices/:id", async (r) => {
    authorize(r.principal, { kind: "member" });
    const d = ctx.db.prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").get(r.params.id!) as { user_id: string } | undefined;
    authorize(r.principal, { kind: "owned", ownerId: d ? d.user_id : "\0none", what: "device" });
    await users.revokeDevice(ctx, users.requireDevice(ctx, r.params.id!));
    return ok({ ok: true });
  });

  // ---- models ----------------------------------------------------------------------------------
  route("GET", "/api/models", (r) => {
    authorize(r.principal, { kind: "member" });
    return ok({ models: ctx.config.models.map((m) => ({ id: m.id, label: m.label })), default: ctx.config.defaultModel } satisfies A.ModelList);
  });

  // ---- tasks -----------------------------------------------------------------------------------
  route("POST", "/api/tasks", async (r) => {
    authorize(r.principal, { kind: "member" });
    const t = await tasks.createTask(ctx, userOf(r.principal).user, (await r.body()) as A.CreateTaskRequest);
    return ok(tasks.taskView(ctx, t) satisfies A.TaskView, 201);
  });

  route("GET", "/api/tasks", (r) => {
    authorize(r.principal, { kind: "member" });
    const { user } = userOf(r.principal);
    const all = r.url.searchParams.get("all") === "1";
    const forUser = r.url.searchParams.get("userId");
    let userId: string | undefined = user.id;
    if (all) {
      authorize(r.principal, { kind: "admin", what: "task list" });
      userId = undefined;
    } else if (forUser) {
      authorize(r.principal, { kind: "owned", ownerId: forUser, what: "user" });
      userId = forUser;
    }
    return ok({ tasks: tasks.listTasks(ctx, userId === undefined ? {} : { userId }).map((t) => tasks.taskView(ctx, t)) } satisfies A.TaskList);
  });

  route("GET", "/api/tasks/:id", (r) => ok(tasks.taskView(ctx, ownedTask(ctx, r)) satisfies A.TaskView));

  route("POST", "/api/tasks/:id/pause", (r) => {
    const t = ownedTask(ctx, r);
    tasks.pauseTask(ctx, t, "user");
    return ok(tasks.taskView(ctx, tasks.getTask(ctx, t.id)!) satisfies A.TaskView, 202);
  });

  route("POST", "/api/tasks/:id/resume", (r) => {
    const t = ownedTask(ctx, r);
    tasks.resumeTask(ctx, t);
    return ok(tasks.taskView(ctx, tasks.getTask(ctx, t.id)!) satisfies A.TaskView, 202);
  });

  route("GET", "/api/tasks/:id/archive", async (r) => {
    const t = ownedTask(ctx, r);
    const key = archiveKey(t.user_id, t.id);
    if (t.state !== "archived" || !(await ctx.blobs.exists(key))) throw httpError("conflict", "this task has no archived state");
    const url = await ctx.blobs.presignGet(key, ARCHIVE_LINK_SECONDS);
    // ?link=1: the link as JSON, for a client that can't follow a redirect with its own headers (iOS)
    if (r.url.searchParams.get("link") === "1") return ok({ url, expiresAt: iso(ctx.clock.now() + ARCHIVE_LINK_SECONDS * 1000) } satisfies A.ArchiveLink);
    return { redirect: url };
  });

  route("DELETE", "/api/tasks/:id", (r) => {
    const t = ownedTask(ctx, r);
    tasks.destroyTask(ctx, t, { force: r.url.searchParams.get("force") === "1" });
    return ok(tasks.taskView(ctx, tasks.getTask(ctx, t.id)!) satisfies A.TaskView, 202);
  });

  // ---- users (admin) and limits ------------------------------------------------------------------
  route("GET", "/api/users", (r) => {
    authorize(r.principal, { kind: "admin", what: "user list" });
    return ok({ users: users.listUsers(ctx).map((u) => users.userDetail(ctx, u)) } satisfies A.UserList);
  });

  route("GET", "/api/users/:id", (r) => {
    const { id } = ownedUser(ctx, r);
    return ok(users.userDetail(ctx, users.requireUser(ctx, id)) satisfies A.UserDetail);
  });

  route("PATCH", "/api/users/:id/limits", async (r) => {
    authorize(r.principal, { kind: "admin", what: "user" });
    const u = users.requireUser(ctx, userIdParam(r));
    const updated = await users.setLimits(ctx, u, (await r.body()) as A.SetLimitsRequest);
    capTick(ctx); // a lowered cap pauses at once, not at the next minute's tick
    return ok(users.userDetail(ctx, updated) satisfies A.UserDetail);
  });

  // ---- personal layer --------------------------------------------------------------------------
  route("GET", "/api/users/:id/layer", (r) => ok(layers.personalView(ctx, ownedUser(ctx, r).id) satisfies A.PersonalLayerView));

  route("GET", "/api/users/:id/layers", async (r) => {
    const { id } = ownedUser(ctx, r);
    const u = users.requireUser(ctx, id);
    return ok((await layers.bundleFor(ctx, u.id, u.role)) satisfies A.LayerBundle);
  });

  route("PUT", "/api/users/:id/layer/instructions", async (r) => {
    const { id } = ownedUser(ctx, r);
    layers.setInstructions(ctx, id, ((await r.body()) as A.SetInstructionsRequest)?.text);
    return ok(layers.personalView(ctx, id) satisfies A.PersonalLayerView);
  });

  route("PUT", "/api/users/:id/layer/skills/:name", async (r) => {
    const { id } = ownedUser(ctx, r);
    layers.putSkill(ctx, id, r.params.name!, ((await r.body()) as A.PutSkillRequest)?.files);
    return ok(layers.personalView(ctx, id) satisfies A.PersonalLayerView);
  });

  route("DELETE", "/api/users/:id/layer/skills/:name", (r) => {
    const { id } = ownedUser(ctx, r);
    layers.deleteSkill(ctx, id, r.params.name!);
    return ok(layers.personalView(ctx, id) satisfies A.PersonalLayerView);
  });

  route("POST", "/api/users/:id/layer/notes", async (r) => {
    const { id } = ownedUser(ctx, r);
    const note = layers.addNote(ctx, id, ((await r.body()) as A.AddNoteRequest)?.text, "user", null);
    return ok(note satisfies A.PersonalNote, 201);
  });

  route("DELETE", "/api/users/:id/layer/notes/:noteId", (r) => {
    const { id } = ownedUser(ctx, r);
    layers.deleteNote(ctx, id, r.params.noteId!);
    return ok(layers.personalView(ctx, id) satisfies A.PersonalLayerView);
  });

  route("POST", "/api/users/:id/layer/reset", (r) => {
    const { id } = ownedUser(ctx, r);
    const version = layers.resetPersonal(ctx, id);
    return ok({ version, layer: layers.personalView(ctx, id) } satisfies A.ResetResult);
  });

  route("POST", "/api/users/:id/layer/undo", (r) => {
    const { id } = ownedUser(ctx, r);
    layers.undoPersonal(ctx, id);
    return ok(layers.personalView(ctx, id) satisfies A.PersonalLayerView);
  });

  route("POST", "/api/users/:id/layer/suggest", async (r) => {
    const { id } = ownedUser(ctx, r);
    const s = await suggestions.suggest(ctx, users.requireUser(ctx, id), userOf(r.principal).user, (await r.body()) as A.SuggestRequest);
    return ok(suggestions.suggestionView(ctx, s) satisfies A.SuggestionView, 201);
  });

  // ---- the user's files -------------------------------------------------------------------------
  route("GET", "/api/users/:id/files", (r) => ok(files.listFiles(ctx, ownedUser(ctx, r).id) satisfies A.FileList));

  route("POST", "/api/users/:id/files/move", async (r) => {
    const { id } = ownedUser(ctx, r);
    return ok(files.fileView(files.moveFile(ctx, id, (await r.body()) as A.MoveFileRequest)) satisfies A.FileView);
  });

  route("PUT", "/api/users/:id/files/*", async (r) => {
    const { id } = ownedUser(ctx, r);
    const { file, created } = await files.putFile(ctx, id, r.params.path!, r.req, { source: "user", taskId: null });
    return ok(files.fileView(file) satisfies A.FileView, created ? 201 : 200);
  });

  route("GET", "/api/users/:id/files/*", async (r) => {
    const { id } = ownedUser(ctx, r);
    const link = await files.fileLink(ctx, files.requireFile(ctx, id, files.filePath(r.params.path)));
    // ?link=1: the link as JSON, for a client that can't follow a redirect with its own headers (iOS)
    if (r.url.searchParams.get("link") === "1") return ok(link satisfies A.FileLink);
    return { redirect: link.url };
  });

  route("DELETE", "/api/users/:id/files/*", async (r) => {
    const { id } = ownedUser(ctx, r);
    await files.deleteFile(ctx, id, r.params.path!);
    return ok({ ok: true });
  });

  // ---- transcript search ---------------------------------------------------------------------------
  route("GET", "/api/search", (r) => {
    authorize(r.principal, { kind: "member" });
    const { user } = userOf(r.principal);
    const sp = r.url.searchParams;
    let userId: string | null = user.id;
    if (sp.get("all") === "1") {
      authorize(r.principal, { kind: "admin", what: "search" });
      userId = null;
    } else if (sp.get("userId")) {
      userId = sp.get("userId")!;
      authorize(r.principal, { kind: "owned", ownerId: userId, what: "user" });
    }
    const taskId = sp.get("taskId") || undefined;
    if (taskId) {
      ownedTask(ctx, { ...r, params: { id: taskId } });
      if (sp.get("all") !== "1" && !sp.get("userId")) userId = null; // the task check decided access
    }
    return ok(transcripts.search(ctx, sp.get("q"), { userId, ...(taskId ? { taskId } : {}), limit: searchLimit(sp) }) satisfies A.SearchResult);
  });

  route("GET", "/api/tasks/:id/transcript", (r) => {
    const t = ownedTask(ctx, r);
    return ok(transcripts.page(ctx, t, transcripts.pageQuery(r.url.searchParams)) satisfies A.TranscriptPage);
  });

  // ---- suggestions -------------------------------------------------------------------------------
  route("GET", "/api/suggestions", async (r) => {
    authorize(r.principal, { kind: "member" });
    const { user } = userOf(r.principal);
    let userId: string | null = user.id;
    if (r.url.searchParams.get("all") === "1") {
      authorize(r.principal, { kind: "admin", what: "suggestion list" });
      userId = null;
    } else if (r.url.searchParams.get("userId")) {
      userId = r.url.searchParams.get("userId")!;
      authorize(r.principal, { kind: "owned", ownerId: userId, what: "user" });
    }
    await suggestions.refreshSuggestions(ctx, suggestions.listSuggestions(ctx, userId));
    return ok({ suggestions: suggestions.listSuggestions(ctx, userId).map((s) => suggestions.suggestionView(ctx, s)) } satisfies A.SuggestionList);
  });

  // ---- notices ------------------------------------------------------------------------------------
  route("GET", "/api/notices", (r) => {
    authorize(r.principal, { kind: "member" });
    return ok({ notices: notices.listNotices(ctx, userOf(r.principal).user.id) } satisfies A.NoticeList);
  });

  route("POST", "/api/notices/read", async (r) => {
    authorize(r.principal, { kind: "member" });
    const unreadNotices = notices.markRead(ctx, userOf(r.principal).user.id, (await r.body()) as A.MarkNoticesReadRequest);
    return ok({ unreadNotices } satisfies A.MarkNoticesReadResult);
  });

  // ---- approvals ------------------------------------------------------------------------------------
  route("GET", "/api/approvals", (r) => {
    authorize(r.principal, { kind: "member" });
    const taskId = r.url.searchParams.get("taskId") || undefined;
    if (taskId) ownedTask(ctx, { ...r, params: { id: taskId } });
    const list = approvals.listApprovals(ctx, userOf(r.principal), { pending: r.url.searchParams.get("pending") === "1", ...(taskId ? { taskId } : {}) });
    return ok({ approvals: list } satisfies A.ApprovalList);
  });

  route("GET", "/api/approvals/:id", (r) => {
    authorize(r.principal, { kind: "member" });
    const v = userOf(r.principal);
    return ok(approvals.approvalView(ctx, approvals.visibleApproval(ctx, r.params.id!, v), v) satisfies A.ApprovalView);
  });

  route("POST", "/api/approvals/:id/decide", async (r) => {
    authorize(r.principal, { kind: "member" });
    const v = userOf(r.principal);
    const row = approvals.decide(ctx, v, r.params.id!, (await r.body()) as A.DecideRequest);
    return ok(approvals.approvalView(ctx, row, v) satisfies A.ApprovalView);
  });

  route("POST", "/api/approvals/:id/passkey/options", async (r) => {
    authorize(r.principal, { kind: "member" });
    const v = userOf(r.principal);
    passkeys.requireOwner(ctx, v.user);
    return ok((await passkeys.approvalOptions(ctx, v.user, approvals.visibleApproval(ctx, r.params.id!, v))) as unknown as A.PasskeyApprovalOptions);
  });

  route("POST", "/api/approvals/:id/passkey", async (r) => {
    authorize(r.principal, { kind: "member" });
    const v = userOf(r.principal);
    passkeys.requireOwner(ctx, v.user);
    const row = await passkeys.approveWithPasskey(ctx, v.user, approvals.visibleApproval(ctx, r.params.id!, v), (await r.body()) as { response?: never });
    return ok(approvals.approvalView(ctx, row, v) satisfies A.ApprovalView);
  });

  // ---- passkeys (the owner only; anyone else gets the admin-style 404) ---------------------------------
  route("GET", "/api/passkeys", (r) => {
    authorize(r.principal, { kind: "member" });
    const { user } = userOf(r.principal);
    passkeys.requireOwner(ctx, user);
    return ok({ passkeys: passkeys.listPasskeys(ctx, user.id).map(passkeys.passkeyView) } satisfies A.PasskeyList);
  });

  route("POST", "/api/passkeys/register/options", async (r) => {
    authorize(r.principal, { kind: "member" });
    passkeys.requireOwner(ctx, userOf(r.principal).user);
    // a passkey is added only on an identity login: a paired device's token can't add one
    authorize(r.principal, { kind: "identity-login" });
    return ok(await passkeys.registrationOptions(ctx, userOf(r.principal).user));
  });

  route("POST", "/api/passkeys/register", async (r) => {
    authorize(r.principal, { kind: "member" });
    passkeys.requireOwner(ctx, userOf(r.principal).user);
    authorize(r.principal, { kind: "identity-login" });
    const row = await passkeys.register(ctx, userOf(r.principal).user, (await r.body()) as { response?: never; name?: unknown });
    return ok(passkeys.passkeyView(row) satisfies A.PasskeyView, 201);
  });

  route("DELETE", "/api/passkeys/:id", (r) => {
    authorize(r.principal, { kind: "member" });
    const { user } = userOf(r.principal);
    passkeys.requireOwner(ctx, user);
    passkeys.deletePasskey(ctx, user, r.params.id!);
    return ok({ ok: true });
  });

  // ---- the passkey pages (HTML, pages.ts) --------------------------------------------------------------
  route("GET", "/api/pages/passkeys", (r) => {
    authorize(r.principal, { kind: "member" });
    const { user } = userOf(r.principal);
    passkeys.requireOwner(ctx, user);
    const body = passkeysPage(ctx, { email: user.email, ret: safeReturn(ctx, r.url.searchParams.get("return")), count: passkeys.listPasskeys(ctx, user.id).length });
    return { raw: { type: "text/html; charset=utf-8", body, headers: PAGE_HEADERS } };
  });

  route("GET", "/api/pages/approvals/:id", (r) => {
    authorize(r.principal, { kind: "member" });
    const v = userOf(r.principal);
    passkeys.requireOwner(ctx, v.user);
    const row = approvals.visibleApproval(ctx, r.params.id!, v);
    if (row.approver !== "owner") throw httpError("not_found", "no such approval");
    const body = approvalPage(ctx, {
      approval: approvals.approvalView(ctx, row, v),
      ret: safeReturn(ctx, r.url.searchParams.get("return")),
      hasPasskey: passkeys.listPasskeys(ctx, v.user.id).length > 0,
    });
    return { raw: { type: "text/html; charset=utf-8", body, headers: PAGE_HEADERS } };
  });

  // ---- scheduled tasks (section 15) ---------------------------------------------------------------
  route("GET", "/api/schedules", (r) => {
    const userId = listScope(r, "schedule list");
    return ok({ schedules: schedules.listSchedules(ctx, userId).map((x) => schedules.scheduleView(ctx, x)) } satisfies A.ScheduleList);
  });

  route("POST", "/api/schedules", async (r) => {
    authorize(r.principal, { kind: "member" });
    const s = schedules.createSchedule(ctx, userOf(r.principal).user, (await r.body()) as A.CreateScheduleRequest);
    return ok(schedules.scheduleView(ctx, s) satisfies A.ScheduleView, 201);
  });

  route("POST", "/api/schedules/preview", async (r) => {
    authorize(r.principal, { kind: "member" });
    return ok(schedules.preview(ctx, (await r.body()) as A.SchedulePreviewRequest) satisfies A.SchedulePreview);
  });

  route("GET", "/api/schedules/:id", (r) => ok(schedules.scheduleDetail(ctx, ownedSchedule(ctx, r)) satisfies A.ScheduleDetail));

  route("PATCH", "/api/schedules/:id", async (r) => {
    const s = ownedSchedule(ctx, r);
    return ok(schedules.scheduleView(ctx, schedules.updateSchedule(ctx, s, (await r.body()) as A.UpdateScheduleRequest)) satisfies A.ScheduleView);
  });

  route("DELETE", "/api/schedules/:id", (r) => {
    schedules.deleteSchedule(ctx, ownedSchedule(ctx, r));
    return ok({ ok: true });
  });

  route("POST", "/api/schedules/:id/run", async (r) => {
    const s = ownedSchedule(ctx, r);
    const res = await schedules.runNow(ctx, s);
    return ok({ run: res.run, task: res.task ? tasks.taskView(ctx, res.task) : null } satisfies A.ScheduleRunNowResult, res.task ? 201 : 200);
  });

  // ---- wakeups (section 15) ---------------------------------------------------------------------------
  route("GET", "/api/wakeups", (r) => {
    const taskId = r.url.searchParams.get("taskId");
    if (taskId) {
      ownedTask(ctx, { ...r, params: { id: taskId } });
      return ok({ wakeups: wakeups.listWakeups(ctx, { taskId }).map(wakeups.wakeupView) } satisfies A.WakeupList);
    }
    const userId = listScope(r, "wakeup list");
    return ok({ wakeups: wakeups.listWakeups(ctx, { userId }).map(wakeups.wakeupView) } satisfies A.WakeupList);
  });

  // The owner wakes their own task at a time. Owner only: an admin's wakeup would spend the owner's
  // machine hours and speak into their conversation, so for anyone else the task is a uniform 404.
  route("POST", "/api/tasks/:id/wakeups", async (r) => {
    const t = ownedTask(ctx, r);
    if (userOf(r.principal).user.id !== t.user_id) throw httpError("not_found", "no such task");
    return ok(wakeups.wakeupView(wakeups.armFromOwner(ctx, t, (await r.body()) as A.ArmWakeupRequest)) satisfies A.WakeupView, 201);
  });

  route("DELETE", "/api/wakeups/:id", (r) => {
    const w = ownedWakeup(ctx, r);
    const by = userOf(r.principal).user;
    return ok(wakeups.wakeupView(wakeups.cancelWakeup(ctx, w, `cancelled by ${by.id === w.user_id ? "the owner" : "an admin"}`)) satisfies A.WakeupView);
  });

  // ---- channels (section 15) ---------------------------------------------------------------------------
  route("GET", "/api/channels", (r) => {
    const userId = listScope(r, "channel list");
    return ok({ channels: posts.channels(ctx, userId) } satisfies A.ChannelList);
  });

  route("GET", "/api/tasks/:id/posts", (r) => ok({ posts: posts.postsOf(ctx, ownedTask(ctx, r).id).map(posts.postView) } satisfies A.ChannelPostList));

  route("POST", "/api/tasks/:id/posts/read", (r) => {
    const t = ownedTask(ctx, r);
    return ok({ unreadPosts: posts.markRead(ctx, t, userOf(r.principal).user.id) } satisfies A.MarkPostsReadResult);
  });

  // ---- admin ----------------------------------------------------------------------------------------
  route("GET", "/api/admin/budget", (r) => {
    authorize(r.principal, { kind: "admin", what: "budget" });
    return ok(budgetView(ctx) satisfies A.BudgetView);
  });

  route("GET", "/api/admin/tools", (r) => {
    authorize(r.principal, { kind: "admin", what: "route" });
    return ok(tools.adminToolsView(ctx) satisfies A.ToolsAdminView);
  });

  route("POST", "/api/admin/directory/sync", async (r) => {
    authorize(r.principal, { kind: "admin", what: "directory" });
    return ok((await users.syncDirectory(ctx)) satisfies A.SyncResult);
  });

  // ---- session-facing (session token) ---------------------------------------------------------------
  route("GET", "/api/session/bundle", async (r) => {
    const t = sessionTask(ctx, r);
    const owner = users.requireUser(ctx, t.user_id);
    return ok((await layers.bundleFor(ctx, owner.id, owner.role)) satisfies A.LayerBundle);
  });

  route("GET", "/api/session/org-env.tar", async (r) => {
    sessionTask(ctx, r);
    return { raw: { type: "application/x-tar", body: await ctx.orgEnv.archive() } };
  });

  route("POST", "/api/session/notes", async (r) => {
    const t = sessionTask(ctx, r);
    const note = layers.addNote(ctx, t.user_id, ((await r.body()) as A.AddNoteRequest)?.text, "session", t.id);
    return ok(note satisfies A.PersonalNote, 201);
  });

  route("GET", "/api/session/actions", (r) => {
    const t = sessionTask(ctx, r);
    return ok({ actions: approvals.catalogue(ctx, t, users.requireUser(ctx, t.user_id)) } satisfies A.ActionCatalogue);
  });

  route("POST", "/api/session/approvals", async (r) => {
    const t = sessionTask(ctx, r);
    const row = await approvals.requestFromSession(ctx, t, (await r.body()) as A.SessionApprovalRequest);
    return ok(approvals.approvalView(ctx, row, null) satisfies A.ApprovalView, 201);
  });

  route("GET", "/api/session/approvals/:id", async (r) => {
    const t = sessionTask(ctx, r);
    const row = approvals.getApproval(ctx, r.params.id!);
    if (!row || row.task_id !== t.id) throw httpError("not_found", "no such approval");
    const wait = Math.max(0, Math.min(55, Number(r.url.searchParams.get("wait") || 0) || 0));
    return ok(approvals.approvalView(ctx, await approvals.waitSettled(ctx, row.id, wait), null) satisfies A.ApprovalView);
  });

  // Tier 0 tools (docs/TOOLS.md): metered on the server with the organisation's keys
  route("GET", "/api/session/tools", (r) => ok(tools.sessionToolsView(ctx, sessionTask(ctx, r)) satisfies A.SessionToolsView));
  route("POST", "/api/session/tools/search", async (r) => {
    const t = sessionTask(ctx, r);
    return ok((await tools.webSearch(ctx, t, await r.body())) satisfies A.WebSearchResponse);
  });
  route("POST", "/api/session/tools/fetch", async (r) => {
    const t = sessionTask(ctx, r);
    return ok((await tools.webFetch(ctx, t, await r.body())) satisfies A.WebFetchResponse);
  });

  route("GET", "/api/session/files", (r) => ok(files.listFiles(ctx, sessionTask(ctx, r).user_id) satisfies A.FileList));

  route("GET", "/api/session/files/*", async (r) => {
    const t = sessionTask(ctx, r);
    // always JSON: a redirect would carry the session's headers (the gate secret) to the bucket
    return ok((await files.fileLink(ctx, files.requireFile(ctx, t.user_id, files.filePath(r.params.path)))) satisfies A.FileLink);
  });

  route("PUT", "/api/session/files/*", async (r) => {
    const t = sessionTask(ctx, r);
    const { file, created } = await files.putFile(ctx, t.user_id, r.params.path!, r.req, { source: "session", taskId: t.id });
    return ok(files.fileView(file) satisfies A.FileView, created ? 201 : 200);
  });

  route("GET", "/api/session/transcript", (r) => ok(transcripts.cursors(ctx, sessionTask(ctx, r).id) satisfies A.SessionTranscriptCursors));

  route("POST", "/api/session/transcript", async (r) => {
    const t = sessionTask(ctx, r);
    return ok(transcripts.ingest(ctx, t, (await r.body()) as A.SessionTranscriptRequest) satisfies A.SessionTranscriptCursors);
  });

  route("GET", "/api/session/search", (r) => {
    const t = sessionTask(ctx, r);
    return ok(transcripts.search(ctx, r.url.searchParams.get("q"), { userId: t.user_id, limit: searchLimit(r.url.searchParams) }) satisfies A.SearchResult);
  });

  route("GET", "/api/session/tasks/:id/transcript", (r) => {
    const t = sessionTask(ctx, r);
    const other = tasks.getTask(ctx, r.params.id!);
    // the owner's own tasks only, like the search that found it
    if (!other || other.user_id !== t.user_id) throw httpError("not_found", "no such task");
    return ok(transcripts.page(ctx, other, transcripts.pageQuery(r.url.searchParams)) satisfies A.TranscriptPage);
  });

  route("POST", "/api/session/status", async (r) => {
    const t = sessionTask(ctx, r);
    return ok(tasks.reportStatus(ctx, t, (await r.body()) as A.SessionStatusRequest) satisfies A.TaskView);
  });

  route("GET", "/api/session/wakeups", (r) => {
    const t = sessionTask(ctx, r);
    return ok({ wakeups: wakeups.listWakeups(ctx, { taskId: t.id }).map(wakeups.wakeupView) } satisfies A.WakeupList);
  });

  route("POST", "/api/session/wakeups", async (r) => {
    const t = sessionTask(ctx, r);
    return ok(wakeups.wakeupView(wakeups.armFromSession(ctx, t, (await r.body()) as A.SessionWakeupRequest)) satisfies A.WakeupView, 201);
  });

  route("DELETE", "/api/session/wakeups/:name", (r) => {
    const t = sessionTask(ctx, r);
    return ok(wakeups.wakeupView(wakeups.cancelWakeup(ctx, wakeups.armedByName(ctx, t.id, r.params.name!), "cancelled by the task")) satisfies A.WakeupView);
  });

  route("GET", "/api/session/inbox", async (r) => {
    const t = sessionTask(ctx, r);
    const wait = Math.max(0, Math.min(55, Number(r.url.searchParams.get("wait") || 0) || 0));
    return ok({ messages: await inbox.waitPending(ctx, t.id, wait) } satisfies A.InboxList);
  });

  route("POST", "/api/session/inbox/:id/ack", (r) => {
    const t = sessionTask(ctx, r);
    inbox.ack(ctx, t.id, r.params.id!);
    return ok({ ok: true });
  });

  route("POST", "/api/session/posts", async (r) => {
    const t = sessionTask(ctx, r);
    return ok(posts.postView(posts.post(ctx, t, (await r.body()) as A.SessionPostRequest)) satisfies A.ChannelPostView, 201);
  });

  return routes;
}

/**
 * Cross-site request / WebSocket hijacking guard: a browser attaches the Access cookie to requests
 * any site starts, so a state-changing request or a WebSocket upgrade that carries an Origin must
 * come from the instance's own origin. Native apps and sessions send no Origin.
 */
function checkOrigin(ctx: Ctx, req: IncomingMessage): void {
  const origin = req.headers.origin;
  if (origin && origin !== ctx.config.publicUrl) throw httpError("forbidden", "cross-origin request refused");
}

/**
 * The app sends the device's IANA zone as `X-Time-Zone`; the server keeps the latest one per person
 * (sessions get it as JARVIS_TIME_ZONE, wakeups default to it).
 */
function noteTimeZone(ctx: Ctx, p: Principal | null, req: IncomingMessage): void {
  const tz = req.headers["x-time-zone"];
  if (!p || p.kind !== "user" || typeof tz !== "string" || tz === p.user.time_zone || !validTimeZone(tz)) return;
  ctx.db.prepare("UPDATE users SET time_zone = ? WHERE id = ?").run(tz, p.user.id);
}

// ---- plumbing ------------------------------------------------------------------------------------------

const MAX_BODY = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(httpError("bad_request", "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(httpError("bad_request", "body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function sendError(res: ServerResponse, e: unknown): void {
  const he = asHttpError(e);
  sendJson(res, he.status, { error: { code: he.code, message: he.message } } satisfies A.ApiError);
}

function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(httpError("bad_request", "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const RELAY_RE = /^\/api\/tasks\/([^/]+)\/daemon\/http(\/.*)$/;
const RELAY_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/** The HTTP relay to a task's daemon: same checks as the daemon WebSocket, then streamed through the channel. */
async function relayHttp(ctx: Ctx, resolveDeps: ResolveDeps, req: IncomingMessage, res: ServerResponse, url: URL, m: RegExpExecArray): Promise<void> {
  if (!RELAY_METHODS.has(req.method || "")) throw httpError("bad_request", "method not relayed");
  if (req.method !== "GET" && req.method !== "HEAD") checkOrigin(ctx, req);
  const principal = await resolvePrincipal(req, resolveDeps);
  authorize(principal, { kind: "member" });
  const t = tasks.getTask(ctx, decodeURIComponent(m[1]!));
  authorize(principal, { kind: "owned", ownerId: t ? t.user_id : "\0none", what: "task" });
  if (!t) throw httpError("not_found", "no such task");
  if (!ctx.hub.isConnected(t.id)) throw httpError("unavailable", `the task's session is not connected (state ${t.state})`);
  const body = req.method === "GET" || req.method === "HEAD" ? null : await readRaw(req, MAX_RELAY_BODY);
  ctx.hub.openHttp(t.id, userOf(principal).user.id, res, {
    method: req.method!,
    path: m[2]! + url.search,
    headers: relayRequestHeaders(req.headers, tasks.daemonPassword(ctx, t)),
    body,
  });
}

export function makeHandler(ctx: Ctx, resolveDeps: ResolveDeps, routes: Routes, web: WebApp | null = null) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url || "/", "http://local");
      if (web && url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return await web.serve(req, res, url, resolveDeps.verifier);
      const relay = RELAY_RE.exec(url.pathname);
      if (relay) return await relayHttp(ctx, resolveDeps, req, res, url, relay);
      const matches = routes.filter((r) => r.re.test(url.pathname));
      if (!matches.length) throw httpError("not_found", "no such route");
      const rt = matches.find((r) => r.method === req.method);
      if (!rt) throw httpError("not_found", "no such route");
      const m = rt.re.exec(url.pathname)!;
      const params: Record<string, string> = {};
      rt.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      if (req.method !== "GET" && req.method !== "HEAD") checkOrigin(ctx, req);
      const principal = rt.auth ? await resolvePrincipal(req, resolveDeps) : null;
      noteTimeZone(ctx, principal, req);
      const out = await rt.handler({ req, url, params, principal, body: () => readBody(req) });
      if (out.redirect) {
        res.writeHead(302, { location: out.redirect, "cache-control": "no-store" });
        res.end();
      } else if (out.raw) {
        res.writeHead(out.status ?? 200, { ...out.raw.headers, "content-type": out.raw.type, "content-length": out.raw.body.length, "cache-control": "no-store" });
        res.end(out.raw.body);
      } else sendJson(res, out.status ?? 200, out.json ?? {});
    } catch (e) {
      if (!(e instanceof HttpError)) ctx.log("request failed", { url: req.url, error: (e as Error).message });
      sendError(res, e);
    }
  };
}

// ---- WebSocket upgrades -------------------------------------------------------------------------------

function refuse(socket: Duplex, e: unknown): void {
  const he = asHttpError(e);
  const body = JSON.stringify({ error: { code: he.code, message: he.message } });
  socket.end(
    `HTTP/1.1 ${he.status} ${he.code}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

export function makeUpgradeHandler(ctx: Ctx, resolveDeps: ResolveDeps) {
  const daemonWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, handleProtocols: (offered) => pickClientProtocol(offered) });
  const channelWss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const proxyWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const close = () => {
    daemonWss.close();
    channelWss.close();
    proxyWss.close();
  };
  const handler = async (req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    socket.on("error", () => socket.destroy());
    try {
      const url = new URL(req.url || "/", "http://local");
      checkOrigin(ctx, req);
      const principal = await resolvePrincipal(req, resolveDeps);
      if (url.pathname === "/api/session/channel") {
        authorize(principal, { kind: "session" });
        const task = (principal as Extract<Principal, { kind: "session" }>).task;
        channelWss.handleUpgrade(req, socket, head, (ws: WebSocket) => ctx.hub.attachSession(task.id, ws));
        return;
      }
      if (url.pathname === "/api/session/proxy") {
        authorize(principal, { kind: "session" });
        const task = (principal as Extract<Principal, { kind: "session" }>).task;
        const owner = users.requireUser(ctx, task.user_id);
        if (owner.status !== "active") throw httpError("forbidden", "the task's owner is not an active member");
        const target = parseTarget(url);
        const p = checkRelay(ctx, owner);
        runTunnel(ctx, proxyWss, req, socket, head, owner, task, p, target);
        return;
      }
      const m = /^\/api\/tasks\/([^/]+)\/daemon$/.exec(url.pathname);
      if (!m) throw httpError("not_found", "no such route");
      authorize(principal, { kind: "member" } satisfies Target);
      const t = tasks.getTask(ctx, decodeURIComponent(m[1]!));
      authorize(principal, { kind: "owned", ownerId: t ? t.user_id : "\0none", what: "task" });
      if (!t) throw httpError("not_found", "no such task");
      if (!ctx.hub.isConnected(t.id)) throw httpError("unavailable", `the task's session is not connected (state ${t.state})`);
      const { user } = userOf(principal);
      const offered = String(req.headers["sec-websocket-protocol"] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const password = tasks.daemonPassword(ctx, t);
      daemonWss.handleUpgrade(req, socket, head, (ws: WebSocket) =>
        ctx.hub.openStream(t.id, user.id, ws, { path: ctx.config.daemonPath, daemonPassword: password, clientProtocols: offered }),
      );
    } catch (e) {
      refuse(socket, e);
    }
  };
  return { handler, close };
}
