// Who is calling, and may they do this?
//
// 1. resolvePrincipal(): verifies the Cloudflare Access JWT on every request (the server never
//    trusts that Access ran), then maps it to a principal:
//      identity login (JWT `email`)              -> that user, if a known ACTIVE member
//      service token (JWT `common_name`)         -> the paired device's user, if the device is not
//                                                   revoked and its user is active
//      the session-gate service token            -> a session, but only with a valid per-task
//                                                   session token (Authorization: Bearer …)
// 2. authorize(): THE one authorisation function. Every route and the daemon proxy call it with
//    the target they are about to touch; nothing else decides access.
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { IncomingMessage } from "node:http";
import type { Clock } from "./clock.ts";
import type { Db } from "./db.ts";
import { sha256hex, verifyToken } from "./crypto.ts";
import { httpError, notFound } from "./errors.ts";
import type { TaskRow, UserRow } from "./rows.ts";

// ---- Access JWT ------------------------------------------------------------------------------------

export type AccessIdentity = { kind: "email"; email: string } | { kind: "service"; clientId: string };

export interface AccessVerifierOptions {
  teamDomain: string;
  audience: string;
  clock: Clock;
  /** Tests pass a local JWKS; production fetches https://<team>/cdn-cgi/access/certs (cached). */
  jwks?: JSONWebKeySet;
}

export class AccessVerifier {
  readonly #getKey: JWTVerifyGetKey;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #clock: Clock;
  constructor(o: AccessVerifierOptions) {
    this.#issuer = `https://${o.teamDomain}`;
    this.#audience = o.audience;
    this.#clock = o.clock;
    this.#getKey = o.jwks
      ? createLocalJWKSet(o.jwks)
      : createRemoteJWKSet(new URL(`${this.#issuer}/cdn-cgi/access/certs`), { cacheMaxAge: 3600_000, cooldownDuration: 30_000 });
  }
  /** Throws on anything but a valid, current token for this application. */
  async verify(token: string): Promise<AccessIdentity> {
    const { payload } = await jwtVerify(token, this.#getKey, {
      issuer: this.#issuer,
      audience: this.#audience,
      algorithms: ["RS256"],
      currentDate: new Date(this.#clock.now()),
      clockTolerance: 5,
      requiredClaims: ["exp"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (email) return { kind: "email", email };
    const cn = typeof payload.common_name === "string" ? payload.common_name.trim() : "";
    if (cn) return { kind: "service", clientId: cn };
    throw new Error("Access token names neither an email nor a service token");
  }
}

export function accessToken(req: IncomingMessage): string {
  const h = req.headers["cf-access-jwt-assertion"];
  if (typeof h === "string" && h) return h;
  const cookie = req.headers.cookie || "";
  const m = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]!) : "";
}

export function bearer(req: IncomingMessage): string {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  return m ? m[1]! : "";
}

// ---- principals ----------------------------------------------------------------------------------

export type Principal =
  | { kind: "user"; user: UserRow; isAdmin: boolean; via: "identity" | "device"; deviceId: string | null }
  | { kind: "session"; task: TaskRow }
  /** The session-gate service token without a valid session token: may call nothing. */
  | { kind: "gate" };

export interface ResolveDeps {
  db: Db;
  clock: Clock;
  verifier: AccessVerifier;
  sessionGateClientId: string;
  isAdminRole: (role: string) => boolean;
}

/** Task states in which the task's session token is honoured. */
export const LIVE_TOKEN_STATES = new Set(["starting", "running", "idle", "pausing", "destroying"]);

/**
 * null = no credentials at all (401 at authorize). Throws 401 for a bad JWT and 403 for a valid
 * JWT that is not an active member / a revoked device.
 */
export async function resolvePrincipal(req: IncomingMessage, d: ResolveDeps): Promise<Principal | null> {
  const jwt = accessToken(req);
  if (!jwt) return null;
  let id: AccessIdentity;
  try {
    id = await d.verifier.verify(jwt);
  } catch {
    throw httpError("unauthenticated", "invalid Cloudflare Access token");
  }
  if (id.kind === "email") {
    const user = d.db.prepare("SELECT * FROM users WHERE email = ?").get(id.email) as UserRow | undefined;
    if (!user || user.status !== "active") throw httpError("forbidden", "not an active member of this instance");
    return { kind: "user", user, isAdmin: d.isAdminRole(user.role), via: "identity", deviceId: null };
  }
  if (id.clientId === d.sessionGateClientId) {
    const tok = bearer(req);
    if (!tok) return { kind: "gate" };
    const task = d.db.prepare("SELECT * FROM tasks WHERE session_token_hash = ?").get(sha256hex(tok)) as TaskRow | undefined;
    if (!task || !verifyToken(tok, task.session_token_hash) || !LIVE_TOKEN_STATES.has(task.state)) {
      throw httpError("unauthenticated", "invalid session token");
    }
    return { kind: "session", task };
  }
  const dev = d.db.prepare("SELECT * FROM devices WHERE client_id = ?").get(id.clientId) as
    | { id: string; user_id: string; revoked_at: number | null; last_seen_at: number }
    | undefined;
  if (!dev) throw httpError("forbidden", "unknown device");
  const user = d.db.prepare("SELECT * FROM users WHERE id = ?").get(dev.user_id) as UserRow | undefined;
  // a suspended or removed user's devices are revoked too; say the more useful thing
  if (!user || user.status !== "active") throw httpError("forbidden", "not an active member of this instance");
  if (dev.revoked_at !== null) throw httpError("device_revoked", "this device was signed out; pair it again");
  const now = d.clock.now();
  if (now - dev.last_seen_at > 60_000) d.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, dev.id);
  return { kind: "user", user, isAdmin: d.isAdminRole(user.role), via: "device", deviceId: dev.id };
}

// ---- the authorisation function -------------------------------------------------------------------

export type Target =
  /** Something every active member may do for themselves (their profile, models, creating a task). */
  | { kind: "member" }
  /** A resource owned by one user (a task, a device, a personal layer, a user record). */
  | { kind: "owned"; ownerId: string; what: string }
  /** Admin-only. Non-admins get the same 404 as for a missing resource. */
  | { kind: "admin"; what: string }
  /** Session-facing routes: only the calling session, about itself. */
  | { kind: "session" }
  /** Pairing a device: only an identity login (not a device or a session). */
  | { kind: "identity-login" };

export function authorize(p: Principal | null, t: Target): void {
  if (!p) throw httpError("unauthenticated", "Cloudflare Access login required");
  if (t.kind === "session") {
    if (p.kind !== "session") throw httpError("unauthenticated", "session token required");
    return;
  }
  if (p.kind !== "user") throw httpError("forbidden", "session credentials can only call /api/session routes");
  if (p.user.status !== "active") throw httpError("forbidden", "not an active member of this instance");
  switch (t.kind) {
    case "member":
      return;
    case "identity-login":
      if (p.via !== "identity") throw httpError("forbidden", "pairing needs an identity login, not a device token");
      return;
    case "owned":
      if (p.user.id === t.ownerId || p.isAdmin) return;
      throw notFound(t.what);
    case "admin":
      if (p.isAdmin) return;
      throw notFound(t.what);
  }
}

/** The user a principal acts as (after authorize with a user target). */
export function userOf(p: Principal | null): { user: UserRow; isAdmin: boolean } {
  if (!p || p.kind !== "user") throw httpError("forbidden", "not a user");
  return { user: p.user, isAdmin: p.isAdmin };
}
