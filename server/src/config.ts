// Instance configuration: a JSON file (path in JARVIS_CONFIG) for everything that is not a secret,
// plus secrets from environment variables. docs/CONFIG.md documents every field; the instance's
// own deploy repo holds the file, never this repo.
import { readFileSync } from "node:fs";

export interface RoleConfig {
  /** Monthly OpenRouter credit limit for a user of this role, USD. null = no limit. */
  openrouterMonthlyUsd: number | null;
  /** Monthly machine-hour cap. null = no cap. */
  machineHoursPerMonth: number | null;
  /** May act on every user's resources. Exactly the roles with admin: true are admins. */
  admin?: boolean;
  /**
   * Tier 0 web tools: monthly cap on search + fetch spend, USD. null = no cap. Required (a number or
   * an explicit null) on every role once `tools.search` or `tools.fetch` is configured.
   */
  toolsMonthlyUsd?: number | null;
  /** Tier 0 proxies: monthly traffic cap, GB. null = no cap. Required on every role once `tools.proxy` is configured. */
  proxyMonthlyGb?: number | null;
}

export interface ModelConfig {
  id: string;
  label: string;
}

export type DirectoryConfig =
  | {
      kind: "google";
      /** The Workspace domain whose users are listed. */
      domain: string;
      /** An admin user the read-only service account impersonates (domain-wide delegation). */
      subject: string;
      /** group email -> role; a user in several mapped groups gets the first role listed in `roles` order. */
      groupRoles: Record<string, string>;
      /** Poll interval, seconds (default 300). */
      intervalSeconds?: number;
    }
  | {
      kind: "static";
      /** For a tiny instance (one person) or a bootstrap: the member list itself. */
      users: { email: string; name?: string; role: string; suspended?: boolean }[];
      intervalSeconds?: number;
    };

export type GuestConfig = { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };

/** Production: Fly Machines, one app per instance. */
export interface FlyMachinesConfig {
  kind: "fly";
  app: string;
  org: string;
  region: string;
  image: string;
  guest: GuestConfig;
  rootfsGb?: number;
}

/** CI and local runs: containers on the local Docker Engine (server/src/docker.ts). */
export interface DockerMachinesConfig {
  kind: "docker";
  image: string;
  guest: GuestConfig;
  /** Default /var/run/docker.sock. */
  socketPath?: string;
  network?: string;
  /** Env set in every machine, e.g. JARVIS_URL as the containers reach this server. */
  envOverrides?: Record<string, string>;
  extraHosts?: string[];
}

/**
 * "Suggest for everyone": the server opens pull requests on the org-env repo. Its credential is
 * either a token (GITHUB_SUGGEST_TOKEN, scoped to that one repo: contents + pull requests write) or
 * a GitHub App installed on that repo only (GITHUB_APP_PRIVATE_KEY; the installation token the
 * server mints is narrowed to the repo and those two permissions).
 */
export interface SuggestionsConfig {
  kind: "github";
  /** "owner/name" of the org-env repo. */
  repo: string;
  /** Branch the pull requests target (default "main"). */
  baseBranch?: string;
  /** Default https://api.github.com (a GitHub Enterprise Server: https://<host>/api/v3). */
  apiUrl?: string;
  auth: { kind: "token" } | { kind: "app"; appId: string; installationId: string };
}

/**
 * One named action of the broker (docs/ACTIONS.md). Its credentials (Tier 2) stay on the server:
 * `credentials` names environment variables, read at start-up, never sent anywhere.
 */
