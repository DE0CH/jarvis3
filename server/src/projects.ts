// Projects: git repos + a secret store, picked when a task is made, loaded into the task's machine on
// every start (create and resume) on top of the layers. Users make their own (private, never seen by
// anyone else, admins included); admins also make shared ones for chosen roles. Secret values are
// sealed at rest (AAD per project and key) and leave the server only to a machine of a task that
// picked the Project (GET /api/session/projects), never through a user-facing route and never in
// the provider's machine env.
//
// A private Project of an offboarded person stays in the DB as the organisation's record (like the
// personal layer); nobody can use it: its owner can't sign in and nobody else ever sees it.
import type { CreateProjectRequest, ProjectList, ProjectRef, ProjectRepo, ProjectRepoInput, ProjectView, SessionProjects, UpdateProjectRequest } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { isAdminRole } from "./ctx.ts";
import type { TaskRow, UserRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { tx } from "./db.ts";
import { httpError, notFound } from "./errors.ts";

export interface ProjectRow {
  id: string;
  name: string;
  description: string;
  shared: number;
  roles: string;
  owner_id: string | null;
  repos: string;
  created_at: number;
  updated_at: number;
}

interface SecretRow {
  project_id: string;
  key: string;
  value_sealed: string;
  updated_at: number;
}

export const PROJECT_LIMITS = {
  name: 80,
  description: 2000,
  repos: 10,
  secrets: 50,
  valueBytes: 16384,
  privatePerUser: 50,
  shared: 200,
  perTask: 10,
};

export const SECRET_KEY = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Names the machine sets itself (or that would change how programs run): never a Project secret. */
const RESERVED_PREFIXES = ["JARVIS_", "PASEO_", "OPENROUTER_", "OPENCODE_", "CF_ACCESS_", "LC_", "LD_", "GIT_"];
const RESERVED_KEYS = new Set(["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LANGUAGE", "TZ", "PWD", "OLDPWD", "TERM", "HOSTNAME", "SHLVL", "NODE_OPTIONS", "TMPDIR", "MAIL", "_"]);
export const reservedKey = (k: string): boolean => RESERVED_KEYS.has(k) || RESERVED_PREFIXES.some((p) => k.startsWith(p));
const REF = /^[A-Za-z0-9._/-]{1,200}$/;

const secretAad = (projectId: string, key: string) => `project:${projectId}:${key}`;

type Viewer = { user: UserRow; isAdmin: boolean };

export function getProject(ctx: Ctx, id: string): ProjectRow | null {
  return (ctx.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined) ?? null;
}

const rolesOf = (p: ProjectRow): string[] => JSON.parse(p.roles) as string[];
const reposOf = (p: ProjectRow): ProjectRepo[] => JSON.parse(p.repos) as ProjectRepo[];

/** May this person see (and use) the Project? Private: its owner only. Shared: admins, and members of its roles. */
export function visibleTo(ctx: Ctx, p: ProjectRow, u: UserRow): boolean {
  if (!p.shared) return p.owner_id === u.id;
  return isAdminRole(ctx.config, u.role) || rolesOf(p).includes(u.role);
}

function canEdit(p: ProjectRow, v: Viewer): boolean {
  return p.shared ? v.isAdmin : p.owner_id === v.user.id;
}

function secretsOf(ctx: Ctx, projectId: string): SecretRow[] {
  return ctx.db.prepare("SELECT * FROM project_secrets WHERE project_id = ? ORDER BY key").all(projectId) as unknown as SecretRow[];
}

export function projectView(ctx: Ctx, p: ProjectRow, v: Viewer): ProjectView {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    shared: !!p.shared,
    roles: p.shared ? rolesOf(p) : [],
    ownerId: p.shared ? null : p.owner_id,
    repos: reposOf(p),
    secrets: secretsOf(ctx, p.id).map((s) => ({ key: s.key, updatedAt: iso(s.updated_at) })),
    canEdit: canEdit(p, v),
    createdAt: iso(p.created_at),
    updatedAt: iso(p.updated_at),
  };
}

export function listProjects(ctx: Ctx, v: Viewer): ProjectList {
  const rows = ctx.db.prepare("SELECT * FROM projects WHERE owner_id = ? OR shared = 1 ORDER BY lower(name), created_at").all(v.user.id) as unknown as ProjectRow[];
  return {
    projects: rows.filter((p) => visibleTo(ctx, p, v.user)).map((p) => projectView(ctx, p, v)),
    ...(v.isAdmin ? { roles: Object.keys(ctx.config.roles) } : {}),
  };
}

/** The Project a route names: 404 unless the caller can see it. */
export function visibleProject(ctx: Ctx, id: string, v: Viewer): ProjectRow {
  const p = getProject(ctx, id);
  if (!p || !visibleTo(ctx, p, v.user)) throw notFound("project");
  return p;
}

