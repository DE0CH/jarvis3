// Passkeys for Tier 3 approvals (DESIGN "Actions and approvals": Face ID on the owner's phone).
//
// The owner registers a passkey once per device (WebAuthn, user verification required: Face ID,
// Touch ID or the device PIN). Approving a Tier 3 change is a WebAuthn assertion whose challenge
// is derived from the change itself:
//
//   challenge = sha256("jarvis3-tier3\n" + changeHash + "\n" + nonce)
//   changeHash = sha256(canonical JSON of the change: instance, approval id, action, type, params, summary)
//
// so the signature covers exactly the change shown on the page. The server keeps the assertion
// (authenticator data, client data, signature, credential id) with the approval as its proof.
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { PasskeyView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice } from "./ctx.ts";
import type { UserRow } from "./rows.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { httpError, notFound } from "./errors.ts";
import { changeHash, changeOf, finish, isOwner, type ApprovalRow } from "./approvals.ts";

const CHALLENGE_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;

interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: number;
  last_used_at: number | null;
}

const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const rp = (ctx: Ctx) => ({ id: new URL(ctx.config.publicUrl).hostname, origin: ctx.config.publicUrl, name: `Jarvis (${ctx.config.instanceName})` });

export function passkeyView(r: PasskeyRow): PasskeyView {
  return { id: r.id, name: r.name, createdAt: iso(r.created_at), lastUsedAt: r.last_used_at === null ? null : iso(r.last_used_at) };
}

export function listPasskeys(ctx: Ctx, userId: string): PasskeyRow[] {
  return ctx.db.prepare("SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at").all(userId) as unknown as PasskeyRow[];
}

export function requireOwner(ctx: Ctx, u: UserRow): void {
  // not the owner = the same 404 as an admin-only route
  if (!isOwner(ctx, u)) throw notFound("passkey");
}

function saveChallenge(ctx: Ctx, userId: string, purpose: "register" | "approve", challenge: string, approvalId: string | null): void {
  const now = ctx.clock.now();
  ctx.db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ? OR (user_id = ? AND purpose = ? AND approval_id IS ?)").run(now, userId, purpose, approvalId);
  ctx.db.prepare("INSERT INTO webauthn_challenges(id, user_id, purpose, approval_id, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(randomId(8), userId, purpose, approvalId, challenge, now + CHALLENGE_MS);
}

/** Take (and consume) the user's live challenge for this purpose. */
function takeChallenge(ctx: Ctx, userId: string, purpose: "register" | "approve", approvalId: string | null): string {
  const r = ctx.db
    .prepare("SELECT id, challenge, expires_at FROM webauthn_challenges WHERE user_id = ? AND purpose = ? AND approval_id IS ? ORDER BY expires_at DESC LIMIT 1")
    .get(userId, purpose, approvalId) as { id: string; challenge: string; expires_at: number } | undefined;
  if (!r || r.expires_at < ctx.clock.now()) throw httpError("bad_request", "no live passkey challenge; start again");
  ctx.db.prepare("DELETE FROM webauthn_challenges WHERE id = ?").run(r.id);
  return r.challenge;
}

// ---- registration -------------------------------------------------------------------------------

export async function registrationOptions(ctx: Ctx, user: UserRow): Promise<PublicKeyCredentialCreationOptionsJSON> {
  requireOwner(ctx, user);
  const existing = listPasskeys(ctx, user.id);
  if (existing.length >= MAX_PASSKEYS) throw httpError("conflict", `at most ${MAX_PASSKEYS} passkeys; delete one first`);
  const r = rp(ctx);
  const options = await generateRegistrationOptions({
    rpName: r.name,
    rpID: r.id,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: JSON.parse(p.transports) as AuthenticatorTransportFuture[] })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    timeout: CHALLENGE_MS,
  });
  saveChallenge(ctx, user.id, "register", options.challenge, null);
  return options;
}