export interface ActionConfig {
  /** A built-in action type: "smtp.send", "instance.set_budget" (server/src/actions/). */
  type: string;
  label: string;
  description?: string;
  /** Roles whose sessions may use it ("*" = every role). Others file an access request. */
  roles: string[];
  /** Who approves when no auto rule matches. Tier 3 types always need the owner. Default "admin". */
  approval?: "auto" | "self" | "admin";
  /**
   * Auto-approval rules (either one suffices):
   *  allowList: every subject of the call (e.g. each email recipient) matches one entry
   *             ("x@example.org" exactly, or "*@example.org" for a whole domain);
   *  below:     the call's amount is under this number.
   */
  auto?: { allowList?: string[]; below?: number };
  /** Type-specific settings (an SMTP host, a sender address). */
  settings?: Record<string, unknown>;
  /** Credential name -> environment variable holding it (e.g. {"password": "SMTP_SUPPORT_PASSWORD"}). */
  credentials?: Record<string, string>;
}

/**
 * One Tier 0 provider. `provider` picks the adapter (server/src/tools/registry.ts); `credential`
 * names the environment variable holding the organisation's key (read at start-up, never sent to a
 * machine); `baseUrl` replaces the provider's API origin (tests and stubs); `pricing` overrides the
 * adapter's list prices (what one call is charged against a user's cap); `settings` are adapter
 * specific.
 */
export interface ToolProviderConfig {
  provider: string;
  credential?: string;
  baseUrl?: string;
  pricing?: ToolPricing;
  settings?: Record<string, unknown>;
}

export interface ToolPricing {
  /** USD per call (search providers priced per request). */
  perCallUsd?: number;
  /** USD per provider credit (ScrapingBee-style credit plans). */
  perCreditUsd?: number;
  /** USD per GB (proxies). */
  perGbUsd?: number;
}

/** Tier 0 tools. Absent (or a kind left out): that tool is off on this instance. */
export interface ToolsConfig {
  search?: ToolProviderConfig;
  fetch?: ToolProviderConfig;
  proxy?: ToolProviderConfig;
  /** Instance-wide monthly cap on search + fetch spend, USD (null/absent = none beyond the per-user caps). */
  monthlyUsd?: number | null;
}

export interface Config {
  instanceName: string;
  /** https://<instance host> — no trailing slash. Sessions reach the server here. */
  publicUrl: string;
  access: {
    /** e.g. "example.cloudflareaccess.com" */
    teamDomain: string;
    /** The Access application's AUD tag. */
    audience: string;
    /** Client id of the ONE service token sessions use to pass Access. It identifies no user. */
    sessionGateClientId: string;
  };
  directory: DirectoryConfig;
  /** Emails that are admins whatever their groups say (bootstrap); suspension still wins. */
  bootstrapAdmins: string[];
  /** Role name -> settings. Order matters: it is the precedence when a user is in several groups. */
  roles: Record<string, RoleConfig>;
  models: ModelConfig[];
  defaultModel: string;
  machines: FlyMachinesConfig | DockerMachinesConfig;
  storage: {
    kind: "s3";
    endpoint: string; // e.g. https://fsn1.your-objectstorage.com
    region: string;
    bucket: string;
  };
  orgEnv: {
    /** Local bare mirror of the org-env repo (the deploy keeps it fetched). */
    mirrorPath: string;
    /** The pinned commit every new session loads. */
    commit: string;
  };
  /** Paseo daemon WebSocket path inside the session (where the channel agent opens the proxied socket). */
  daemonPath: string;
  /** Auto-pause after this many minutes reported idle (0 = off). */
  idleMinutes: number;
  /** Instance-wide machine spend guard, USD per calendar month (0/null = off). */
  budget: { monthlyUsd: number | null; warnUsd?: number | null };
  devices: {
    /** URL scheme of the app that receives the pairing answer, e.g. "jarvis3". */
    appScheme: string;
    /** Cloudflare account that holds the device service tokens. */
    cloudflareAccountId: string;
  };
  /** Snapshot/restore presigned URL lifetime, seconds (default 3600). */
  presignSeconds?: number;
  /** Absent: the "Suggest for everyone" button is off. */
  suggestions?: SuggestionsConfig;
  /** The instance's owner (an admin's email): the only person who approves Tier 3 changes, with a passkey. */
  owner?: string;
  /** The broker's named actions (Tier 2 and 3), by name ([a-z0-9_]{1,64}). */
  actions?: Record<string, ActionConfig>;
  /** Tier 0 tools: web search, page fetching, proxies (docs/TOOLS.md). */
  tools?: ToolsConfig;
}

