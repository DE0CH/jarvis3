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
  machines: {
    kind: "fly";
    app: string;
    org: string;
    region: string;
    image: string;
    guest: { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };
    rootfsGb?: number;
  };
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
  return c;
}

export function loadConfig(path = process.env.JARVIS_CONFIG || "/etc/jarvis/config.json"): Config {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")) as Config);
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
    flyApiToken: need("FLY_API_TOKEN"),
    s3AccessKeyId: need("S3_ACCESS_KEY_ID"),
    s3SecretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
    cloudflareDeviceTokensApi: need("CF_DEVICE_TOKENS_API"),
    sessionGateClientSecret: need("SESSION_GATE_CLIENT_SECRET"),
  };
}
