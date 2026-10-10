// Push notifications for notices (docs/API.md section 16): the iOS app through APNs, browsers and
// home-screen web apps through Web Push. A push carries no private content: a fixed title for its
// kind, a fixed body, the unread count as the badge, and ids the app uses to open the right
// screen after it has fetched the notice itself.
//
// Each notice goes only to the subscriptions of the notice's own user, and only for the kinds that
// user has left on. Sending is in the background (ctx.ops): a slow push service never holds up the
// request that made the notice.
import { Agent } from "node:https";
import webpush from "web-push";
import type { CreatePushSubscriptionRequest, NoticeView, PushKind, PushKindView, PushSettings, PushSubscriptionView, PushTestResult, SetPushKindsRequest } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { ApnsClient, type ApnsEnvironment } from "./apns.ts";
import { DEFAULT_PUSH_HOSTS, type Config } from "./config.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { httpError } from "./errors.ts";
import { unreadCount } from "./notices.ts";

// ---- the senders (the outside world) --------------------------------------------------------------

export interface PushTarget {
  kind: "apns" | "web";
  /** The APNs token, or the Web Push endpoint. */
  address: string;
  p256dh: string | null;
  auth: string | null;
  environment: ApnsEnvironment | null;
}

export interface PushMessage {
  title: string;
  body: string;
  badge: number;
  /** Ids only (strings): what the app needs to open the notice's screen. */
  data: Record<string, string>;
  /** Groups notifications on the device (APNs thread-id, Web Push tag). */
  thread: string;
}

export type PushOutcome =
  | { ok: true; status: number; environment?: ApnsEnvironment }
  /** gone: the address is dead for good (unsubscribed, app deleted, bad token): delete the subscription. */
  | { ok: false; status: number; error: string; gone: boolean; environment?: ApnsEnvironment };

export interface PushSender {
  readonly apns: boolean;
  /** The VAPID public key, or null without Web Push. */
  readonly webPublicKey: string | null;
  /** Hosts a Web Push endpoint may be on (a host or a parent domain). */
  readonly allowedHosts: string[];
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>;
}

/** The real thing: APNs over HTTP/2 and Web Push (the web-push library) with the instance's keys. */
export class RealPushSender implements PushSender {
  readonly apns: boolean;
  readonly webPublicKey: string | null;
  readonly allowedHosts: string[];
  readonly #apns: ApnsClient | null;
  readonly #defaultEnv: ApnsEnvironment;
  readonly #vapid: { subject: string; publicKey: string; privateKey: string } | null;
  readonly #agent: Agent | undefined;

  constructor(
    config: NonNullable<Config["push"]>,
    secrets: { apnsKeyP8: string; vapidPrivateKey: string },
    /** Tests: a local APNs stand-in and an https agent that trusts it. */
    testing: { apnsHosts?: Record<ApnsEnvironment, string>; apnsConnect?: { ca?: string; rejectUnauthorized?: boolean }; webAgent?: Agent } = {},
  ) {
    const a = config.apns;
    this.#apns = a
      ? new ApnsClient({
          teamId: a.teamId,
          keyId: a.keyId,
          keyP8: secrets.apnsKeyP8,
          bundleId: a.bundleId,
          ...(testing.apnsHosts ? { hosts: testing.apnsHosts } : {}),
          ...(testing.apnsConnect ? { connectOptions: testing.apnsConnect } : {}),
        })
      : null;
    this.apns = !!this.#apns;
    this.#defaultEnv = a?.environment ?? "production";
    const w = config.webPush;
    this.#vapid = w ? { subject: w.subject, publicKey: w.publicKey, privateKey: secrets.vapidPrivateKey } : null;
    this.webPublicKey = w?.publicKey ?? null;
    this.allowedHosts = w?.allowedHosts ?? DEFAULT_PUSH_HOSTS;
    this.#agent = testing.webAgent;
  }

  async send(t: PushTarget, m: PushMessage): Promise<PushOutcome> {
    return t.kind === "apns" ? this.#sendApns(t, m) : this.#sendWeb(t, m);
  }