/** Secrets come only from the environment. */
export interface Secrets {
  /** 32 bytes base64: encrypts key material and daemon passwords at rest. */
  dbKey: string;
  openrouterManagementKey: string;
  flyApiToken: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  /** Google service account JSON (only with directory.kind = google). */
  googleServiceAccountJson: string;
  /** Cloudflare API token scoped to Access: Service Tokens (device pairing). */
  cloudflareDeviceTokensApi: string;
  /** The session gate service token's secret, handed to every session machine. */
  sessionGateClientSecret: string;
  /** suggestions.auth.kind = token: a token for the org-env repo only. */
  githubSuggestToken: string;
  /** suggestions.auth.kind = app: the GitHub App's private key (PEM). */
  githubAppPrivateKey: string;
}

export function validateConfig(c: Config): Config {
  const fail = (m: string): never => {
    throw new Error(`config: ${m}`);
  };
  if (!c.instanceName) fail("instanceName is required");
  if (!/^https:\/\/[^/]+$/.test(c.publicUrl || "")) fail("publicUrl must be https://host with no path");
  if (!c.access?.teamDomain || !c.access.audience || !c.access.sessionGateClientId) fail("access.teamDomain, audience and sessionGateClientId are required");
  if (!c.roles || !Object.keys(c.roles).length) fail("roles must name at least one role");
  if (!Object.values(c.roles).some((r) => r.admin)) fail("at least one role must have admin: true");
  if (!c.models?.length) fail("models must list at least one model");
  if (!c.models.some((m) => m.id === c.defaultModel)) fail("defaultModel must be one of models");
  if (c.directory.kind === "google") {
    for (const r of Object.values(c.directory.groupRoles)) if (!c.roles[r]) fail(`directory.groupRoles names unknown role ${r}`);
  } else {
    for (const u of c.directory.users) if (!c.roles[u.role]) fail(`directory.users names unknown role ${u.role}`);
  }
  if (!c.daemonPath?.startsWith("/")) fail("daemonPath must start with /");
  if (c.machines?.kind !== "fly" && c.machines?.kind !== "docker") fail("machines.kind must be fly or docker");
  if (!c.machines.image) fail("machines.image is required");
  if (c.suggestions) {
    const sg = c.suggestions;
    if (sg.kind !== "github") fail("suggestions.kind must be github");
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sg.repo || "")) fail("suggestions.repo must be owner/name");
    if (sg.apiUrl !== undefined && !/^https?:\/\/[^\s]+[^/]$/.test(sg.apiUrl)) fail("suggestions.apiUrl must be a URL with no trailing slash");
    if (sg.auth?.kind === "app") {
      if (!/^\d+$/.test(String(sg.auth.appId)) || !/^\d+$/.test(String(sg.auth.installationId))) fail("suggestions.auth needs numeric appId and installationId");
    } else if (sg.auth?.kind !== "token") fail("suggestions.auth.kind must be token or app");
  }
  if (c.owner !== undefined && !/^[^@\s]+@[^@\s]+$/.test(c.owner)) fail("owner must be an email");
  for (const [name, a] of Object.entries(c.actions ?? {})) {
    if (!/^[a-z0-9_]{1,64}$/.test(name)) fail(`actions: bad name ${name}`);
    if (!a.type || !a.label) fail(`actions.${name}: type and label are required`);
    if (!Array.isArray(a.roles)) fail(`actions.${name}: roles must be a list`);
    for (const r of a.roles) if (r !== "*" && !c.roles[r]) fail(`actions.${name}: unknown role ${r}`);
    if (a.approval !== undefined && !["auto", "self", "admin"].includes(a.approval)) fail(`actions.${name}: approval must be auto, self or admin`);
  }
  validateTools(c, fail);
  return c;
}

