// The Jarvis 3 instance API contract: request and response shapes of every route.
// docs/API.md describes the routes and who may call them; this module is the machine-checked
// half of that contract. The app imports it (type-only), so it must stay free of runtime code
// and of imports from the rest of the server.

// ---- common -----------------------------------------------------------------------------

/** Every error response: HTTP 4xx/5xx with this body. */
export interface ApiError {
  error: { code: ErrorCode; message: string };
}

export type ErrorCode =
  | "unauthenticated" // 401: no valid Cloudflare Access JWT (or, on /api/session/*, no valid session token)
  | "forbidden" // 403: identity is valid but not an active member, an unknown device, or the wrong kind of caller
  | "device_revoked" // 403: this device's token was revoked (DELETE /api/devices/:id); pair the device again
  | "not_found" // 404: no such resource, OR it exists but belongs to someone else (uniform on purpose)
  | "bad_request" // 400: malformed body or parameters
  | "conflict" // 409: the resource is in a state that does not allow this (see message)
  | "busy" // 409: another lifecycle operation is running on this task
  | "machine_hours_cap" // 429: the user's monthly machine-hour cap is reached
  | "instance_budget" // 429: the instance-wide monthly machine budget is reached
  | "too_many_requests" // 429: rate limit (device pairing)
  | "capability_missing" // 403 (session routes): the task's role lacks this action; file an access request
  | "upstream" // 502: a provider (Fly, OpenRouter, Cloudflare, Google, S3) failed
  | "unavailable" // 503: the session is not connected yet
  | "internal"; // 500

export type Role = string; // "admin", "staff", or another role from the instance config
export type UserStatus = "active" | "suspended" | "removed";
export type IsoTime = string; // ISO-8601 UTC timestamp

// ---- identity -----------------------------------------------------------------------------

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  isAdmin: boolean;
  createdAt: IsoTime;
}

export interface LimitsView {
  /** Monthly OpenRouter credit limit (USD) in force for this user (role default or override). null = no limit. */
  openrouterMonthlyUsd: number | null;
  /** Whether that value is a per-user override set by an admin. */
  openrouterOverride: boolean;
  /** Monthly machine-hour cap in force. null = no cap. */
  machineHoursPerMonth: number | null;
  machineHoursOverride: boolean;
}

export interface UsageView {
  month: string; // "YYYY-MM" (UTC)
  machineHours: number; // machine hours used this month, all tasks
  /** At the cap: the user's tasks are paused and new tasks/resumes are refused until next month or a higher limit. */
  machineHoursCapReached: boolean;
  /** Whether the user has an OpenRouter key yet (minted on the first task). */
  openrouterKey: boolean;
}

/** GET /api/me, GET /api/users/:id */
export interface UserDetail {
  user: UserView;
  limits: LimitsView;
  usage: UsageView;
}

/** GET /api/me: the caller's own detail, plus what only the caller sees. */
export interface MeView extends UserDetail {
  /** Notices the caller has not marked read yet (POST /api/notices/read). */
  unreadNotices: number;
  /** Approvals waiting for the caller's decision (GET /api/approvals?pending=1). */
  pendingApprovals: number;
  /** Whether the caller is the instance's owner: the one who approves Tier 3 changes with a passkey. */
  isOwner: boolean;
  /** What this instance has switched on. */
  features?: InstanceFeatures;
}

export interface InstanceFeatures {
  /** "Suggest for everyone" (POST /api/users/:id/layer/suggest) is set up. */
  suggestions: boolean;
}

/** GET /api/users (admin) */
export interface UserList {
  users: UserDetail[];
}

/** PATCH /api/users/:id/limits (admin). A field left out is unchanged; null clears the override (role default applies). */
export interface SetLimitsRequest {
  openrouterMonthlyUsd?: number | null;
  machineHoursPerMonth?: number | null;
}

export interface DeviceView {
  id: string;
  userId: string;
  name: string;
  model: string;
  createdAt: IsoTime;
  lastSeenAt: IsoTime;
}

/** GET /api/devices */
export interface DeviceList {
  devices: DeviceView[];
}

/**
 * GET /api/devices/pair?state=<16-64 [A-Za-z0-9_-]>&name=&model=
 * Answered with 302 to `<app scheme>://paired?` + these as query parameters,
 * or `<app scheme>://paired?state=…&error=<message>&status=<http status>`.
 */
export interface PairResult {
  state: string;
  id: string;
  clientId: string;
  clientSecret: string;
}

// ---- models -------------------------------------------------------------------------------

export interface ModelView {
  id: string; // OpenRouter model id, e.g. "anthropic/claude-…"
  label: string;
}

/** GET /api/models */
export interface ModelList {
  models: ModelView[];
  default: string;
}

// ---- tasks ----------------------------------------------------------------------------------