  async #sendApns(t: PushTarget, m: PushMessage): Promise<PushOutcome> {
    if (!this.#apns) return { ok: false, status: 0, error: "APNs is not configured on this instance", gone: false };
    const payload = {
      aps: { alert: { title: m.title, body: m.body }, sound: "default", badge: m.badge, "thread-id": m.thread },
      // expo-notifications hands the app the payload's `body` as the notification's data
      body: m.data,
      ...m.data,
    };
    const first = t.environment ?? this.#defaultEnv;
    const a = await this.#apns.send(t.address, first, payload);
    if (a.status === 200) return { ok: true, status: 200, environment: first };
    // A token from the other environment (a simulator or development build vs TestFlight) is a
    // BadDeviceToken here: try the other one once, and keep whichever works.
    if (a.status === 400 && a.reason === "BadDeviceToken") {
      const other: ApnsEnvironment = first === "production" ? "sandbox" : "production";
      const b = await this.#apns.send(t.address, other, payload);
      if (b.status === 200) return { ok: true, status: 200, environment: other };
      const gone = b.status === 410 || (b.status === 400 && b.reason === "BadDeviceToken");
      return { ok: false, status: b.status, error: `${a.reason} (${a.status}, ${first}); ${b.reason ?? "error"} (${b.status}, ${other})`, gone };
    }
    // 410 Unregistered: the app was deleted or turned notifications off
    return { ok: false, status: a.status, error: `${a.reason ?? "error"} (${a.status}, ${first})`, gone: a.status === 410 };
  }

  async #sendWeb(t: PushTarget, m: PushMessage): Promise<PushOutcome> {
    if (!this.#vapid) return { ok: false, status: 0, error: "Web Push is not configured on this instance", gone: false };
    if (!hostAllowed(t.address, this.allowedHosts)) return { ok: false, status: 0, error: "endpoint is not on a known push service", gone: true };
    const payload = JSON.stringify({ title: m.title, body: m.body, badge: m.badge, tag: m.thread, data: m.data });
    try {
      const r = await webpush.sendNotification({ endpoint: t.address, keys: { p256dh: t.p256dh ?? "", auth: t.auth ?? "" } }, payload, {
        vapidDetails: this.#vapid,
        TTL: 24 * 3600,
        urgency: "high",
        timeout: 15_000,
        ...(this.#agent ? { agent: this.#agent } : {}),
      });
      return { ok: true, status: r.statusCode };
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode ?? 0;
      const body = String((e as { body?: unknown }).body ?? (e as Error).message ?? "").slice(0, 200);
      // 404/410: the browser unsubscribed or the subscription expired
      return { ok: false, status, error: `${status || "network"}: ${body}`.trim(), gone: status === 404 || status === 410 };
    }
  }

  close(): void {
    this.#apns?.close();
  }
}

/** A Web Push endpoint must be https on one of the allowed push services: the server POSTs to it. */
export function hostAllowed(endpoint: string, allowed: string[]): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  return allowed.some((d) => host === d || (!d.includes(":") && !u.port && u.hostname.endsWith(`.${d}`)));
}

// ---- kinds ----------------------------------------------------------------------------------------

/** Each push kind: the settings label and the fixed title a push of it shows. Order = the settings screen's. */
export const PUSH_KINDS: { kind: PushKind; label: string; title: string }[] = [
  { kind: "approval_needed", label: "Approvals waiting for you", title: "Approval needed" },
  { kind: "question", label: "Questions for you (ask the boss)", title: "A question for you" },
  { kind: "approval_decided", label: "Your requests decided", title: "Your request was decided" },
  { kind: "channel_post", label: "New posts in your tasks' channels", title: "New channel post" },
  { kind: "caps", label: "Caps and budget reached", title: "A limit was reached" },
  { kind: "schedule_skipped", label: "Scheduled runs skipped", title: "A scheduled run was skipped" },
  { kind: "wakeup", label: "Wakeups that couldn't run", title: "A wakeup needs attention" },
  { kind: "task_failed", label: "Tasks that failed to start", title: "A task failed" },
  { kind: "other", label: "Other notices (access, suggestions, passkeys)", title: "New notice" },
];

