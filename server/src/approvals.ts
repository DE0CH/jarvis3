// Actions and approvals (DESIGN "Actions and approvals", docs/API.md section 11).
//
// A session asks; the server decides who must approve, keeps the request in one queue, tells the
// approver(s) with a notice, and lets the session wait for the answer:
//
//   action    a named broker action (config `actions`): checked against the task's capabilities,
//             validated, shown as a preview; approved automatically when the action's policy allows
//             it (allow-list / threshold), else by the level the config names; Tier 3 types only
//             by the owner with a passkey (passkeys.ts). Approved actions run HERE, with
//             credentials the session never sees.
//   guard     a locked-policy guard (policy/guards.json) stopped a tool call in the session; the
//             rule (not the session) says who approves. Approved = the session runs it.
//   access    the task's role lacks an action; an admin grants it for the task or the role.
//   question  "ask the boss": an admin answers.
//
// Who decides: self = the task's owner; admin = any admin; owner = the instance owner, with a
// passkey; auto = nobody (the policy allowed it).
import { createHash } from "node:crypto";
import type {
  ActionView,
  ApprovalKind,
  ApprovalLevel,
  ApprovalPreview,
  ApprovalState,
  ApprovalView,
  DecideRequest,
  GuardRule,
  SessionApprovalRequest,
} from "./api-types.ts";
import type { ActionConfig } from "./config.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice, isAdminRole } from "./ctx.ts";
import type { TaskRow, UserRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { tx } from "./db.ts";
import { asHttpError, httpError, notFound } from "./errors.ts";
import { actionType, allowListed, type ActionType, type Params } from "./actions/index.ts";
import { parseGuards } from "./layers.ts";

export interface ApprovalRow {
  id: string;
  task_id: string | null;
  user_id: string;
  kind: ApprovalKind;
  approver: ApprovalLevel;
  state: ApprovalState;
  action: string | null;
  payload: string;
  preview: string;
  reason: string;
  options: string | null;
  change_hash: string | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  grant_scope: "task" | "role" | null;
  passkey_proof: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** Who is looking: a user and whether they are an admin. */
export interface Viewer {
  user: UserRow;
  isAdmin: boolean;
}

const LIMITS = { reason: 2000, question: 4000, options: 6, option: 200, input: 20_000, note: 4000 };

// ---- owner, capabilities, the catalogue -------------------------------------------------------------

/** The instance's owner (config `owner`), if that person is an active admin now. */
export function ownerUser(ctx: Ctx): UserRow | null {
  const email = ctx.config.owner?.trim().toLowerCase();
  if (!email) return null;
  const u = ctx.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
  return u && u.status === "active" && isAdminRole(ctx.config, u.role) ? u : null;
}
export const isOwner = (ctx: Ctx, u: UserRow): boolean => ownerUser(ctx)?.id === u.id;

function actionConfig(ctx: Ctx, name: string): { cfg: ActionConfig; type: ActionType } | null {
  const cfg = ctx.config.actions?.[name];
  if (!cfg) return null;
  const type = actionType(cfg.type);
  return type ? { cfg, type } : null;
}

/**
 * May this task use the action? Its owner's role is listed (or "*"), or an admin granted it to the
 * task or the role. Tier 3 actions: only sessions of an admin role, never through a grant.
 */
export function hasCapability(ctx: Ctx, task: TaskRow, owner: UserRow, name: string): boolean {
  const a = actionConfig(ctx, name);
  if (!a) return false;
  if (a.type.tier === 3) return isAdminRole(ctx.config, owner.role) && (a.cfg.roles.includes("*") || a.cfg.roles.includes(owner.role));
  if (a.cfg.roles.includes("*") || a.cfg.roles.includes(owner.role)) return true;
  const g = ctx.db
    .prepare("SELECT 1 FROM grants WHERE action = ? AND ((scope = 'task' AND task_id = ?) OR (scope = 'role' AND role = ?)) LIMIT 1")
    .get(name, task.id, owner.role);
  return !!g;
}

const levelOf = (a: { cfg: ActionConfig; type: ActionType }): ApprovalLevel => (a.type.tier === 3 ? "owner" : (a.cfg.approval ?? "admin"));

export function catalogue(ctx: Ctx, task: TaskRow, owner: UserRow): ActionView[] {
  const out: ActionView[] = [];
  for (const name of Object.keys(ctx.config.actions ?? {}).sort()) {
    const a = actionConfig(ctx, name)!;
    // a Tier 3 action is not even listed to a session that can never use it
    if (a.type.tier === 3 && !isAdminRole(ctx.config, owner.role)) continue;
    out.push({
      name,
      type: a.cfg.type,
      label: a.cfg.label,
      description: a.cfg.description ?? "",
      tier: a.type.tier,
      params: a.type.params,
      available: hasCapability(ctx, task, owner, name),
      approval: levelOf(a),
    });
  }
  return out;
}

/** The policy's auto rules: an allow-list every subject matches, or an amount under the threshold. */
export function autoAllowed(a: { cfg: ActionConfig; type: ActionType }, params: Params): boolean {
  if (a.type.tier === 3) return false;
  if (a.cfg.approval === "auto") return true;
  const rules = a.cfg.auto;
  if (!rules) return false;
  if (rules.allowList?.length && a.type.subjects) {
    const subjects = a.type.subjects(params, a.cfg);
    if (subjects.length && subjects.every((s) => allowListed(s, rules.allowList!))) return true;
  }
  if (typeof rules.below === "number" && a.type.amount) {
    if (a.type.amount(params, a.cfg) < rules.below) return true;
  }
  return false;
}

// ---- guard rules (policy/guards.json) -----------------------------------------------------------------

const guardCache = new WeakMap<Ctx, { commit: string; rules: GuardRule[] }>();

export async function guardRules(ctx: Ctx): Promise<GuardRule[]> {
  const commit = ctx.orgEnv.commit();
  const hit = guardCache.get(ctx);
  if (hit?.commit === commit) return hit.rules;
  const raw = (await ctx.orgEnv.files()).get("policy/guards.json");
  const rules = parseGuards(raw ? new TextDecoder().decode(raw) : null);
  guardCache.set(ctx, { commit, rules });
  return rules;
}

// ---- reading -------------------------------------------------------------------------------------------

export function getApproval(ctx: Ctx, id: string): ApprovalRow | null {
  return (ctx.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined) ?? null;
}

const person = (u: UserRow | undefined) => (u ? { id: u.id, email: u.email, name: u.name } : null);
const userById = (ctx: Ctx, id: string | null) => (id ? (ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) : undefined);

export function canDecide(ctx: Ctx, a: ApprovalRow, v: Viewer): boolean {
  if (a.state !== "pending") return false;
  switch (a.approver) {
    case "self":
      return v.user.id === a.user_id;
    case "admin":
      return v.isAdmin;
    case "owner":
      return isOwner(ctx, v.user);
    default:
      return false;
  }
}

export function approvalView(ctx: Ctx, a: ApprovalRow, v: Viewer | null): ApprovalView {
  const owner = userById(ctx, a.user_id);
  const task = a.task_id ? (ctx.db.prepare("SELECT title FROM tasks WHERE id = ?").get(a.task_id) as { title: string } | undefined) : undefined;
  const may = v ? canDecide(ctx, a, v) : false;
  return {
    id: a.id,
    taskId: a.task_id,
    taskTitle: task?.title ?? null,
    user: person(owner) ?? { id: a.user_id, email: "", name: "" },
    kind: a.kind,
    approver: a.approver,
    state: a.state,
    action: a.action,
    preview: JSON.parse(a.preview) as ApprovalPreview,
    reason: a.reason,
    options: a.options ? (JSON.parse(a.options) as string[]) : null,
    changeHash: a.change_hash,
    decision:
      a.decided_at === null
        ? null
        : {
            by: person(userById(ctx, a.decided_by)),
            at: iso(a.decided_at),
            note: a.decision_note,
            grantScope: a.grant_scope,
            passkey: !!a.passkey_proof,
          },
    result: a.result ? (JSON.parse(a.result) as Record<string, unknown>) : null,
    error: a.error,
    createdAt: iso(a.created_at),
    updatedAt: iso(a.updated_at),
    canDecide: may,
    decideWith: may ? (a.approver === "owner" ? "passkey" : "tap") : null,
  };
}

/** The one visibility rule: the task's owner or an admin; anyone else gets the uniform 404. */
export function visibleApproval(ctx: Ctx, id: string, v: Viewer): ApprovalRow {
  const a = getApproval(ctx, id);
  if (!a || (a.user_id !== v.user.id && !v.isAdmin)) throw notFound("approval");
  return a;
}

/**
 * The caller's queue, newest first: everything they may see (an admin: everyone's; staff: their
 * own tasks'). `pending`: only what the caller can decide now.
 */
export function listApprovals(ctx: Ctx, v: Viewer, o: { pending?: boolean; taskId?: string; limit?: number } = {}): ApprovalView[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (!v.isAdmin) {
    where.push("user_id = ?");
    args.push(v.user.id);
  }
  if (o.pending) where.push("state = 'pending'");
  if (o.taskId) {
    where.push("task_id = ?");
    args.push(o.taskId);
  }
  const rows = ctx.db
    .prepare(`SELECT * FROM approvals ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...args, o.limit ?? 200) as unknown as ApprovalRow[];
  const views = rows.map((r) => approvalView(ctx, r, v));
  return o.pending ? views.filter((x) => x.canDecide) : views;
}

export function pendingCount(ctx: Ctx, v: Viewer): number {
  const rows = ctx.db.prepare("SELECT * FROM approvals WHERE state = 'pending'").all() as unknown as ApprovalRow[];
  return rows.filter((r) => canDecide(ctx, r, v)).length;
}

// ---- writing ---------------------------------------------------------------------------------------------

function update(ctx: Ctx, id: string, patch: Partial<ApprovalRow>): ApprovalRow {
  const keys = Object.keys(patch);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  ctx.db.prepare(`UPDATE approvals SET ${sets}${keys.length ? ", " : ""}updated_at = ? WHERE id = ?`).run(...keys.map((k) => (patch as Record<string, string | number | null>)[k] ?? null), ctx.clock.now(), id);
  ctx.approvalBus.emit("change", id);
  return getApproval(ctx, id)!;
}

/** The canonical change a Tier 3 passkey signs: stable JSON (sorted keys), then sha256. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** What exactly a Tier 3 approval approves (the passkey's challenge is derived from its hash). */
export function changeOf(ctx: Ctx, a: Pick<ApprovalRow, "id" | "action" | "payload" | "preview">): Record<string, unknown> {
  const cfg = ctx.config.actions?.[a.action ?? ""];
  return {
    v: 1,
    instance: ctx.config.instanceName,
    approval: a.id,
    action: a.action,
    type: cfg?.type ?? null,
    params: (JSON.parse(a.payload) as { params?: unknown }).params ?? null,
    summary: (JSON.parse(a.preview) as ApprovalPreview).summary,
  };
}
export const changeHash = (change: Record<string, unknown>): string => createHash("sha256").update(canonicalJson(change)).digest("hex");

function str(v: unknown, what: string, max: number, required = true): string {
  if (v === undefined || v === null || v === "") {
    if (!required) return "";
    throw httpError("bad_request", `${what} is required`);
  }
  if (typeof v !== "string") throw httpError("bad_request", `${what} must be a string`);
  const t = v.trim();
  if (required && !t) throw httpError("bad_request", `${what} is required`);
  if (t.length > max) throw httpError("bad_request", `${what} must be at most ${max} characters`);
  return t;
}

function insert(
  ctx: Ctx,
  task: TaskRow,
  r: { kind: ApprovalKind; approver: ApprovalLevel; state: ApprovalState; action: string | null; payload: unknown; preview: ApprovalPreview; reason: string; options?: string[] | null; tier3?: boolean },
): ApprovalRow {
  const id = randomId(8);
  const now = ctx.clock.now();
  const payload = JSON.stringify(r.payload);
  const preview = JSON.stringify(r.preview);
  const hash = r.tier3 ? changeHash(changeOf(ctx, { id, action: r.action, payload, preview })) : null;
  ctx.db
    .prepare(
      "INSERT INTO approvals(id, task_id, user_id, kind, approver, state, action, payload, preview, reason, options, change_hash, decided_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(id, task.id, task.user_id, r.kind, r.approver, r.state, r.action, payload, preview, r.reason, r.options ? JSON.stringify(r.options) : null, hash, r.state === "approved" ? now : null, now, now);
  const row = getApproval(ctx, id)!;
  if (r.state === "pending") notifyApprovers(ctx, row);
  return row;
}

function activeAdmins(ctx: Ctx): UserRow[] {
  return (ctx.db.prepare("SELECT * FROM users WHERE status = 'active'").all() as unknown as UserRow[]).filter((u) => isAdminRole(ctx.config, u.role));
}

function notifyApprovers(ctx: Ctx, a: ApprovalRow): void {
  const summary = (JSON.parse(a.preview) as ApprovalPreview).summary;
  const who: UserRow[] =
    a.approver === "self" ? [userById(ctx, a.user_id)!].filter(Boolean) : a.approver === "admin" ? activeAdmins(ctx) : a.approver === "owner" ? [ownerUser(ctx)].filter((u): u is UserRow => !!u) : [];
  const lead = a.kind === "question" ? "Question for you" : a.kind === "access" ? "Access request" : a.approver === "owner" ? "Infrastructure change to sign" : "Approval needed";
  for (const u of who) addNotice(ctx, u.id, "approval_needed", `${lead}: ${summary}`.slice(0, 500), a.task_id);
}

/** A session asks (POST /api/session/approvals). Auto-approved actions start running at once. */
export async function requestFromSession(ctx: Ctx, task: TaskRow, body: SessionApprovalRequest): Promise<ApprovalRow> {
  const owner = userById(ctx, task.user_id)!;
  const reason = str((body as { reason?: unknown })?.reason, "reason", LIMITS.reason, body?.kind === "access");
  switch (body?.kind) {
    case "action": {
      const name = str(body.action, "action", 64);
      const a = actionConfig(ctx, name);
      if (!a) throw httpError("bad_request", `no action named ${name}; the available actions are: ${Object.keys(ctx.config.actions ?? {}).join(", ") || "none"}`);
      if (!hasCapability(ctx, task, owner, name)) {
        if (a.type.tier === 3 && !isAdminRole(ctx.config, owner.role)) throw httpError("capability_missing", `${name} is an infrastructure change only an admin's task can ask for`);
        throw httpError("capability_missing", `this task's role (${owner.role}) does not have ${name}; ask for access with a reason (jarvis_request_access)`);
      }
      if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) throw httpError("bad_request", "params must be an object");
      const params = a.type.validate(body.params, a.cfg);
      const preview = a.type.preview(params, a.cfg, ctx);
      const auto = autoAllowed(a, params);
      const row = insert(ctx, task, {
        kind: "action",
        approver: auto ? "auto" : levelOf(a),
        state: auto ? "approved" : "pending",
        action: name,
        payload: { params },
        preview,
        reason,
        tier3: a.type.tier === 3,
      });
      if (auto) startAction(ctx, row.id);
      return getApproval(ctx, row.id)!;
    }
    case "guard": {
      const ruleId = str(body.rule, "rule", 64);
      const rule = (await guardRules(ctx)).find((r) => r.id === ruleId);
      if (!rule) throw httpError("bad_request", `no guard rule ${ruleId} in the locked policy`);
      const tool = str(body.tool, "tool", 64);
      const input = str(body.input, "input", LIMITS.input);
      return insert(ctx, task, {
        kind: "guard",
        approver: rule.approval, // the rule decides, never the session
        state: "pending",
        action: rule.id,
        payload: { tool, input },
        preview: { summary: rule.label, fields: [{ label: "Tool", value: tool }], body: input },
        reason,
      });
    }
    case "access": {
      const name = str(body.action, "action", 64);
      const a = actionConfig(ctx, name);
      if (!a) throw httpError("bad_request", `no action named ${name}`);
      if (a.type.tier === 3) throw httpError("bad_request", `${name} is an infrastructure (Tier 3) action; it can't be granted to a task or role`);
      if (hasCapability(ctx, task, owner, name)) throw httpError("conflict", `this task already has ${name}`);
      const open = ctx.db.prepare("SELECT * FROM approvals WHERE task_id = ? AND kind = 'access' AND action = ? AND state = 'pending'").get(task.id, name) as ApprovalRow | undefined;
      if (open) return open;
      return insert(ctx, task, {
        kind: "access",
        approver: "admin",
        state: "pending",
        action: name,
        payload: { action: name },
        preview: {
          summary: `Let ${owner.name || owner.email} use "${a.cfg.label}"`,
          fields: [
            { label: "Action", value: `${a.cfg.label} (${name})` },
            { label: "Asked by", value: owner.email },
            { label: "Role", value: owner.role },
          ],
          body: reason,
        },
        reason,
      });
    }
    case "question": {
      const question = str(body.question, "question", LIMITS.question);
      let options: string[] = [];
      if (body.options !== undefined) {
        if (!Array.isArray(body.options) || body.options.length > LIMITS.options) throw httpError("bad_request", `options: at most ${LIMITS.options} strings`);
        options = body.options.map((o, i) => str(o, `options[${i}]`, LIMITS.option));
      }
      return insert(ctx, task, {
        kind: "question",
        approver: "admin",
        state: "pending",
        action: null,
        payload: { question },
        preview: { summary: question.split("\n")[0]!.slice(0, 200), fields: [{ label: "Asked by", value: owner.email }], body: question },
        reason,
        options,
      });
    }
    default:
      throw httpError("bad_request", "kind must be action, guard, access or question");
  }
}

