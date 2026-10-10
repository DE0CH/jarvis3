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
