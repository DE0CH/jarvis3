// Wiring: build the server from config + state + providers. main.ts passes the real providers,
// tests pass fakes.
import { createServer, type Server } from "node:http";

import type { JSONWebKeySet } from "jose";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { systemClock, type Clock } from "./clock.ts";
import { Sealer } from "./crypto.ts";
import { ChannelHub } from "./channel.ts";
import { OpTracker, isAdminRole, type Ctx, type Logger, type Providers } from "./ctx.ts";
import { AccessVerifier, type ResolveDeps } from "./auth.ts";
import { defineRoutes, makeHandler, makeUpgradeHandler } from "./http.ts";
import type { WebApp } from "./web.ts";
import { onSessionConnected } from "./tasks.ts";
import { finishOffboarding, syncDirectory } from "./users.ts";
import { budgetTick, capTick, idleTick, suggestionTick } from "./ticks.ts";
import type { SyncResult } from "./api-types.ts";
import { EventEmitter } from "node:events";
import { checkActions } from "./actions/index.ts";
import { proxyTick, settleStaleReservations } from "./tools/index.ts";
import { checkToolProviders } from "./tools/registry.ts";
import { PublicHttpChecker } from "./httpcheck.ts";
import { wakeupTick } from "./wakeups.ts";
import { scheduleTick } from "./schedules.ts";

/** How long one request (a file upload's body) may take. */
export const UPLOAD_TIMEOUT_MS = 2 * 3600_000;

export interface JarvisOptions {
  config: Config;
  db: Db;
  providers: Providers;
  dbKey: string;
  sessionGateClientSecret: string;
  clock?: Clock;
  log?: Logger;
  /** Tests: a local JWKS instead of fetching the team's certs. */
  accessJwks?: JSONWebKeySet;
  snapshotPollMs?: number;
  snapshotTimeoutMs?: number;
  /** The app's web build, served at the root (null: only /api). */
  web?: WebApp | null;
  /** The actions' credentials (loadActionSecrets). */
  actionSecrets?: Record<string, Record<string, string>>;
}

export interface Jarvis {
  ctx: Ctx;
  server: Server;
  /** One pass of the background loops (idle, caps, budget). */
  tick(): Promise<void>;
  syncDirectory(): Promise<SyncResult>;
  /** Wait for every background lifecycle operation to finish. */
  settle(): Promise<void>;
  /** Start the intervals (production). */
  startLoops(): void;
  close(): Promise<void>;
}

export function createJarvis(o: JarvisOptions): Jarvis {
  const clock = o.clock ?? systemClock;
  const log: Logger = o.log ?? ((msg, extra) => console.log(JSON.stringify({ t: new Date(clock.now()).toISOString(), msg, ...extra })));
  checkActions(o.config.actions, o.actionSecrets ?? {});
  const approvalBus = new EventEmitter();
  approvalBus.setMaxListeners(0);
  const inboxBus = new EventEmitter();
  inboxBus.setMaxListeners(0);
  let ctxRef: Ctx | null = null;
  const hub = new ChannelHub({ onConnect: (taskId) => ctxRef && onSessionConnected(ctxRef, taskId) });
  const ctx: Ctx = {
    ...o.providers,
    forge: o.providers.forge ?? null,
    tools: o.providers.tools ?? { search: null, fetch: null, proxy: null },
    config: o.config,
    db: o.db,
    clock,
    sealer: new Sealer(o.dbKey),
    hub,
    ops: new OpTracker(),
    locks: new Map(),
    log,
    sessionGateClientSecret: o.sessionGateClientSecret,
    snapshotPollMs: o.snapshotPollMs ?? 3000,
    snapshotTimeoutMs: o.snapshotTimeoutMs ?? 15 * 60_000,
    actionSecrets: o.actionSecrets ?? {},
    approvalBus,
    inboxBus,
    checker: o.providers.checker ?? new PublicHttpChecker(),
    push: o.providers.push ?? null,
  };
  ctxRef = ctx;
  checkToolProviders(ctx);
  settleStaleReservations(ctx);

  const resolveDeps: ResolveDeps = {
    db: o.db,
    clock,
    verifier: new AccessVerifier({ teamDomain: o.config.access.teamDomain, audience: o.config.access.audience, clock, ...(o.accessJwks ? { jwks: o.accessJwks } : {}) }),
    sessionGateClientId: o.config.access.sessionGateClientId,
    isAdminRole: (role) => isAdminRole(o.config, role),
  };
  const routes = defineRoutes(ctx);
  const server = createServer(makeHandler(ctx, resolveDeps, routes, o.web ?? null));
  // A file upload streams through to the bucket (files.ts); Node's default of 5 minutes for a
  // whole request would cut a large file off on a slow phone link. Headers still time out at 60 s.
  server.requestTimeout = UPLOAD_TIMEOUT_MS;
  const upgrade = makeUpgradeHandler(ctx, resolveDeps);
  server.on("upgrade", (req, socket, head) => void upgrade.handler(req, socket, head));

  const timers: NodeJS.Timeout[] = [];
  let ticking = false;
  const tick = async () => {
    if (ticking) return; // one tick at a time
    ticking = true;
    try {
      idleTick(ctx);
      capTick(ctx);
      await budgetTick(ctx).catch((e: Error) => log("budget tick failed", { error: e.message }));
      await finishOffboarding(ctx).catch((e: Error) => log("offboarding retry failed", { error: e.message }));
      await suggestionTick(ctx).catch((e: Error) => log("suggestion check failed", { error: e.message }));
      await proxyTick(ctx).catch((e: Error) => log("proxy tick failed", { error: e.message }));
      // after the cap and budget checks, so a firing sees this minute's state
      await wakeupTick(ctx).catch((e: Error) => log("wakeup tick failed", { error: e.message }));
      await scheduleTick(ctx).catch((e: Error) => log("schedule tick failed", { error: e.message }));
    } finally {
      ticking = false;
    }
  };
  let syncing: Promise<SyncResult> | null = null;
  const sync = () => (syncing ??= syncDirectory(ctx).finally(() => (syncing = null)));

  return {
    ctx,
    server,
    tick,
    syncDirectory: sync,
    settle: () => ctx.ops.settle(),
    startLoops() {
      const every = (ms: number, fn: () => Promise<unknown>) => timers.push(setInterval(() => void fn().catch((e: Error) => log("loop failed", { error: e.message })), ms));
      every(60_000, tick);
      every((o.config.directory.intervalSeconds ?? 300) * 1000, sync);
      void sync();
    },
    async close() {
      for (const t of timers) clearInterval(t);
      hub.closeAll();
      upgrade.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
    },
  };
}
