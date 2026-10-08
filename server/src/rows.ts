// Row shapes of db.ts tables (as node:sqlite returns them).
import type { TaskState, UserStatus } from "./api-types.ts";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: UserStatus;
  openrouter_limit_override: number | null;
  openrouter_limit_override_set: number;
  machine_hours_override: number | null;
  machine_hours_override_set: number;
  created_at: number;
  updated_at: number;
  status_changed_at: number;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  model: string;
  client_id: string;
  service_token_id: string;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  model: string;
  state: TaskState;
  paused_reason: string | null;
  error: string | null;
  machine_id: string | null;
  session_token_hash: string | null;
  daemon_password_sealed: string;
  request_id: string | null;
  has_snapshot: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  idle_since: number | null;
}

export interface KeyRow {
  user_id: string;
  hash: string;
  key_sealed: string;
  limit_usd: number | null;
  created_at: number;
}
