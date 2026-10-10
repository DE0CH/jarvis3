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
  | "tools_cap" // 429: the user's (or the instance's) monthly cap on web tools or proxy traffic is reached
  | "too_many_requests" // 429: rate limit (device pairing)
  | "capability_missing" // 403 (session routes): the task's role lacks this action; file an access request
  | "upstream" // 502: a provider (Fly, OpenRouter, Cloudflare, Google, S3) failed
  | "too_large" // 413: a file over the instance's per-file limit, or over the user's storage quota (see message)
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
  /** Tier 0 tools: caps in force and this month's use. Absent when the instance has no Tier 0 tools. */
  tools?: UserToolsView;
}

/** A user's Tier 0 tools this month (docs/TOOLS.md). */
export interface UserToolsView {
  month: string; // "YYYY-MM" (UTC)
  /** Web search + page fetching, metered by the server. null when neither is configured. */
  web: null | {
    /** Monthly cap in force (role default or override), USD. null = no cap. */
    capUsd: number | null;
    override: boolean;
    spentUsd: number;
    calls: number;
    capReached: boolean;
  };
  /** Proxy traffic. null when no proxy is configured. */
  proxy: null | {
    /** "subuser": the provider caps a sub-account of the user's own; "relay": the server meters it. */
    mode: "subuser" | "relay";
    capGb: number | null;
    override: boolean;
    usedGb: number;
    capReached: boolean;
  };
}

/** GET /api/me: the caller's own detail, plus what only the caller sees. */
export interface MeView extends UserDetail {
  /** Notices the caller has not marked read yet (POST /api/notices/read). */
  unreadNotices: number;
  /** Approvals waiting for the caller's decision (GET /api/approvals?pending=1). */
  pendingApprovals: number;
  /** Whether the caller is the instance's owner: the one who approves Tier 3 changes with a passkey. */
  isOwner: boolean;
  /** Channel posts of the caller's own tasks not yet marked read (section 15). */
  unreadPosts?: number;
  /** What this instance has switched on. */
  features?: InstanceFeatures;
}

export interface InstanceFeatures {
  /** "Suggest for everyone" (POST /api/users/:id/layer/suggest) is set up. */
  suggestions: boolean;
  /** Which Tier 0 tools this instance has switched on. */
  tools?: { search: boolean; fetch: boolean; proxy: boolean };
  /** The user's files (GET /api/users/:id/files) and first-prompt attachments. Optional: absent on older servers. */
  files?: boolean;
  /** Transcript search (GET /api/search). Optional: absent on older servers. */
  search?: boolean;
  /** Scheduled tasks, wakeups and channels (section 15). Optional: absent on older servers. */
  schedules?: boolean;
  /**
   * Push notifications for notices (section 16): which channels the instance can send through.
   * Absent on older servers and when the instance has no push keys.
   */
  push?: { apns: boolean; webPush: boolean };
}

/** GET /api/users (admin) */
export interface UserList {
  users: UserDetail[];
}

