// The outside world, behind small interfaces: production implementations live next to this file
// (fly.ts, s3.ts, openrouter.ts, directory-google.ts, cloudflare-devices.ts, orgenv-git.ts), and
// in-memory fakes in fakes/ for tests and local runs.

// ---- session machines ---------------------------------------------------------------------

export interface MachineSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  metadata: Record<string, string>;
  guest: { cpu_kind: "shared" | "performance"; cpus: number; memory_mb: number };
}

export type MachineState = "created" | "starting" | "started" | "stopping" | "stopped" | "destroying" | "destroyed" | "failed";

export interface MachineInfo {
  id: string;
  name: string;
  state: MachineState;
  metadata: Record<string, string>;
  guest: MachineSpec["guest"];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface MachineProvider {
  /** Create a machine (not started). */
  create(spec: MachineSpec): Promise<MachineInfo>;
  start(id: string): Promise<void>;
  /** Destroy (force). Destroying an already-gone machine is not an error. */
  destroy(id: string): Promise<void>;
  /** Run a command in a started machine. Short commands only (Fly cuts exec off at ~60 s). */
  exec(id: string, command: string[], timeoutSeconds?: number): Promise<ExecResult>;
  /** Every machine of the instance's session app. */
  list(): Promise<MachineInfo[]>;
}

// ---- blob storage (snapshots, archives) -----------------------------------------------------

export interface BlobStore {
  put(key: string, body: Uint8Array | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  copy(fromKey: string, toKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** A URL the session machine can PUT the object to, without holding storage credentials. */
  presignPut(key: string, expiresSeconds: number): Promise<string>;
  presignGet(key: string, expiresSeconds: number): Promise<string>;
}

// ---- OpenRouter keys ----------------------------------------------------------------------------

export interface MintedKey {
  hash: string;
  key: string;
}

export interface KeyProvisioner {
  /** Create a key whose credit limit resets every calendar month (limit null = no limit). */
  create(name: string, limitUsd: number | null): Promise<MintedKey>;
  setLimit(hash: string, limitUsd: number | null): Promise<void>;
  /** Deleting an already-gone key is not an error. */
  delete(hash: string): Promise<void>;
}

// ---- directory (identity provider) ----------------------------------------------------------------

export interface DirectoryUser {
  email: string;
  name: string;
  suspended: boolean;
  /** Group emails the user is a (direct or derived) member of, among the mapped groups only. */
  groups: string[];
  /** Static directories name the role directly. */
  role?: string;
}

export interface DirectoryProvider {
  listUsers(): Promise<DirectoryUser[]>;
}

// ---- device service tokens (Cloudflare Access) -----------------------------------------------------

export interface ServiceToken {
  id: string;
  clientId: string;
  clientSecret: string;
}

export interface DeviceTokenIssuer {
  mint(name: string): Promise<ServiceToken>;
  /** Deleting an already-gone token is not an error. */
  revoke(id: string): Promise<void>;
}

// ---- org-env repo ------------------------------------------------------------------------------------

export interface OrgEnvSource {
  /** The pinned commit sessions load. */
  commit(): string;
  /** Every file at the pinned commit: path -> bytes. */
  files(): Promise<Map<string, Uint8Array>>;
  /** The tree at the pinned commit as an uncompressed tar. */
  archive(): Promise<Uint8Array>;
}

// ---- org-env pull requests ("Suggest for everyone") ---------------------------------------------------

/** Read access to the base branch's tree while a change is being built. */
export interface ForgeBase {
  /** A file's text at the base, or null when it doesn't exist. */
  read(path: string): Promise<string | null>;
  /** Every file path at the base under `prefix` (e.g. "skills/invoices/"). */
  list(prefix: string): Promise<string[]>;
}

export interface PullRequestSpec {
  /** New branch name (must not exist). */
  branch: string;
  title: string;
  body: string;
  /** Commit message. */
  message: string;
  /** Build the change from the base: path -> new text, or null to delete the file. */
  edit(base: ForgeBase): Promise<Record<string, string | null>>;
}

export type PullRequestState = "open" | "merged" | "closed";

export interface OrgEnvForge {
  /** Branch from the base branch, commit the edit, open a pull request. Throws on an empty change. */
  openPullRequest(spec: PullRequestSpec): Promise<{ number: number; url: string }>;
  pullRequestState(number: number): Promise<PullRequestState>;
}
