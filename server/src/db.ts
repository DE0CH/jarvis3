// Instance state: one SQLite file (node:sqlite). Schema migrations are applied in order at open,
// tracked in PRAGMA user_version. Replication to the bucket is deployment config (docs/DEPLOY.md).
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','suspended','removed')),
    openrouter_limit_override REAL,          -- USD; NULL = role default
    openrouter_limit_override_set INTEGER NOT NULL DEFAULT 0,
    machine_hours_override REAL,
    machine_hours_override_set INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status_changed_at INTEGER NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL UNIQUE,         -- the Access service token's client id (JWT common_name)
    service_token_id TEXT NOT NULL,         -- to delete it at Cloudflare
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    revoked_at INTEGER
  );
  CREATE INDEX devices_user ON devices(user_id);
  CREATE TABLE openrouter_keys (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    hash TEXT NOT NULL,                     -- OpenRouter's key id
    key_sealed TEXT NOT NULL,               -- the key itself, AES-GCM with the server key
    limit_usd REAL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL,
    paused_reason TEXT,
    error TEXT,
    machine_id TEXT,
    session_token_hash TEXT,                -- sha256 of the live machine's session token
    daemon_password_sealed TEXT NOT NULL,
    request_id TEXT,
    has_snapshot INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    idle_since INTEGER,
    UNIQUE (user_id, request_id)
  );
  CREATE INDEX tasks_user ON tasks(user_id);
  CREATE INDEX tasks_token ON tasks(session_token_hash);
  CREATE TABLE machine_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    machine_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER
  );
  CREATE INDEX runs_user ON machine_runs(user_id);
  CREATE TABLE personal_layers (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    data TEXT NOT NULL,                     -- JSON {instructions, skills, notes}
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE personal_layer_versions (
    user_id TEXT NOT NULL REFERENCES users(id),
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, version)
  );
  CREATE TABLE notices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    task_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notices_user ON notices(user_id);
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: the task's main agent (reported by the session), and read marks on notices
  `
  ALTER TABLE tasks ADD COLUMN agent_id TEXT;
  ALTER TABLE notices ADD COLUMN read_at INTEGER;
  `,
  // 3: "Suggest for everyone" pull requests on the org-env repo
  `
  CREATE TABLE suggestions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),  -- whose personal layer the suggestion came from
    by_user_id TEXT NOT NULL REFERENCES users(id), -- who pressed the button (the owner or an admin)
    kind TEXT NOT NULL CHECK (kind IN ('skill','instructions','note')),
    name TEXT NOT NULL,                     -- the skill name, the note id, or '' for instructions
    title TEXT NOT NULL,
    branch TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    pr_url TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open','merged','closed')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
  );
  CREATE INDEX suggestions_user ON suggestions(user_id);
  `,
  // 4: actions and approvals (the queue, access grants), passkeys for Tier 3 approvals
  `
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id),
    user_id TEXT NOT NULL REFERENCES users(id),   -- the task's owner (on whose behalf it is asked)
    kind TEXT NOT NULL CHECK (kind IN ('action','guard','access','question')),
    approver TEXT NOT NULL CHECK (approver IN ('auto','self','admin','owner')),
    state TEXT NOT NULL CHECK (state IN ('pending','approved','executing','done','failed','denied','cancelled')),
    action TEXT,                                  -- action name, or guard rule id
    payload TEXT NOT NULL,                        -- JSON: the call's parameters, the guarded input, the question
    preview TEXT NOT NULL,                        -- JSON ApprovalPreview
    reason TEXT NOT NULL DEFAULT '',
    options TEXT,                                 -- JSON string[] (questions)
    change_hash TEXT,                             -- Tier 3: sha256 of the canonical change
    decided_by TEXT REFERENCES users(id),
    decided_at INTEGER,
    decision_note TEXT,
    grant_scope TEXT,
    passkey_proof TEXT,                           -- Tier 3: JSON of the WebAuthn assertion that approved it
    result TEXT,                                  -- JSON
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX approvals_task ON approvals(task_id);
  CREATE INDEX approvals_user ON approvals(user_id);
  CREATE INDEX approvals_state ON approvals(state);
  CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('task','role')),
    task_id TEXT REFERENCES tasks(id),
    role TEXT,
    granted_by TEXT NOT NULL REFERENCES users(id),
    approval_id TEXT REFERENCES approvals(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX grants_action ON grants(action);
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,                          -- credential id, base64url
    user_id TEXT NOT NULL REFERENCES users(id),
    public_key TEXT NOT NULL,                     -- COSE public key, base64url
    counter INTEGER NOT NULL,
    transports TEXT NOT NULL DEFAULT '[]',
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);
  CREATE TABLE webauthn_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    purpose TEXT NOT NULL CHECK (purpose IN ('register','approve')),
    approval_id TEXT REFERENCES approvals(id),
    challenge TEXT NOT NULL,                      -- base64url
    expires_at INTEGER NOT NULL
  );
  `,
  // 5: Tier 0 tools: per-user caps, the metering ledger, per-user proxy sub-accounts
  `
  ALTER TABLE users ADD COLUMN tools_limit_override REAL;          -- USD/month; NULL with _set = no cap
  ALTER TABLE users ADD COLUMN tools_limit_override_set INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN proxy_limit_override REAL;          -- GB/month
  ALTER TABLE users ADD COLUMN proxy_limit_override_set INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE tool_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    task_id TEXT,
    tool TEXT NOT NULL CHECK (tool IN ('search','fetch','proxy')),
    provider TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved','done','failed')),
    cost_usd REAL NOT NULL,                  -- reserved: the most it can cost; done: what it cost
    bytes INTEGER NOT NULL DEFAULT 0,        -- relayed proxy traffic, both directions
    month TEXT NOT NULL,                     -- YYYY-MM (UTC) it counts against
    created_at INTEGER NOT NULL
  );
  CREATE INDEX tool_usage_user_month ON tool_usage(user_id, month);
  CREATE INDEX tool_usage_month ON tool_usage(month);
  CREATE TABLE proxy_users (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    provider TEXT NOT NULL,
    remote_id TEXT NOT NULL,                 -- the provider's sub-account id
    login_sealed TEXT NOT NULL,              -- JSON {username, password}, AES-GCM with the server key
    month TEXT NOT NULL,                     -- the month the allocation below was made for
    allocated_gb REAL,                       -- the cap in force when allocated (NULL = no cap)
    baseline_gb REAL NOT NULL DEFAULT 0,     -- the provider's used counter at the month's start
    used_gb REAL NOT NULL DEFAULT 0,         -- used this month, last read from the provider
    checked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL"); // Litestream needs WAL
    db.exec("PRAGMA busy_timeout = 5000");
  }
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let v = row.user_version;
  while (v < MIGRATIONS.length) {
    const sql = MIGRATIONS[v]!;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    v++;
  }
  return v;
}

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Run fn in a transaction (synchronous: node:sqlite is synchronous, so nothing interleaves). */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function kvGet<T>(db: Db, key: string): T | null {
  const r = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return r ? (JSON.parse(r.value) as T) : null;
}
export function kvSet(db: Db, key: string, value: unknown): void {
  db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}