/** PATCH /api/users/:id/limits (admin). A field left out is unchanged; null clears the override (role default applies). */
export interface SetLimitsRequest {
  openrouterMonthlyUsd?: number | null;
  machineHoursPerMonth?: number | null;
  /** Tier 0 web tools (search + fetch), USD per month. */
  toolsMonthlyUsd?: number | null;
  /** Tier 0 proxy traffic, GB per month. */
  proxyMonthlyGb?: number | null;
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
  /**
   * Paths (in the owner's files) attached to the first prompt; [] when none. Optional: absent on
   * older servers.
   */
  attachments?: string[];
  /** The schedule that started this task (section 15), or null. */
  scheduleId?: string | null;
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
  /**
   * Files attached to the first prompt: paths in the caller's files (upload them first with
   * PUT /api/users/me/files/<path>), at most 20. The session copies them into
   * ~/workspace/attachments/ and names them in the first message; images also go to the model
   * inline.
   */
  attachments?: string[];
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

// ---- the user's files ------------------------------------------------------------------------

/**
 * One file in a user's files. `path` is relative, "/"-separated (folders are implied by paths):
 * 1..512 characters, segments of 1..255 characters, no "." or ".." segment, no control
 * characters or backslashes.
 */
export interface FileView {
  path: string;
  size: number;
  /** As uploaded (Content-Type), or guessed from the name. */
  contentType: string;
  updatedAt: IsoTime;
  /** Who wrote the current version: the user (app) or a session (`jarvis-files save`). */
  source: "user" | "session";
  /** The task whose session wrote it (source "session"), else null. */
  taskId: string | null;
}

/** GET /api/users/:id/files, GET /api/session/files */
export interface FileList {
  files: FileView[];
  /** Bytes used by all the user's files. */
  usedBytes: number;
  /** The user's storage quota in bytes. */
  quotaBytes: number;
  /** The largest single file the instance accepts, in bytes. */
  maxFileBytes: number;
}

/** GET /api/users/:id/files/<path>?link=1, GET /api/session/files/<path>: a short-lived download link. */
export interface FileLink {
  url: string;
  expiresAt: IsoTime;
}

/** POST /api/users/:id/files/move */
export interface MoveFileRequest {
  from: string;
  to: string;
}

// ---- transcript search --------------------------------------------------------------------------

export type TranscriptRole = "user" | "assistant" | "tool";

/** One indexed message of a task's conversation. */
export interface TranscriptEntry {
  /** The Paseo agent it belongs to (the task's main agent, or another agent on its daemon). */
  agentId: string;
  /** Position in that agent's timeline (Paseo's seq), ascending. */
  seq: number;
  role: TranscriptRole;
  /** The text (a tool call: its name, input and output, trimmed). */
  text: string;
  at: IsoTime;
}

/** GET /api/search?q=… */
export interface SearchHit extends TranscriptEntry {
  taskId: string;
  taskTitle: string;
  taskState: TaskState;
  /** The task's owner (admins searching everyone see other people's hits). */
  userId: string;
  /** A short excerpt around the match. */
  snippet: string;
  /** [start, end) character ranges in `snippet` that matched the query. */
  matches: [number, number][];
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}

/** GET /api/tasks/:id/transcript: a task's indexed conversation, oldest first. */
export interface TranscriptPage {
  taskId: string;
  entries: TranscriptEntry[];
  /** More entries before the first / after the last one returned. */
  hasOlder: boolean;
  hasNewer: boolean;
}

/** POST /api/session/transcript: the session reports part of an agent's timeline. */
export interface SessionTranscriptRequest {
  agentId: string;
  /** Paseo's timeline epoch; a new epoch replaces what the server holds for this agent. */
  epoch: string;
  /** At most 500; an entry with a `seq` the server has (same agent) replaces it. */
  entries: { seq: number; role: TranscriptRole; text: string; at: IsoTime }[];
}

/** GET /api/session/transcript, and the answer to POST /api/session/transcript */
export interface SessionTranscriptCursors {
  /** Per agent: the epoch the server holds and the highest seq it has. */
  agents: { agentId: string; epoch: string; lastSeq: number }[];
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

/** GET /api/session/tools: what this session's Tier 0 tools are and how much is left this month. */
export interface SessionToolsView {
  search: boolean;
  fetch: boolean;
  /** null: no proxy. "subuser": the machine holds its owner's capped sub-account (JARVIS_PROXY); "relay": through the server. */
  proxy: null | "subuser" | "relay";
  web: { capUsd: number | null; spentUsd: number } | null;
  proxyUsage: { capGb: number | null; usedGb: number } | null;
}

/** POST /api/session/tools/search */
export interface WebSearchRequest {
  query: string;
  /** 1..20, default 10. */
  numResults?: number;
  /** 0..20000: extracted page text per result, where the provider gives it. Default 0 (snippets only). */
  textChars?: number;
  since?: string; // YYYY-MM-DD
  includeDomains?: string[];
  country?: string; // two letters
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  text?: string;
}

export interface WebSearchResponse {
  provider: string;
  results: WebSearchHit[];
  costUsd: number;
  /** This month's search + fetch spend after this call, and the cap. */
  spentUsd: number;
  capUsd: number | null;
}

/** POST /api/session/tools/fetch */
export interface WebFetchRequest {
  url: string;
  /** Run the page's JavaScript first. Default false. */
  render?: boolean;
  /** The provider's residential/premium pool, for bot-walled sites (dearest). Default false. */
  premium?: boolean;
  country?: string;
  /** "html" (default, the raw page) or "text". */
  format?: "html" | "text";
}

export interface WebFetchResponse {
  provider: string;
  status: number;
  contentType: string;
  finalUrl: string | null;
  body: string;
  /** The body was cut to the server's limit. */
  truncated: boolean;
  costUsd: number;
  spentUsd: number;
  capUsd: number | null;
}

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
  kind:
    | "machine_hours_cap"
    | "tools_cap"
    | "instance_budget"
    | "task_failed"
    | "offboarded"
    | "suggestion"
    | "approval_needed"
    | "approval_decided"
    | "passkey_added"
    /** A task posted to its channel (section 15). */
    | "channel_post"
    /** A scheduled run was skipped (cap, budget, the previous run still live) or could not start. */
    | "schedule_skipped"
    /** A wakeup could not resume its task (cap, budget), or a condition wakeup gave up. */
    | "wakeup";
  text: string;
  taskId: string | null;
  /**
   * The approval an "approval_needed" or "approval_decided" notice is about (GET /api/approvals/:id);
   * null for other notices and for notices made before the server recorded it. Optional: absent on
   * older servers.
   */
  approvalId?: string | null;
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

/** GET /api/admin/tools (admin): the instance's Tier 0 providers and this month's totals. */
export interface ToolsAdminView {
  month: string;
  search: null | { provider: string };
  fetch: null | { provider: string };
  proxy: null | { provider: string; mode: "subuser" | "relay" };
  /** Search + fetch, every user together. */
  web: { spentUsd: number; calls: number; capUsd: number | null; capReached: boolean };
  /** Relayed proxy traffic (relay mode) or the sum of the sub-accounts' last-read use (subuser mode). */
  proxyUsedGb: number;
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
  /**
   * The asking user's role now (an access request's "role" grant scope names it); null if the user
   * is gone. Optional: absent on older servers.
   */
  userRole?: string | null;
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

// ---- scheduled tasks, wakeups, channels (docs/API.md section 15) ---------------------------------

/**
 * A scheduled task: `prompt` runs as a NEW task of the owner on a cron schedule in `timeZone`.
 * `cron` is five fields (minute hour day month weekday; names like MON or JAN allowed).
 */
export interface ScheduleView {
  id: string;
  userId: string;
  title: string;
  prompt: string;
  model: string;
  cron: string;
  timeZone: string;
  enabled: boolean;
  /** The next firing (null when disabled, or when the expression never fires again). */
  nextRunAt: IsoTime | null;
  lastRun: ScheduleRunView | null;
  createdAt: IsoTime;
  updatedAt: IsoTime;
}

/**
 * One firing. `started`: a task was made (`taskId`). `skipped_*`: no task — the owner's
 * machine-hour cap, the instance budget, the previous run's task still live, or the server was
 * down at the time (`missed`). `failed`: the task could not be made (`error`).
 */
export type ScheduleRunResult = "started" | "skipped_cap" | "skipped_budget" | "skipped_overlap" | "missed" | "failed";

export interface ScheduleRunView {
  id: number;
  scheduleId: string;
  /** When it was due (the cron time), and when the server acted on it. */
  dueAt: IsoTime;
  ranAt: IsoTime;
  /** true for "Run now". */
  manual: boolean;
  result: ScheduleRunResult;
  taskId: string | null;
  error: string | null;
}

/** GET /api/schedules */
export interface ScheduleList {
  schedules: ScheduleView[];
}

/** GET /api/schedules/:id */
export interface ScheduleDetail extends ScheduleView {
  /** The last 50 runs, newest first. */
  runs: ScheduleRunView[];
}

/** POST /api/schedules */
export interface CreateScheduleRequest {
  title?: string;
  prompt: string;
  /** Default: the instance's default model. */
  model?: string;
  cron: string;
  /** An IANA zone, e.g. "Europe/London" (the app sends the device's own). */
  timeZone: string;
  enabled?: boolean;
}

/** PATCH /api/schedules/:id: any subset. */
export type UpdateScheduleRequest = Partial<CreateScheduleRequest>;

/** POST /api/schedules/preview: check an expression and see its next firings. */
export interface SchedulePreviewRequest {
  cron: string;
  timeZone: string;
}
export interface SchedulePreview {
  ok: boolean;
  /** Why the expression is refused (ok: false). */
  error: string | null;
  /** The next five firings, ISO, and as wall-clock text in the zone ("Mon 13 Oct 09:00"). */
  next: { at: IsoTime; local: string }[];
}

/** POST /api/schedules/:id/run */
export interface ScheduleRunNowResult {
  run: ScheduleRunView;
  task: TaskView | null;
}

/**
 * A wakeup belongs to one task: at a time (`kind: "time"`, optionally recurring with `cron`), or when
 * an HTTP check passes (`kind: "check"`), the server puts `prompt` in the task's inbox, resuming the
 * task first if it is paused; the session hands it to the task's agent as a new message once the
 * agent is not mid-turn.
 */
export interface WakeupView {
  id: string;
  taskId: string;
  userId: string;
  /** Unique per task among armed wakeups; arming the same name again replaces it. */
  name: string;
  kind: "time" | "check";
  prompt: string;
  /** check: delivered instead when the check gives up (expiry). */
  failPrompt: string | null;
  /** time: the next firing; check: the next check. */
  at: IsoTime | null;
  cron: string | null;
  timeZone: string | null;
  check: WakeupCheck | null;
  intervalSeconds: number | null;
  /** check: gives up at; recurring time: no firing after. */
  expiresAt: IsoTime | null;
  state: "armed" | "fired" | "expired" | "cancelled";
  firedAt: IsoTime | null;
  /** Last check outcome or delivery problem. */
  lastError: string | null;
  checks: number;
  createdAt: IsoTime;
  /** Who armed it: the task's agent, or its owner from the app (`POST /api/tasks/:id/wakeups`). Absent on servers before it. */
  setBy?: "task" | "owner";
}

/**
 * A condition the SERVER evaluates: one HTTPS GET to a public address (no credentials, no
 * redirects followed, 10 s, first 256 KiB). Passes when every given condition holds:
 * `status` equals, `contains` is in the body, `absent` is not in the body, `changed` (the body
 * differs from the first check's). Plain text matching only (no regular expressions on the server).
 */
export interface WakeupCheck {
  url: string;
  status?: number;
  contains?: string;
  absent?: string;
  changed?: boolean;
}

/** GET /api/wakeups */
export interface WakeupList {
  wakeups: WakeupView[];
}

/** POST /api/session/wakeups (the session, for its own task). Give `at`, `inSeconds`, `cron` or `check`. */
export interface SessionWakeupRequest {
  name?: string;
  prompt: string;
  at?: IsoTime;
  inSeconds?: number;
  cron?: string;
  /** With `cron`; default the owner's last-used zone, else UTC. */
  timeZone?: string;
  check?: WakeupCheck;
  /** check: seconds between checks (60..86400, default 300). */
  intervalSeconds?: number;
  /** check: give up after this (ISO; default 7 days, at most 30). cron: last firing before this. */
  until?: IsoTime;
  failPrompt?: string;
}

/**
 * POST /api/tasks/:id/wakeups (the task's owner, from the app): wake the task once at `at`.
 * `prompt` is what the agent gets then (default: a line saying the owner asked to be woken).
 */
export interface ArmWakeupRequest {
  at: IsoTime;
  prompt?: string;
}

/** A message waiting for the task's agent (GET /api/session/inbox). */
export interface InboxMessage {
  id: string;
  source: "wakeup";
  sourceId: string;
  text: string;
  createdAt: IsoTime;
}
export interface InboxList {
  messages: InboxMessage[];
}

/** A task's channel: what its agent posted for its owner (results, reports). */
export interface ChannelPostView {
  id: string;
  taskId: string;
  userId: string;
  title: string;
  /** Markdown, ≤ 20000 characters. */
  text: string;
  createdAt: IsoTime;
  read: boolean;
}

/** POST /api/session/posts */
export interface SessionPostRequest {
  title?: string;
  text: string;
}

/** GET /api/tasks/:id/posts */
export interface ChannelPostList {
  posts: ChannelPostView[];
}

/** One channel per task that has posts (GET /api/channels). */
export interface ChannelView {
  taskId: string;
  userId: string;
  taskTitle: string;
  taskState: TaskState;
  scheduleId: string | null;
  posts: number;
  unread: number;
  lastPost: ChannelPostView;
}
export interface ChannelList {
  channels: ChannelView[];
}

/** POST /api/tasks/:id/posts/read */
export interface MarkPostsReadResult {
  unreadPosts: number;
}

// ---- push notifications (section 16) ---------------------------------------------------------------

/**
 * What a person can switch push off for. Each notice kind maps to one: an approval_needed notice
 * about a question ("ask the boss") is `question`; the cap and budget notices are `caps`; offboarding,
 * suggestions and passkeys are `other`.
 */
export type PushKind =
  | "approval_needed"
  | "question"
  | "approval_decided"
  | "channel_post"
  | "caps"
  | "schedule_skipped"
  | "wakeup"
  | "task_failed"
  | "other";

export interface PushKindView {
  kind: PushKind;
  /** What the settings screen shows ("Approvals waiting for you"). */
  label: string;
  /** Whether the caller gets pushes of this kind (default true). */
  enabled: boolean;
}

/** One device or browser that receives the caller's pushes. */
export interface PushSubscriptionView {
  id: string;
  /** apns: the iOS app; web: a browser or a web app added to a home screen (Web Push). */
  kind: "apns" | "web";
  /** A name for the person ("iPhone · iOS 26.1", "Chrome on macOS"). */
  label: string;
  /** The paired device it belongs to (iOS), else null. Revoking the device removes it. */
  deviceId: string | null;
  createdAt: IsoTime;
  /** The last push the server sent to it, and the last one the push service accepted. */
  lastSentAt: IsoTime | null;
  lastOkAt: IsoTime | null;
  /** The push service's answer when the last send failed ("BadDeviceToken (400, production)"), else null. */
  lastError: string | null;
}

/** GET /api/push: the caller's push settings. PUT /api/push/kinds and the subscription routes answer it too. */
export interface PushSettings {
  /** The instance can send to the iOS app (APNs keys configured). */
  apns: boolean;
  /** The VAPID public key (base64url) a browser subscribes with; null = no Web Push on this instance. */
  webPushPublicKey: string | null;
  kinds: PushKindView[];
  /** The caller's own subscriptions, newest first. */
  subscriptions: PushSubscriptionView[];
}

/** PUT /api/push/kinds: switch kinds on or off; a kind left out is unchanged. */
export interface SetPushKindsRequest {
  kinds: Partial<Record<PushKind, boolean>>;
}

/**
 * POST /api/push/subscriptions. Registering an address (a Web Push endpoint or an APNs device token)
 * that is already registered moves it to the caller: the device or browser now belongs to them.
 */
export type CreatePushSubscriptionRequest =
  | {
      kind: "web";
      /** PushSubscription.endpoint: an https URL on a known push service. */
      endpoint: string;
      /** PushSubscription keys, base64url. */
      keys: { p256dh: string; auth: string };
      label?: string;
    }
  | {
      kind: "apns";
      /** The APNs device token, hex. Only from a paired device (the iOS app). */
      token: string;
      /** Which APNs environment the token belongs to (a simulator or a development build: sandbox). Default production. */
      environment?: "production" | "sandbox";
      label?: string;
    };

/** POST /api/push/test: a test push to every subscription of the caller. */
export interface PushTestResult {
  /** One entry per subscription, after the push service answered. */
  results: { id: string; ok: boolean; error: string | null }[];
}