/** The Project a change names: 404 unless visible, 403 if visible but not the caller's to change. */
function editableProject(ctx: Ctx, id: string, v: Viewer): ProjectRow {
  const p = visibleProject(ctx, id, v);
  if (!canEdit(p, v)) throw httpError("forbidden", p.shared ? "only an admin can change a shared project" : "only its owner can change this project");
  return p;
}

// ---- validation -----------------------------------------------------------------------------------

function checkName(name: unknown): string {
  if (typeof name !== "string" || !name.trim() || name.trim().length > PROJECT_LIMITS.name) throw httpError("bad_request", `name must be 1..${PROJECT_LIMITS.name} characters`);
  return name.trim();
}

function checkDescription(d: unknown): string {
  if (d === undefined || d === null) return "";
  if (typeof d !== "string" || d.length > PROJECT_LIMITS.description) throw httpError("bad_request", `description must be at most ${PROJECT_LIMITS.description} characters`);
  return d;
}

function checkRoles(ctx: Ctx, roles: unknown): string[] {
  if (!Array.isArray(roles) || !roles.length) throw httpError("bad_request", "a shared project needs at least one role");
  const out: string[] = [];
  for (const r of roles) {
    if (typeof r !== "string" || !ctx.config.roles[r]) throw httpError("bad_request", `roles must be the instance's roles (${Object.keys(ctx.config.roles).join(", ")})`);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

export function checkRepoUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw || raw.length > 2000) throw httpError("bad_request", "a repo url must be an https:// URL");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw httpError("bad_request", `not a URL: ${raw.slice(0, 100)}`);
  }
  if (u.protocol !== "https:" || !u.hostname) throw httpError("bad_request", "a repo url must be an https:// URL");
  if (u.username || u.password) throw httpError("bad_request", "a repo url must not carry credentials; put a token in a secret and name it in tokenSecret");
  if (u.hash || u.search) throw httpError("bad_request", "a repo url must not have a query or a fragment");
  if (!u.pathname.split("/").some((s) => s && s !== ".git")) throw httpError("bad_request", "a repo url needs a path (e.g. https://github.com/org/repo.git)");
  return raw;
}

function checkRepos(repos: unknown): ProjectRepo[] {
  if (!Array.isArray(repos) || repos.length > PROJECT_LIMITS.repos) throw httpError("bad_request", `repos must be a list of at most ${PROJECT_LIMITS.repos}`);
  return repos.map((r: ProjectRepoInput) => {
    if (!r || typeof r !== "object") throw httpError("bad_request", "each repo must be an object {url, ref?, tokenSecret?}");
    const url = checkRepoUrl(r.url);
    const ref = r.ref ?? null;
    if (ref !== null && (typeof ref !== "string" || !REF.test(ref) || ref.startsWith("-") || ref.includes(".."))) throw httpError("bad_request", "ref must be a branch or tag ([A-Za-z0-9._/-]{1,200})");
    const tokenSecret = r.tokenSecret ?? null;
    if (tokenSecret !== null && (typeof tokenSecret !== "string" || !SECRET_KEY.test(tokenSecret))) throw httpError("bad_request", "tokenSecret must be the key of one of the project's secrets");
    return { url, ref, tokenSecret };
  });
}

function checkKey(k: string): void {
  if (!SECRET_KEY.test(k)) throw httpError("bad_request", `secret key ${JSON.stringify(k.slice(0, 70))} must match ^[A-Z_][A-Z0-9_]{0,63}$`);
  if (reservedKey(k)) throw httpError("bad_request", `secret key ${k} is reserved (the machine sets it itself)`);
}

function checkValue(k: string, v: unknown): string {
  if (typeof v !== "string" || !v.length || Buffer.byteLength(v) > PROJECT_LIMITS.valueBytes) throw httpError("bad_request", `the value of ${k} must be 1..${PROJECT_LIMITS.valueBytes} bytes`);
  return v;
}

function checkTokenSecrets(repos: ProjectRepo[], keys: Set<string>): void {
  for (const r of repos) if (r.tokenSecret && !keys.has(r.tokenSecret)) throw httpError("bad_request", `tokenSecret ${r.tokenSecret} names no secret of this project`);
}

// ---- changes --------------------------------------------------------------------------------------