/**
 * starting   machine being created / booting; the session has not dialled in yet
 * running    the session is connected and working
 * idle       the session is connected and reported itself idle (auto-pause counts from here)
 * pausing    snapshot being taken; the machine is destroyed afterwards
 * paused     no machine; the snapshot holds the state
 * destroying archive being written, then the machine is destroyed
 * archived   final; the archive holds the state
 * failed     the machine could not be created; only Destroy is possible
 */
export type TaskState = "starting" | "running" | "idle" | "pausing" | "paused" | "destroying" | "archived" | "failed";

export interface TaskView {
  id: string;
  userId: string;
  title: string;
  model: string;
  state: TaskState;
  /** The lifecycle operation running right now, if any. */
  busy: null | { kind: "creating" | "pausing" | "resuming" | "destroying"; since: IsoTime };
  /** Why the last operation failed, or why the task was paused by the instance (cap, budget, offboarding). */
  error: string | null;
  pausedReason: null | "user" | "idle" | "machine_hours_cap" | "instance_budget" | "offboarded";
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** True while the session's reverse channel is connected (chat is possible). */
  connected: boolean;
  /**
   * The Paseo agent on the task's daemon that is the task itself (the one the first prompt went to),
   * as reported by the session. null until the session has created it. Kept across pause/resume.
   */
  agentId: string | null;
}

/** POST /api/tasks */
export interface CreateTaskRequest {
  /** The first prompt, 1..16000 characters. */
  prompt: string;
  /** One of GET /api/models; default = the instance default. */
  model?: string;
  /** Optional; default = the prompt's first line, cut to 80 characters. */
  title?: string;
  /** [A-Za-z0-9_-]{1,64}. A repeat with the same id returns the first create's task (idempotent). */
  requestId?: string;
}

/** GET /api/tasks */
export interface TaskList {
  tasks: TaskView[];
}

// ---- personal layer -----------------------------------------------------------------------

export interface PersonalSkill {
  name: string; // [a-z0-9][a-z0-9-]{0,63}
  /** relative path -> UTF-8 text. Must contain "SKILL.md". */
  files: Record<string, string>;
}

export interface PersonalNote {
  id: string;
  text: string;
  createdAt: IsoTime;
  /** "user" = added in the app; "session" = written by the agent ("remember …") with the task id. */
  source: "user" | "session";
  taskId: string | null;
}

export interface PersonalLayerVersionView {
  version: number;
  createdAt: IsoTime;
  reason: "reset" | "undo";
}

/** GET /api/users/:id/layer */
export interface PersonalLayerView {
  instructions: string;
  skills: PersonalSkill[];
  notes: PersonalNote[];
  versions: PersonalLayerVersionView[]; // newest first
  updatedAt: IsoTime | null;
}

/** PUT /api/users/:id/layer/instructions */
export interface SetInstructionsRequest {
  text: string; // ≤ 64000 characters
}

/** PUT /api/users/:id/layer/skills/:name */
export interface PutSkillRequest {
  files: Record<string, string>;
}

/** POST /api/users/:id/layer/notes, POST /api/session/notes */
export interface AddNoteRequest {
  text: string; // 1..4000 characters
}

/** POST /api/users/:id/layer/reset */
export interface ResetResult {
  /** The archived version number; null when the layer was already empty (nothing archived). */
  version: number | null;
  layer: PersonalLayerView;
}

/** GET /api/tasks/:id/archive?link=1 */
export interface ArchiveLink {
  /** A presigned GET of the archived state (state.tar.gz). */
  url: string;
  expiresAt: IsoTime;
}

// ---- "Suggest for everyone" ---------------------------------------------------------------

/** POST /api/users/:id/layer/suggest: propose part of a personal layer for the org-env repo. */
export type SuggestRequest =
  | { kind: "skill"; name: string; message?: string }
  | { kind: "instructions"; message?: string }
  | { kind: "note"; noteId: string; message?: string };

export type SuggestionState = "open" | "merged" | "closed";

export interface SuggestionView {
  id: string;
  /** Whose personal layer it came from. */
  userId: string;
  userEmail: string;
  /** Who pressed the button (the owner, or an admin on the owner's layer). */
  byUserId: string;
  kind: "skill" | "instructions" | "note";
  /** The skill name, the note id, or "" for instructions. */
  name: string;
  title: string;
  /** The pull request on the org-env repo. */
  number: number;
  url: string;
  /** As last checked on the forge (checkedAt). */
  state: SuggestionState;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  checkedAt: IsoTime;
}

/** GET /api/suggestions */
export interface SuggestionList {
  suggestions: SuggestionView[];
}

// ---- assembled layers (what a session loads) ----------------------------------------------

export type LayerName = "org" | "role" | "personal" | "policy";