const PUSH_BODY = "Open Jarvis to see it.";

export function pushKindOf(ctx: Ctx, kind: NoticeView["kind"], approvalId: string | null): PushKind {
  switch (kind) {
    case "approval_needed": {
      const a = approvalId ? (ctx.db.prepare("SELECT kind FROM approvals WHERE id = ?").get(approvalId) as { kind: string } | undefined) : undefined;
      return a?.kind === "question" ? "question" : "approval_needed";
    }
    case "approval_decided":
    case "channel_post":
    case "schedule_skipped":
    case "wakeup":
    case "task_failed":
      return kind;
    case "machine_hours_cap":
    case "tools_cap":
    case "instance_budget":
      return "caps";
    default:
      return "other";
  }
}

// ---- rows -----------------------------------------------------------------------------------------

interface SubRow {
  id: string;
  user_id: string;
  device_id: string | null;
  kind: "apns" | "web";
  address: string;
  p256dh: string | null;
  auth: string | null;
  environment: ApnsEnvironment | null;
  label: string;
  created_at: number;
  last_sent_at: number | null;
  last_ok_at: number | null;
  last_error: string | null;
}

const subView = (s: SubRow): PushSubscriptionView => ({
  id: s.id,
  kind: s.kind,
  label: s.label,
  deviceId: s.device_id,
  createdAt: iso(s.created_at),
  lastSentAt: s.last_sent_at === null ? null : iso(s.last_sent_at),
  lastOkAt: s.last_ok_at === null ? null : iso(s.last_ok_at),
  lastError: s.last_error,
});

const subsOf = (ctx: Ctx, userId: string): SubRow[] =>
  ctx.db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC").all(userId) as unknown as SubRow[];

export function getSubscription(ctx: Ctx, id: string): SubRow | null {
  return (ctx.db.prepare("SELECT * FROM push_subscriptions WHERE id = ?").get(id) as SubRow | undefined) ?? null;
}

function enabledKinds(ctx: Ctx, userId: string): Map<PushKind, boolean> {
  const rows = ctx.db.prepare("SELECT kind, enabled FROM push_prefs WHERE user_id = ?").all(userId) as { kind: PushKind; enabled: number }[];
  return new Map(rows.map((r) => [r.kind, r.enabled === 1]));
}

export const pushFeature = (ctx: Ctx): { apns: boolean; webPush: boolean } | undefined =>
  ctx.push ? { apns: ctx.push.apns, webPush: ctx.push.webPublicKey !== null } : undefined;

function requirePush(ctx: Ctx) {
  if (!ctx.push) throw httpError("conflict", "push notifications are not set up on this instance");
  return ctx.push;
}

// ---- the settings API -------------------------------------------------------------------------------

export function settings(ctx: Ctx, userId: string): PushSettings {
  const prefs = enabledKinds(ctx, userId);
  const kinds: PushKindView[] = PUSH_KINDS.map((k) => ({ kind: k.kind, label: k.label, enabled: prefs.get(k.kind) ?? true }));
  return {
    apns: ctx.push?.apns ?? false,
    webPushPublicKey: ctx.push?.webPublicKey ?? null,
    kinds,
    subscriptions: subsOf(ctx, userId).map(subView),
  };
}

export function setKinds(ctx: Ctx, userId: string, body: SetPushKindsRequest | undefined): PushSettings {
  const kinds = body?.kinds;
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) throw httpError("bad_request", "kinds must be an object of kind -> true/false");
  const known = new Set(PUSH_KINDS.map((k) => k.kind));
  for (const [k, v] of Object.entries(kinds)) {
    if (!known.has(k as PushKind)) throw httpError("bad_request", `unknown push kind ${k}; the kinds are: ${[...known].join(", ")}`);
    if (typeof v !== "boolean") throw httpError("bad_request", `kinds.${k} must be true or false`);
  }
  const put = ctx.db.prepare("INSERT INTO push_prefs(user_id, kind, enabled) VALUES (?, ?, ?) ON CONFLICT(user_id, kind) DO UPDATE SET enabled = excluded.enabled");
  for (const [k, v] of Object.entries(kinds)) put.run(userId, k, v ? 1 : 0);
  return settings(ctx, userId);
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const b64len = (s: string): number => Buffer.from(s, "base64url").length;