export async function register(ctx: Ctx, user: UserRow, body: { response?: RegistrationResponseJSON; name?: unknown }): Promise<PasskeyRow> {
  requireOwner(ctx, user);
  if (!body?.response || typeof body.response !== "object") throw httpError("bad_request", "response is required");
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Passkey";
  const expected = takeChallenge(ctx, user.id, "register", null);
  const r = rp(ctx);
  let v;
  try {
    v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: expected, expectedOrigin: r.origin, expectedRPID: r.id, requireUserVerification: true });
  } catch (e) {
    throw httpError("bad_request", `passkey not accepted: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!v.verified) throw httpError("bad_request", "passkey not accepted");
  const c = v.registrationInfo.credential;
  if (ctx.db.prepare("SELECT 1 FROM passkeys WHERE id = ?").get(c.id)) throw httpError("conflict", "this passkey is already registered");
  ctx.db
    .prepare("INSERT INTO passkeys(id, user_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(c.id, user.id, b64u(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), name, ctx.clock.now());
  addNotice(ctx, user.id, "passkey_added", `A passkey was added for Tier 3 approvals: ${name}. If this wasn't you, delete it.`);
  return ctx.db.prepare("SELECT * FROM passkeys WHERE id = ?").get(c.id) as unknown as PasskeyRow;
}

export function deletePasskey(ctx: Ctx, user: UserRow, id: string): void {
  const r = ctx.db.prepare("DELETE FROM passkeys WHERE id = ? AND user_id = ?").run(id, user.id);
  if (!r.changes) throw notFound("passkey");
}

// ---- approving a Tier 3 change ----------------------------------------------------------------------

/** The change an approval stands for, and its hash, recomputed from the stored row (never trusted from it). */
export function changeFor(ctx: Ctx, a: ApprovalRow): { change: Record<string, unknown>; hash: string } {
  const change = changeOf(ctx, a);
  const hash = changeHash(change);
  if (hash !== a.change_hash) throw httpError("conflict", "the change no longer matches what was asked; it can't be signed");
  return { change, hash };
}

function ownerPendingTier3(ctx: Ctx, user: UserRow, a: ApprovalRow): void {
  requireOwner(ctx, user);
  if (a.approver !== "owner") throw httpError("bad_request", "this request doesn't need a passkey");
  if (a.state !== "pending") throw httpError("conflict", `this request is already ${a.state}`);
}

export async function approvalOptions(ctx: Ctx, user: UserRow, a: ApprovalRow): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; change: Record<string, unknown>; changeHash: string }> {
  ownerPendingTier3(ctx, user, a);
  const keys = listPasskeys(ctx, user.id);
  if (!keys.length) throw httpError("conflict", "register a passkey first");
  const { change, hash } = changeFor(ctx, a);
  const nonce = randomBytes(16).toString("hex");
  const challenge = createHash("sha256").update(`jarvis3-tier3\n${hash}\n${nonce}`).digest();
  const options = await generateAuthenticationOptions({
    rpID: rp(ctx).id,
    challenge: new Uint8Array(challenge),
    allowCredentials: keys.map((k) => ({ id: k.id, transports: JSON.parse(k.transports) as AuthenticatorTransportFuture[] })),
    userVerification: "required",
    timeout: CHALLENGE_MS,
  });
  saveChallenge(ctx, user.id, "approve", options.challenge, a.id);
  return { options, change, changeHash: hash };
}

export async function approveWithPasskey(ctx: Ctx, user: UserRow, a: ApprovalRow, body: { response?: AuthenticationResponseJSON }): Promise<ApprovalRow> {
  ownerPendingTier3(ctx, user, a);
  if (!body?.response || typeof body.response !== "object" || typeof body.response.id !== "string") throw httpError("bad_request", "response is required");
  const expected = takeChallenge(ctx, user.id, "approve", a.id);
  const { hash } = changeFor(ctx, a);
  const key = ctx.db.prepare("SELECT * FROM passkeys WHERE id = ? AND user_id = ?").get(body.response.id, user.id) as PasskeyRow | undefined;
  if (!key) throw httpError("bad_request", "unknown passkey");
  const r = rp(ctx);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: expected,
      expectedOrigin: r.origin,
      expectedRPID: r.id,
      credential: { id: key.id, publicKey: new Uint8Array(Buffer.from(key.public_key, "base64url")), counter: key.counter },
      requireUserVerification: true,
    });
  } catch (e) {
    throw httpError("bad_request", `passkey not accepted: ${(e as Error).message.slice(0, 200)}`);
  }
  if (!v.verified || !v.authenticationInfo.userVerified) throw httpError("bad_request", "passkey not accepted");
  ctx.db.prepare("UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?").run(v.authenticationInfo.newCounter, ctx.clock.now(), key.id);
  const proof = JSON.stringify({ credentialId: key.id, changeHash: hash, challenge: expected, response: body.response.response });
  return finish(ctx, a, user, { state: "approved", note: null, passkeyProof: proof });
}