export interface AssembledInstruction {
  layer: LayerName;
  /** Where it came from: a path in the org-env repo, or "personal:instructions" / "personal:notes". */
  source: string;
  text: string;
}

export interface AssembledSkill {
  /** The name the session sees (renamed when it would shadow a higher-precedence skill). */
  name: string;
  originalName: string;
  layer: LayerName;
  /** relative path -> UTF-8 text */
  files: Record<string, string>;
}

/** An OpenCode permission rule from the locked policy (the only layer allowed to set any). */
export interface DenyRule {
  permission: string; // e.g. "bash", "edit", "webfetch"
  pattern: string; // e.g. "rm -rf *"
}

/** GET /api/session/bundle (session token) and GET /api/users/:id/layers (owner/admin preview). */
export interface LayerBundle {
  orgEnvCommit: string;
  role: Role;
  /** In load order: org, role, personal, policy. */
  instructions: AssembledInstruction[];
  skills: AssembledSkill[];
  deny: DenyRule[];
  /** Locked-policy guard rules (policy/guards.json): tool calls that stop for an approval first. */
  guards: GuardRule[];
}

/**
 * A locked-policy guard (policy/guards.json): a tool call whose input matches `match` (a regular
 * expression, case-insensitive, searched anywhere in the bash command, or in the tool's JSON
 * arguments for other tools) stops and waits for an approval before it runs.
 */
export interface GuardRule {
  id: string; // [a-z0-9][a-z0-9-]{0,63}
  /** OpenCode tool name, e.g. "bash", "webfetch"; "*" = every tool. */
  tool: string;
  match: string;
  /** "self": one tap by the task's owner; "admin": one tap by an admin. */
  approval: "self" | "admin";
  /** What the action is, for people: "Send an email from your own mailbox". */
  label: string;
}

// ---- session-facing ---------------------------------------------------------------------------

/** POST /api/session/status */
export interface SessionStatusRequest {
  activity: "busy" | "idle";
  /** Optional new title (≤ 120 characters). */
  title?: string;
  /** The task's main agent id on the daemon ([A-Za-z0-9._:-]{1,128}); sent once it exists. */
  agentId?: string;
}

// ---- notices / admin --------------------------------------------------------------------------

export interface NoticeView {
  id: string;
  kind: "machine_hours_cap" | "instance_budget" | "task_failed" | "offboarded" | "suggestion" | "approval_needed" | "approval_decided" | "passkey_added";
  text: string;
  taskId: string | null;
  createdAt: IsoTime;
  /** Whether the caller has marked it read (POST /api/notices/read). */
  read: boolean;
}

/** GET /api/notices */
export interface NoticeList {
  notices: NoticeView[];
}

/** POST /api/notices/read: mark notices read, all of them or those created up to `upTo` (a notice id). */
export interface MarkNoticesReadRequest {
  upTo?: string;
}

/** POST /api/notices/read */
export interface MarkNoticesReadResult {
  unreadNotices: number;
}

/** GET /api/admin/budget (admin) */
export interface BudgetView {
  month: string;
  spentUsd: number;
  capUsd: number | null;
  warnUsd: number | null;
  capped: boolean;
  ratePerHour: number;
  lastSampleAt: IsoTime | null;
}

/** POST /api/admin/directory/sync (admin) */
export interface SyncResult {
  ok: boolean;
  error: string | null;
  added: string[]; // emails
  updated: string[];
  offboarded: string[];
  reactivated: string[];
}

// ---- actions and approvals -------------------------------------------------------------------

/** One named action of the broker (config `actions`), as a session sees it. */
export interface ActionView {
  name: string; // config key, e.g. "company_email"
  type: string; // the built-in action type, e.g. "smtp.send"
  label: string;
  description: string;
  /** 2 = shared company asset (the server holds the credential); 3 = infrastructure (owner + passkey). */
  tier: 2 | 3;
  /** Parameter name -> what it takes. */
  params: Record<string, ActionParamView>;
  /** Whether the asking task may use it now (its role has it, or a grant). If not: file an access request. */
  available: boolean;
  /** Who approves when no auto rule matches: "auto", "self", "admin" or "owner" (Tier 3). */
  approval: ApprovalLevel;
}

export interface ActionParamView {
  type: "string" | "number" | "string[]" | "number|null";
  required: boolean;
  description: string;
}

/** GET /api/session/actions */
export interface ActionCatalogue {
  actions: ActionView[];
}

export type ApprovalKind = "action" | "guard" | "access" | "question";
/** auto: allowed by the action's policy, no person needed. self: the task's owner. admin: any admin. owner: the instance's owner with a passkey (Tier 3). */
export type ApprovalLevel = "auto" | "self" | "admin" | "owner";
/**
 * pending   waiting for a decision
 * approved  approved (a guard may run; an access request is granted; a question is answered)
 * executing an approved action is running on the server
 * done      the action ran (`result`)
 * failed    the action ran and failed (`error`)
 * denied    refused (`decision.note` says why)
 * cancelled the task stopped (paused, destroyed or offboarded) before a decision
 */
