// What every service gets: config, state, clock and the outside world.
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import type { Clock } from "./clock.ts";
import type { Sealer } from "./crypto.ts";
import type { BlobStore, DeviceTokenIssuer, DirectoryProvider, HttpChecker, KeyProvisioner, MachineProvider, OrgEnvForge, OrgEnvSource } from "./providers.ts";
import type { ChannelHub } from "./channel.ts";
import type { NoticeView } from "./api-types.ts";
import { randomId } from "./crypto.ts";
import type { EventEmitter } from "node:events";
import type { ToolProviders } from "./tools/types.ts";

export interface Providers {
  machines: MachineProvider;
  blobs: BlobStore;
  keys: KeyProvisioner;
  directory: DirectoryProvider;
  deviceTokens: DeviceTokenIssuer;
  orgEnv: OrgEnvSource;
  /** null: "Suggest for everyone" is not set up on this instance. */
  forge?: OrgEnvForge | null;
  /** Tier 0 tools (tools/registry.ts builds them from config). Absent: none. */
  tools?: ToolProviders;
  /** Condition wakeups' HTTP checks (default: PublicHttpChecker, public HTTPS only). */
  checker?: HttpChecker;
}

export type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export interface Ctx extends Omit<Providers, "tools"> {
  tools: ToolProviders;
  config: Config;
  db: Db;
  clock: Clock;
  sealer: Sealer;
  hub: ChannelHub;
  ops: OpTracker;
  /** Lifecycle lock per task: one operation at a time. */
  locks: Map<string, { kind: "creating" | "pausing" | "resuming" | "destroying"; since: number }>;
  log: Logger;
  /** The session gate service token secret, passed to session machines. */
  sessionGateClientSecret: string;
  /** Snapshot status poll interval (ms) and overall timeout (ms). */
  snapshotPollMs: number;
  snapshotTimeoutMs: number;
  /** Each action's Tier 2 credentials (action name -> credential name -> value). Never leaves the server. */
  actionSecrets: Record<string, Record<string, string>>;
  /** Emits the approval id whenever an approval changes (the sessions' long polls wait on it). */
  approvalBus: EventEmitter;
  /** Emits the task id whenever a message lands in a task's inbox (the sessions' long polls wait on it). */
  inboxBus: EventEmitter;
  checker: HttpChecker;
}

export const isAdminRole = (config: Config, role: string): boolean => !!config.roles[role]?.admin;

/** Background operations (lifecycle jobs), so tests and shutdown can wait for them. */
export class OpTracker {
  readonly #pending = new Set<Promise<unknown>>();
  run(p: Promise<unknown>, log: Logger, what: string): void {
    const tracked = p.catch((e: unknown) => log(`${what} failed`, { error: e instanceof Error ? e.message : String(e) }));
    this.#pending.add(tracked);
    void tracked.finally(() => this.#pending.delete(tracked));
  }
  /** Resolves once nothing is running (including operations started meanwhile). */
  async settle(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending]);
  }
}

export function addNotice(ctx: Ctx, userId: string, kind: NoticeView["kind"], text: string, taskId: string | null = null, approvalId: string | null = null): void {
  ctx.db
    .prepare("INSERT INTO notices(id, user_id, kind, text, task_id, approval_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomId(), userId, kind, text, taskId, approvalId, ctx.clock.now());
}