/** A one-tap decision (POST /api/approvals/:id/decide). Tier 3 approvals are approved with a passkey instead. */
export function decide(ctx: Ctx, v: Viewer, id: string, body: DecideRequest): ApprovalRow {
  const a = visibleApproval(ctx, id, v);
  if (a.state !== "pending") throw httpError("conflict", `this request is already ${a.state}`);
  if (!canDecide(ctx, a, v)) {
    const who = a.approver === "self" ? "the task's owner" : a.approver === "admin" ? "an admin" : "the instance's owner";
    throw httpError("forbidden", `only ${who} can decide this`);
  }
  if (body?.decision !== "approve" && body?.decision !== "deny") throw httpError("bad_request", "decision must be approve or deny");
  const note = str(body.note, "note", LIMITS.note, false) || null;
  if (body.decision === "deny") return finish(ctx, a, v.user, { state: "denied", note });
  if (a.approver === "owner") throw httpError("bad_request", "a Tier 3 change is approved with a passkey (the passkey page), not a tap");
  if (a.kind === "question" && !note) throw httpError("bad_request", "an answer (note) is required");
  if (a.kind === "access") {
    if (body.grantScope !== "task" && body.grantScope !== "role") throw httpError("bad_request", "grantScope must be task or role");
    return finish(ctx, a, v.user, { state: "approved", note, grantScope: body.grantScope });
  }
  return finish(ctx, a, v.user, { state: "approved", note });
}