export function createProject(ctx: Ctx, v: Viewer, body: CreateProjectRequest): ProjectRow {
  if (!body || typeof body !== "object") throw httpError("bad_request", "body must be a project");
  const shared = body.shared === true;
  if (body.shared !== undefined && typeof body.shared !== "boolean") throw httpError("bad_request", "shared must be true or false");
  if (shared && !v.isAdmin) throw httpError("forbidden", "only an admin can make a shared project");
  const name = checkName(body.name);
  const description = checkDescription(body.description);
  let roles: string[] = [];
  if (shared) roles = checkRoles(ctx, body.roles);
  else if (body.roles !== undefined && !(Array.isArray(body.roles) && body.roles.length === 0)) throw httpError("bad_request", "roles are for shared projects only");
  const repos = checkRepos(body.repos ?? []);
  const secrets = body.secrets ?? {};
  if (typeof secrets !== "object" || Array.isArray(secrets)) throw httpError("bad_request", "secrets must be an object {KEY: value}");
  const entries = Object.entries(secrets);
  if (entries.length > PROJECT_LIMITS.secrets) throw httpError("bad_request", `at most ${PROJECT_LIMITS.secrets} secrets`);
  for (const [k, val] of entries) {
    checkKey(k);
    checkValue(k, val);
  }
  checkTokenSecrets(repos, new Set(Object.keys(secrets)));
  return tx(ctx.db, () => {
    if (shared) {
      const n = (ctx.db.prepare("SELECT count(*) AS n FROM projects WHERE shared = 1").get() as { n: number }).n;
      if (n >= PROJECT_LIMITS.shared) throw httpError("conflict", `the instance has the most shared projects it may have (${PROJECT_LIMITS.shared})`);
    } else {
      const n = (ctx.db.prepare("SELECT count(*) AS n FROM projects WHERE owner_id = ?").get(v.user.id) as { n: number }).n;
      if (n >= PROJECT_LIMITS.privatePerUser) throw httpError("conflict", `you have the most projects one person may have (${PROJECT_LIMITS.privatePerUser})`);
    }
    const id = randomId(8);
    const now = ctx.clock.now();
    ctx.db
      .prepare("INSERT INTO projects(id, name, description, shared, roles, owner_id, repos, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, name, description, shared ? 1 : 0, JSON.stringify(roles), shared ? null : v.user.id, JSON.stringify(repos), now, now);
    const ins = ctx.db.prepare("INSERT INTO project_secrets(project_id, key, value_sealed, updated_at) VALUES (?, ?, ?, ?)");
    for (const [k, val] of entries) ins.run(id, k, ctx.sealer.seal(val, secretAad(id, k)), now);
    return getProject(ctx, id)!;
  });
}

export function updateProject(ctx: Ctx, v: Viewer, id: string, body: UpdateProjectRequest): ProjectRow {
  const p = editableProject(ctx, id, v);
  if (!body || typeof body !== "object") throw httpError("bad_request", "body must be an object");
  const patch: Partial<ProjectRow> = {};
  if (body.name !== undefined) patch.name = checkName(body.name);
  if (body.description !== undefined) patch.description = checkDescription(body.description);
  if (body.roles !== undefined) {
    if (!p.shared) throw httpError("bad_request", "roles are for shared projects only");
    patch.roles = JSON.stringify(checkRoles(ctx, body.roles));
  }
  const repos = body.repos !== undefined ? checkRepos(body.repos) : reposOf(p);
  if (body.repos !== undefined) patch.repos = JSON.stringify(repos);
  const changes = body.secrets ?? {};
  if (typeof changes !== "object" || Array.isArray(changes)) throw httpError("bad_request", "secrets must be an object {KEY: value or null}");
  for (const [k, val] of Object.entries(changes)) {
    checkKey(k);
    if (val !== null) checkValue(k, val);
  }
  return tx(ctx.db, () => {
    const keys = new Set(secretsOf(ctx, p.id).map((s) => s.key));
    for (const [k, val] of Object.entries(changes)) val === null ? keys.delete(k) : keys.add(k);
    if (keys.size > PROJECT_LIMITS.secrets) throw httpError("bad_request", `at most ${PROJECT_LIMITS.secrets} secrets`);
    checkTokenSecrets(repos, keys);
    const now = ctx.clock.now();
    for (const [k, val] of Object.entries(changes)) {
      if (val === null) ctx.db.prepare("DELETE FROM project_secrets WHERE project_id = ? AND key = ?").run(p.id, k);
      else
        ctx.db
          .prepare("INSERT INTO project_secrets(project_id, key, value_sealed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, key) DO UPDATE SET value_sealed = excluded.value_sealed, updated_at = excluded.updated_at")
          .run(p.id, k, ctx.sealer.seal(val, secretAad(p.id, k)), now);
    }
    const sets = Object.keys(patch);
    ctx.db
      .prepare(`UPDATE projects SET ${[...sets.map((k) => `${k} = ?`), "updated_at = ?"].join(", ")} WHERE id = ?`)
      .run(...sets.map((k) => (patch as Record<string, string>)[k]!), now, p.id);
    return getProject(ctx, p.id)!;
  });
}

/** Tasks that picked it keep their refs; their next machine start no longer gets it. */
export function deleteProject(ctx: Ctx, v: Viewer, id: string): void {
  const p = editableProject(ctx, id, v);
  tx(ctx.db, () => {
    ctx.db.prepare("DELETE FROM project_secrets WHERE project_id = ?").run(p.id);
    ctx.db.prepare("DELETE FROM projects WHERE id = ?").run(p.id);
  });
}

// ---- tasks ------------------------------------------------------------------------------------------

export const taskProjectRefs = (t: TaskRow): ProjectRef[] => (t.projects ? (JSON.parse(t.projects) as ProjectRef[]) : []);

/** POST /api/tasks `projects`: ids visible to the creator, at most 10, no clashing secret. */
export function checkTaskProjects(ctx: Ctx, user: UserRow, ids: unknown): ProjectRef[] {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > PROJECT_LIMITS.perTask) throw httpError("bad_request", `projects must be a list of at most ${PROJECT_LIMITS.perTask} project ids`);
  const rows: ProjectRow[] = [];
  for (const id of ids) {
    const p = typeof id === "string" ? getProject(ctx, id) : null;
    if (!p || !visibleTo(ctx, p, user)) throw httpError("bad_request", `no such project: ${String(id).slice(0, 40)}`);
    if (!rows.some((r) => r.id === p.id)) rows.push(p);
  }
  mergeEnv(ctx, rows);
  return rows.map((p) => ({ id: p.id, name: p.name }));
}