function cleanLabel(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v !== "string") throw httpError("bad_request", "label must be a string");
  return v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 80);
}

/**
 * Register this browser or device for the caller's pushes. An address registered before (by anyone)
 * now belongs to the caller: a device that changed hands stops getting the previous person's notices.
 */
export function subscribe(ctx: Ctx, userId: string, deviceId: string | null, body: CreatePushSubscriptionRequest | undefined): PushSubscriptionView {
  const push = requirePush(ctx);
  if (!body || typeof body !== "object") throw httpError("bad_request", "body must be an object");
  const label = cleanLabel((body as { label?: unknown }).label);
  let row: Omit<SubRow, "id" | "user_id" | "device_id" | "created_at" | "last_sent_at" | "last_ok_at" | "last_error">;
  if (body.kind === "web") {
    if (push.webPublicKey === null) throw httpError("conflict", "Web Push is not set up on this instance");
    const endpoint = body.endpoint;
    if (typeof endpoint !== "string" || endpoint.length > 2048) throw httpError("bad_request", "endpoint must be a URL");
    if (!hostAllowed(endpoint, push.allowedHosts)) throw httpError("bad_request", "endpoint must be an https URL on a known push service");
    const p256dh = body.keys?.p256dh, auth = body.keys?.auth;
    if (typeof p256dh !== "string" || !B64URL.test(p256dh) || b64len(p256dh) !== 65) throw httpError("bad_request", "keys.p256dh must be a base64url P-256 public key");
    if (typeof auth !== "string" || !B64URL.test(auth) || b64len(auth) !== 16) throw httpError("bad_request", "keys.auth must be 16 bytes, base64url");
    row = { kind: "web", address: endpoint, p256dh, auth, environment: null, label: label || "Browser" };
  } else if (body.kind === "apns") {
    if (!push.apns) throw httpError("conflict", "iOS push is not set up on this instance");
    // the iOS app is a paired device; a browser has no APNs token of this app
    if (!deviceId) throw httpError("forbidden", "an APNs token can only be registered from a paired device");
    const token = typeof body.token === "string" ? body.token.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64,200}$/.test(token)) throw httpError("bad_request", "token must be the APNs device token in hex");
    const env = body.environment ?? null;
    if (env !== null && env !== "production" && env !== "sandbox") throw httpError("bad_request", "environment must be production or sandbox");
    row = { kind: "apns", address: token, p256dh: null, auth: null, environment: env, label: label || "iPhone" };
  } else {
    throw httpError("bad_request", "kind must be web or apns");
  }
  const now = ctx.clock.now();
  const existing = ctx.db.prepare("SELECT * FROM push_subscriptions WHERE address = ?").get(row.address) as SubRow | undefined;
  if (existing) {
    ctx.db
      .prepare("UPDATE push_subscriptions SET user_id = ?, device_id = ?, kind = ?, p256dh = ?, auth = ?, environment = ?, label = ?, last_error = NULL WHERE id = ?")
      .run(userId, deviceId, row.kind, row.p256dh, row.auth, row.environment, row.label, existing.id);
    if (existing.user_id !== userId) ctx.log("push: subscription moved to another user", { subscription: existing.id });
    return subView(getSubscription(ctx, existing.id)!);
  }
  const id = randomId(8);
  ctx.db
    .prepare("INSERT INTO push_subscriptions(id, user_id, device_id, kind, address, p256dh, auth, environment, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, deviceId, row.kind, row.address, row.p256dh, row.auth, row.environment, row.label, now);
  return subView(getSubscription(ctx, id)!);
}

/** The owner (or an admin, through the route's authorize) removes a subscription. */
export function unsubscribe(ctx: Ctx, id: string): void {
  ctx.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
}

/** A revoked device stops getting pushes. */
export function forgetDevice(ctx: Ctx, deviceId: string): void {
  ctx.db.prepare("DELETE FROM push_subscriptions WHERE device_id = ?").run(deviceId);
}