const capOk = (v: unknown): boolean => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function validateTools(c: Config, fail: (m: string) => never): void {
  const t = c.tools;
  if (!t) return;
  for (const kind of ["search", "fetch", "proxy"] as const) {
    const p = t[kind];
    if (!p) continue;
    if (!p.provider || typeof p.provider !== "string") fail(`tools.${kind}.provider is required`);
    if (p.credential !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(p.credential)) fail(`tools.${kind}.credential must name an environment variable`);
    if (p.baseUrl !== undefined && !/^https?:\/\/[^\s]+[^/]$/.test(p.baseUrl)) fail(`tools.${kind}.baseUrl must be a URL with no trailing slash`);
    for (const [k, v] of Object.entries(p.pricing ?? {})) if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) fail(`tools.${kind}.pricing.${k} must be a number ≥ 0`);
  }
  if (t.monthlyUsd !== undefined && !capOk(t.monthlyUsd)) fail("tools.monthlyUsd must be a number ≥ 0 or null");
  for (const [name, r] of Object.entries(c.roles)) {
    // a cap must be chosen on purpose: a forgotten field must not mean "no limit"
    if ((t.search || t.fetch) && (!("toolsMonthlyUsd" in r) || !capOk(r.toolsMonthlyUsd))) fail(`roles.${name}.toolsMonthlyUsd must be set (a number ≥ 0, or null for no cap) when tools.search or tools.fetch is configured`);
    if (t.proxy && (!("proxyMonthlyGb" in r) || !capOk(r.proxyMonthlyGb))) fail(`roles.${name}.proxyMonthlyGb must be set (a number ≥ 0, or null for no cap) when tools.proxy is configured`);
  }
}

/** Tier 0 provider credentials, from the environment variables the config names. Missing = refuse to start. */
export function loadToolSecrets(c: Config, env: NodeJS.ProcessEnv = process.env): Partial<Record<"search" | "fetch" | "proxy", string>> {
  const out: Partial<Record<"search" | "fetch" | "proxy", string>> = {};
  for (const kind of ["search", "fetch", "proxy"] as const) {
    const v = c.tools?.[kind]?.credential;
    if (!v) continue;
    const val = env[v];
    if (!val) throw new Error(`missing secret env ${v} (tools.${kind}.credential)`);
    out[kind] = val;
  }
  return out;
}

export function loadConfig(path = process.env.JARVIS_CONFIG || "/etc/jarvis/config.json"): Config {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")) as Config);
}

/** The actions' credentials, from the environment variables the config names. Missing = refuse to start. */
export function loadActionSecrets(c: Config, env: NodeJS.ProcessEnv = process.env): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [name, a] of Object.entries(c.actions ?? {})) {
    const creds: Record<string, string> = {};
    for (const [cred, v] of Object.entries(a.credentials ?? {})) {
      const val = env[v];
      if (!val) throw new Error(`missing secret env ${v} (credential ${cred} of action ${name})`);
      creds[cred] = val;
    }
    out[name] = creds;
  }
  return out;
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing secret env ${k}`);
    return v;
  };
  return {
    dbKey: need("JARVIS_DB_KEY"),
    openrouterManagementKey: need("OPENROUTER_MANAGEMENT_KEY"),
    flyApiToken: env.FLY_API_TOKEN || "", // required with machines.kind = fly (checked in main.ts)
    s3AccessKeyId: need("S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    cloudflareDeviceTokensApi: need("CF_DEVICE_TOKENS_API"),
    sessionGateClientSecret: need("SESSION_GATE_CLIENT_SECRET"),
    githubSuggestToken: env.GITHUB_SUGGEST_TOKEN || "", // with suggestions.auth.kind = token (checked in main.ts)
    githubAppPrivateKey: env.GITHUB_APP_PRIVATE_KEY || "", // with suggestions.auth.kind = app
  };
}