/** Record a decision (taps and passkeys); an approved action starts running, a grant is written. */
export function finish(
  ctx: Ctx,
  a: ApprovalRow,
  by: UserRow,
  d: { state: "approved" | "denied"; note: string | null; grantScope?: "task" | "role"; passkeyProof?: string },
): ApprovalRow {
  const row = tx(ctx.db, () => {
    const cur = getApproval(ctx, a.id)!;
    if (cur.state !== "pending") throw httpError("conflict", `this request is already ${cur.state}`);
    if (d.state === "approved" && a.kind === "access") {
      const owner = userById(ctx, a.user_id)!;
      ctx.db
        .prepare("INSERT INTO grants(id, action, scope, task_id, role, granted_by, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomId(8), a.action, d.grantScope!, d.grantScope === "task" ? a.task_id : null, d.grantScope === "role" ? owner.role : null, by.id, a.id, ctx.clock.now());
    }
    return update(ctx, a.id, {
      state: d.state,
      decided_by: by.id,
      decided_at: ctx.clock.now(),
      decision_note: d.note,
      grant_scope: d.grantScope ?? null,
      passkey_proof: d.passkeyProof ?? null,
    });
  });
  if (by.id !== row.user_id) {
    const summary = (JSON.parse(row.preview) as ApprovalPreview).summary;
    const verb = d.state === "denied" ? "Denied" : row.kind === "question" ? "Answered" : row.kind === "access" ? "Granted" : "Approved";
    addNotice(ctx, row.user_id, "approval_decided", `${verb} by ${by.name || by.email}: ${summary}`.slice(0, 500), row.task_id);
  }
  if (row.kind === "action" && d.state === "approved") startAction(ctx, row.id);
  return getApproval(ctx, row.id)!;
}

/** Run an approved action on the server, in the background: approved -> executing -> done | failed. */
function startAction(ctx: Ctx, id: string): void {
  const a = update(ctx, id, { state: "executing" });
  ctx.ops.run(
    (async () => {
      const ac = actionConfig(ctx, a.action!);
      try {
        if (!ac) throw new Error(`the action ${a.action} is no longer configured`);
        const params = (JSON.parse(a.payload) as { params: Params }).params;
        const result = await ac.type.run({ ctx, name: a.action!, config: ac.cfg, secrets: ctx.actionSecrets[a.action!] ?? {}, params });
        update(ctx, id, { state: "done", result: JSON.stringify(result) });
        ctx.log("action done", { approval: id, action: a.action });
      } catch (e) {
        update(ctx, id, { state: "failed", error: asHttpError(e).message.slice(0, 500) });
        ctx.log("action failed", { approval: id, action: a.action, error: (e as Error).message.slice(0, 200) });
      }
    })(),
    ctx.log,
    `action ${id}`,
  );
}

/** Pending requests of a task that stopped (paused, destroyed, offboarded) are cancelled. */
export function cancelForTask(ctx: Ctx, taskId: string, why: string): void {
  const rows = ctx.db.prepare("SELECT id FROM approvals WHERE task_id = ? AND state = 'pending'").all(taskId) as { id: string }[];
  for (const r of rows) update(ctx, r.id, { state: "cancelled", error: why });
}

// ---- the session waits --------------------------------------------------------------------------------

/** Whether the session has its answer: an action once it ran (or won't); anything else once decided. */
export function settled(a: ApprovalRow): boolean {
  if (a.kind === "action") return ["done", "failed", "denied", "cancelled"].includes(a.state);
  return a.state !== "pending";
}

/** Long poll: resolves with the approval once settled, or after `seconds` with it as it is. */
export function waitSettled(ctx: Ctx, id: string, seconds: number): Promise<ApprovalRow> {
  const now = getApproval(ctx, id)!;
  if (settled(now) || seconds <= 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      ctx.approvalBus.off("change", onChange);
      resolve(getApproval(ctx, id)!);
    };
    const onChange = (changed: string) => {
      if (changed === id && settled(getApproval(ctx, id)!)) done();
    };
    const timer = setTimeout(done, seconds * 1000);
    ctx.approvalBus.on("change", onChange);
  });
}