/** Offboarding: none of the person's devices or browsers get pushes any more. */
export function forgetUser(ctx: Ctx, userId: string): void {
  ctx.db.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").run(userId);
}

// ---- sending ----------------------------------------------------------------------------------------

/** A burst of channel posts from one task makes one push a minute, not sixty. */
const THROTTLE_MS = 60_000;
const lastPush = new WeakMap<Ctx, Map<string, number>>();

function throttled(ctx: Ctx, key: string): boolean {
  let m = lastPush.get(ctx);
  if (!m) lastPush.set(ctx, (m = new Map()));
  const now = ctx.clock.now();
  const prev = m.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return true;
  m.set(key, now);
  if (m.size > 10_000) m.clear();
  return false;
}

async function deliver(ctx: Ctx, sub: SubRow, message: PushMessage): Promise<{ ok: boolean; error: string | null }> {
  const sender = ctx.push!;
  const at = ctx.clock.now();
  let out: PushOutcome;
  try {
    out = await sender.send({ kind: sub.kind, address: sub.address, p256dh: sub.p256dh, auth: sub.auth, environment: sub.environment }, message);
  } catch (e) {
    out = { ok: false, status: 0, error: `network: ${(e as Error).message}`.slice(0, 300), gone: false };
  }
  if (out.ok) {
    ctx.db
      .prepare("UPDATE push_subscriptions SET last_sent_at = ?, last_ok_at = ?, last_error = NULL, failures = 0, environment = COALESCE(?, environment) WHERE id = ?")
      .run(at, at, sub.kind === "apns" ? (out.environment ?? null) : null, sub.id);
    return { ok: true, error: null };
  }
  ctx.log("push: send failed", { subscription: sub.id, kind: sub.kind, status: out.status, error: out.error, gone: out.gone });
  if (out.gone) {
    ctx.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(sub.id);
  } else {
    ctx.db.prepare("UPDATE push_subscriptions SET last_sent_at = ?, last_error = ?, failures = failures + 1 WHERE id = ?").run(at, out.error.slice(0, 300), sub.id);
  }
  return { ok: false, error: out.error };
}

/** Called for every new notice (ctx.addNotice): pushes it to the notice's user, if they want this kind. */
export function notifyPush(ctx: Ctx, n: { id: string; userId: string; kind: NoticeView["kind"]; taskId: string | null; approvalId: string | null }): void {
  if (!ctx.push) return;
  const user = ctx.db.prepare("SELECT status FROM users WHERE id = ?").get(n.userId) as { status: string } | undefined;
  if (user?.status !== "active") return;
  const kind = pushKindOf(ctx, n.kind, n.approvalId);
  if (enabledKinds(ctx, n.userId).get(kind) === false) return;
  const subs = subsOf(ctx, n.userId);
  if (!subs.length) return;
  if (n.taskId && throttled(ctx, `${n.userId}:${kind}:${n.taskId}`)) return;
  const title = PUSH_KINDS.find((k) => k.kind === kind)!.title;
  const data: Record<string, string> = { jarvis3: "notice", noticeId: n.id, kind: n.kind, pushKind: kind };
  if (n.taskId) data.taskId = n.taskId;
  if (n.approvalId) data.approvalId = n.approvalId;
  const message: PushMessage = { title, body: PUSH_BODY, badge: unreadCount(ctx, n.userId), data, thread: kind };
  for (const s of subs) ctx.ops.run(deliver(ctx, s, message), ctx.log, "push");
}

/** POST /api/push/test: one test push to each of the caller's subscriptions, answered once all are sent. */
export async function sendTest(ctx: Ctx, userId: string): Promise<PushTestResult> {
  requirePush(ctx);
  const message: PushMessage = { title: "Test notification", body: "Push notifications from Jarvis work on this device.", badge: unreadCount(ctx, userId), data: { jarvis3: "test" }, thread: "test" };
  const subs = subsOf(ctx, userId);
  const results = await Promise.all(subs.map(async (s) => ({ id: s.id, ...(await deliver(ctx, s, message)) })));
  return { results };
}