export type ApprovalState = "pending" | "approved" | "executing" | "done" | "failed" | "denied" | "cancelled";

/** Exactly what will happen, for the person deciding. */
export interface ApprovalPreview {
  /** One line: "Send an email to x@example.net from support@example.org". */
  summary: string;
  fields: { label: string; value: string }[];
  /** A longer text shown as-is (an email body, a command, a question), or null. */
  body: string | null;
}

export interface ApprovalView {
  id: string;
  taskId: string | null;
  taskTitle: string | null;
  /** The task's owner, on whose behalf it was asked. */
  user: { id: string; email: string; name: string };
  kind: ApprovalKind;
  approver: ApprovalLevel;
  state: ApprovalState;
  /** The action name (action, access), or the guard rule id (guard); null for a question. */
  action: string | null;
  preview: ApprovalPreview;
  /** Why the agent asks (from the agent). */
  reason: string;
  /** A question's suggested answers (may be empty), else null. */
  options: string[] | null;
  /** Tier 3: sha256 (hex) of the canonical change the passkey signs; null otherwise. */
  changeHash: string | null;
  decision: null | {
    by: { id: string; email: string; name: string } | null; // null for auto
    at: IsoTime;
    /** A denial's reason, or a question's answer. */
    note: string | null;
    /** An access grant's scope. */
    grantScope: "task" | "role" | null;
    /** Approved with a passkey (Tier 3). */
    passkey: boolean;
  };
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
  /** Whether the caller may decide it now. */
  canDecide: boolean;
  /** How: "tap" (POST …/decide), "passkey" (approve on the passkey page; deny is still a tap), or null. */
  decideWith: "tap" | "passkey" | null;
}

/** GET /api/approvals */
export interface ApprovalList {
  approvals: ApprovalView[];
}

/** POST /api/approvals/:id/decide */
export interface DecideRequest {
  decision: "approve" | "deny";
  /** A denial's reason (optional), or a question's answer (required to approve a question). */
  note?: string;
  /** Required to approve an access request: grant it for the asking task only, or for its whole role. */
  grantScope?: "task" | "role";
}

/** POST /api/session/approvals: what a session asks for. */
export type SessionApprovalRequest =
  | { kind: "action"; action: string; params: Record<string, unknown>; reason?: string }
  | { kind: "guard"; rule: string; tool: string; input: string; reason?: string }
  | { kind: "access"; action: string; reason: string }
  | { kind: "question"; question: string; options?: string[]; reason?: string };

// ---- passkeys (Tier 3 approvals) ---------------------------------------------------------------

export interface PasskeyView {
  id: string; // the credential id, base64url
  name: string;
  createdAt: IsoTime;
  lastUsedAt: IsoTime | null;
}

/** GET /api/passkeys */
export interface PasskeyList {
  passkeys: PasskeyView[];
}

/** POST /api/approvals/:id/passkey/options: the WebAuthn request options and the change they sign. */
export interface PasskeyApprovalOptions {
  options: Record<string, unknown>; // PublicKeyCredentialRequestOptionsJSON
  change: Record<string, unknown>;
  changeHash: string;
}

/** GET /api/health */
export interface Health {
  ok: true;
  version: string;
}

// ---- reverse channel (session <-> server), wss://<instance>/api/session/channel ---------------

/** Frames the server sends to the session's channel agent. */
export type ServerToSessionFrame =
  | { type: "ws-open"; id: string; path: string; protocols: string[]; headers: Record<string, string> }
  | { type: "ws-msg"; id: string; text?: string; data_b64?: string }
  | { type: "ws-close"; id: string; code?: number; reason?: string }
  /** An HTTP request to the local daemon (the HTTP relay). Body ≤ 1 MiB, base64. */
  | { type: "http-req"; id: string; method: string; path: string; headers: Record<string, string>; body_b64?: string }
  /** The app went away: stop sending the response of request `id`. */
  | { type: "http-cancel"; id: string }
  | { type: "pong" };

/** Frames the session's channel agent sends to the server. */
export type SessionToServerFrame =
  | { type: "hello"; agent: string }
  | { type: "ws-msg"; id: string; text?: string; data_b64?: string }
  | { type: "ws-close"; id: string; code?: number; reason?: string }
  /** The daemon's answer to http-req `id`: status and headers first, then body chunks, then the end. */
  | { type: "http-res"; id: string; status: number; headers: Record<string, string> }
  | { type: "http-data"; id: string; data_b64: string }
  | { type: "http-end"; id: string; error?: string }
  | { type: "ping" };