/**
 * The secrets of these Projects as one env. The same key with different values in two of them is
 * refused (400 naming the key and both Projects); the same value twice is fine.
 */
function mergeEnv(ctx: Ctx, rows: ProjectRow[]): { env: Record<string, string>; byProject: Map<string, Record<string, string>> } {
  const env: Record<string, string> = {};
  const from: Record<string, ProjectRow> = {};
  const byProject = new Map<string, Record<string, string>>();
  for (const p of rows) {
    const own: Record<string, string> = {};
    for (const s of secretsOf(ctx, p.id)) {
      const val = ctx.sealer.open(s.value_sealed, secretAad(p.id, s.key));
      own[s.key] = val;
      if (s.key in env && env[s.key] !== val) {
        throw httpError("bad_request", `the secret ${s.key} has different values in the projects "${from[s.key]!.name}" and "${p.name}"; change one of them or pick only one`);
      }
      env[s.key] = val;
      from[s.key] ??= p;
    }
    byProject.set(p.id, own);
  }
  return { env, byProject };
}

/**
 * The task's Projects as they are now: the ones it picked that still exist and its owner can still
 * see (a deleted one, or a shared one no longer open to the owner's role, is left out).
 */
function currentProjects(ctx: Ctx, task: TaskRow): ProjectRow[] {
  const owner = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(task.user_id) as unknown as UserRow;
  const out: ProjectRow[] = [];
  for (const ref of taskProjectRefs(task)) {
    const p = getProject(ctx, ref.id);
    if (p && visibleTo(ctx, p, owner)) out.push(p);
  }
  return out;
}

/** Before a machine starts: throws (naming the key) if the Projects' secrets clash now. */
export function checkStartable(ctx: Ctx, task: TaskRow): void {
  try {
    mergeEnv(ctx, currentProjects(ctx, task));
  } catch (e) {
    throw new Error((e as Error).message);
  }
}

/** The folder name for a repo: the URL's last path segment without .git, safe and unique. */
export function repoDir(url: string, taken: Set<string>): string {
  const seg =
    new URL(url).pathname
      .split("/")
      .filter(Boolean)
      .at(-1)
      ?.replace(/\.git$/, "") ?? "";
  let base = seg.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 100) || "repo";
  if (base === "attachments") base = "attachments-repo"; // the first prompt's attachments folder
  let dir = base;
  for (let i = 2; taken.has(dir.toLowerCase()); i++) dir = `${base}-${i}`;
  taken.add(dir.toLowerCase());
  return dir;
}

/** GET /api/session/projects. */
export function sessionProjects(ctx: Ctx, task: TaskRow): SessionProjects {
  const rows = currentProjects(ctx, task);
  let merged;
  try {
    merged = mergeEnv(ctx, rows);
  } catch (e) {
    throw httpError("conflict", (e as Error).message);
  }
  const taken = new Set<string>();
  return {
    projects: rows.map((p) => {
      const own = merged.byProject.get(p.id)!;
      return {
        id: p.id,
        name: p.name,
        repos: reposOf(p).map((r) => ({
          url: r.url,
          ref: r.ref,
          dir: repoDir(r.url, taken),
          ...(r.tokenSecret && own[r.tokenSecret] !== undefined ? { token: own[r.tokenSecret]!, tokenEnv: r.tokenSecret } : {}),
        })),
        secrets: Object.keys(own).sort(),
      };
    }),
    env: merged.env,
  };
}
