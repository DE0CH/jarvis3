// Members, directory sync, offboarding, devices and per-user limits.
import type { DeviceView, SetLimitsRequest, SyncResult, UserDetail, UserView } from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { addNotice, isAdminRole } from "./ctx.ts";
import type { DeviceRow, UserRow } from "./rows.ts";
import type { DirectoryUser } from "./providers.ts";
import { iso, monthKey } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { kvGet, kvSet, tx } from "./db.ts";
import { httpError, notFound } from "./errors.ts";
import { limitsFor, machineHours, machineHoursCapReached } from "./spend.ts";
import { keyRow, revokeKey, syncKeyLimit } from "./userkeys.ts";
import { destroyTask, unarchivedTasksOf } from "./tasks.ts";
import { getPersonal } from "./layers.ts";

export function getUser(ctx: Ctx, id: string): UserRow | null {
  return (ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined) ?? null;
}

export function requireUser(ctx: Ctx, id: string): UserRow {
  const u = getUser(ctx, id);
  if (!u) throw notFound("user");
  return u;
}

export function userView(ctx: Ctx, u: UserRow): UserView {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    isAdmin: isAdminRole(ctx.config, u.role),
    createdAt: iso(u.created_at),
  };
}

export function userDetail(ctx: Ctx, u: UserRow): UserDetail {
  return {
    user: userView(ctx, u),
    limits: limitsFor(ctx, u),
    usage: {
      month: monthKey(ctx.clock.now()),
      machineHours: Math.round(machineHours(ctx, u.id) * 1000) / 1000,
      machineHoursCapReached: machineHoursCapReached(ctx, u),
      openrouterKey: !!keyRow(ctx, u.id),
    },
  };
}

export function listUsers(ctx: Ctx): UserRow[] {
  return ctx.db.prepare("SELECT * FROM users ORDER BY email").all() as unknown as UserRow[];
}

// ---- limits ----------------------------------------------------------------------------------

const validLimit = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

export async function setLimits(ctx: Ctx, user: UserRow, body: SetLimitsRequest): Promise<UserRow> {
  if (!body || typeof body !== "object") throw httpError("bad_request", "body must be an object");
  const patch: string[] = [];
  const args: (number | null)[] = [];
  if ("openrouterMonthlyUsd" in body) {
    if (!validLimit(body.openrouterMonthlyUsd)) throw httpError("bad_request", "openrouterMonthlyUsd must be a number ≥ 0 or null");
    patch.push("openrouter_limit_override = ?", "openrouter_limit_override_set = ?");
    args.push(body.openrouterMonthlyUsd ?? null, body.openrouterMonthlyUsd === null ? 0 : 1);
  }
  if ("machineHoursPerMonth" in body) {
    if (!validLimit(body.machineHoursPerMonth)) throw httpError("bad_request", "machineHoursPerMonth must be a number ≥ 0 or null");
    patch.push("machine_hours_override = ?", "machine_hours_override_set = ?");
    args.push(body.machineHoursPerMonth ?? null, body.machineHoursPerMonth === null ? 0 : 1);
  }
  if (!patch.length) throw httpError("bad_request", "nothing to change");
  ctx.db.prepare(`UPDATE users SET ${patch.join(", ")}, updated_at = ? WHERE id = ?`).run(...args, ctx.clock.now(), user.id);
  const u = getUser(ctx, user.id)!;
  await syncKeyLimit(ctx, u);
  return u;
}

// ---- directory sync ----------------------------------------------------------------------------

/** The role a directory user maps to, or null (= not a member of this instance). */
export function roleFor(ctx: Ctx, d: DirectoryUser): string | null {
  const c = ctx.config;
  if (c.bootstrapAdmins.map((e) => e.toLowerCase()).includes(d.email)) {
    const admin = Object.keys(c.roles).find((r) => c.roles[r]!.admin);
    if (admin) return admin;
  }
  if (d.role !== undefined) return c.roles[d.role] ? d.role : null;
  if (c.directory.kind !== "google") return null;
  const groupRoles = Object.fromEntries(Object.entries(c.directory.groupRoles).map(([g, r]) => [g.toLowerCase(), r]));
  const mine = new Set(d.groups.map((g) => groupRoles[g.toLowerCase()]).filter(Boolean));
  for (const r of Object.keys(c.roles)) if (mine.has(r)) return r;
  return null;
}

/**
 * Poll the directory and bring users in line. New members are added; a suspended user, or one who
 * left every mapped group / the directory, is offboarded (status suspended / removed); a returning
 * one is reactivated. A failed or empty directory answer changes nothing.
 */
export async function syncDirectory(ctx: Ctx): Promise<SyncResult> {
  const res: SyncResult = { ok: true, error: null, added: [], updated: [], offboarded: [], reactivated: [] };
  let dir: DirectoryUser[];
  try {
    dir = await ctx.directory.listUsers();
  } catch (e) {
    return { ...res, ok: false, error: `directory unavailable, nothing changed: ${(e as Error).message}` };
  }
  const known = listUsers(ctx);
  if (!dir.length && known.some((u) => u.status === "active")) {
    return { ...res, ok: false, error: "the directory returned no users; refusing to offboard everyone" };
  }
  const now = ctx.clock.now();
  const seen = new Set<string>();
  const toOffboard: UserRow[] = [];
  tx(ctx.db, () => {
    for (const d of dir) {
      const email = d.email.toLowerCase();
      const role = roleFor(ctx, d);
      const existing = known.find((u) => u.email === email);
      if (!role) continue; // not a member: handled as "missing" below
      seen.add(email);
      const status = d.suspended ? "suspended" : "active";
      if (!existing) {
        if (status !== "active") continue; // never add someone already suspended
        ctx.db
          .prepare("INSERT INTO users(id, email, name, role, status, created_at, updated_at, status_changed_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)")
          .run(randomId(), email, d.name || "", role, now, now, now);
        res.added.push(email);
        continue;
      }
      if (existing.role !== role || (d.name && existing.name !== d.name)) {
        ctx.db.prepare("UPDATE users SET role = ?, name = ?, updated_at = ? WHERE id = ?").run(role, d.name || existing.name, now, existing.id);
        res.updated.push(email);
      }
      if (existing.status !== status) {
        ctx.db.prepare("UPDATE users SET status = ?, status_changed_at = ?, updated_at = ? WHERE id = ?").run(status, now, now, existing.id);
        if (status === "active") res.reactivated.push(email);
        else {
          res.offboarded.push(email);
          toOffboard.push(existing);
        }
      }
    }
    for (const u of known) {
      if (seen.has(u.email) || u.status !== "active") continue;
      ctx.db.prepare("UPDATE users SET status = 'removed', status_changed_at = ?, updated_at = ? WHERE id = ?").run(now, now, u.id);
      res.offboarded.push(u.email);
      toOffboard.push(u);
    }
  });
  for (const u of toOffboard) await offboard(ctx, u.id);
  for (const u of listUsers(ctx)) if (res.updated.includes(u.email) && u.status === "active") await syncKeyLimit(ctx, u).catch(() => {});
  return res;
}

/**
 * Offboarding (DESIGN "Offboarding"), for a user just suspended or removed:
 *   1. their open daemon sockets close (4403) and the server already refuses them (status);
 *   2. their OpenRouter key is deleted and their devices' Access service tokens are revoked;
 *   3. their personal layer (with its versions) is copied to archives/<userId>/ in the bucket;
 *   4. every task of theirs is archived to the bucket and its machine destroyed.
 * The tasks, archives and personal layer stay for the organisation; admins see them. Whatever
 * fails here is retried by finishOffboarding on the next tick.
 */
export async function offboard(ctx: Ctx, userId: string): Promise<void> {
  ctx.hub.closeUser(userId, "your access was removed");
  try {
    await revokeKey(ctx, userId);
  } catch (e) {
    ctx.log("offboard: key revoke failed (retried next tick)", { user: userId, error: (e as Error).message });
  }
  await revokeDevices(ctx, userId);
  await archiveLayer(ctx, userId).catch((e: Error) => ctx.log("offboard: layer archive failed (retried next tick)", { user: userId, error: e.message }));
  const n = archiveTasksOf(ctx, userId);
  const u = getUser(ctx, userId)!;
  addNotice(ctx, userId, "offboarded", "Your access to this instance was removed.");
  for (const a of listUsers(ctx)) {
    if (a.status !== "active" || !isAdminRole(ctx.config, a.role) || a.id === userId) continue;
    addNotice(
      ctx,
      a.id,
      "offboarded",
      `${u.email} was offboarded (${u.status} in the directory): their key and devices were revoked and ${n} task${n === 1 ? "" : "s"} are being archived. Their personal layer and archives are kept.`,
    );
  }
}

/** Archive and destroy each of the user's tasks that isn't archived yet (busy ones: next tick). */
function archiveTasksOf(ctx: Ctx, userId: string): number {
  let n = 0;
  for (const t of unarchivedTasksOf(ctx, userId)) {
    try {
      destroyTask(ctx, t, { offboarding: true });
      n++;
    } catch (e) {
      ctx.log("offboard: archive refused", { task: t.id, error: (e as Error).message });
    }
  }
  return n;
}

const layerArchivedFlag = (u: UserRow) => `offboard:layer:${u.id}:${u.status_changed_at}`;

/** archives/<userId>/user.json and personal-layer.json (the layer and every version), once per offboarding. */
async function archiveLayer(ctx: Ctx, userId: string): Promise<void> {
  const u = getUser(ctx, userId);
  if (!u || u.status === "active" || kvGet<boolean>(ctx.db, layerArchivedFlag(u))) return;
  const versions = ctx.db.prepare("SELECT version, data, reason, created_at FROM personal_layer_versions WHERE user_id = ? ORDER BY version").all(userId) as {
    version: number;
    data: string;
    reason: string;
    created_at: number;
  }[];
  const at = iso(ctx.clock.now());
  await ctx.blobs.put(
    `archives/${userId}/personal-layer.json`,
    JSON.stringify({
      userId,
      archivedAt: at,
      layer: getPersonal(ctx, userId).data,
      versions: versions.map((v) => ({ version: v.version, reason: v.reason, createdAt: iso(v.created_at), layer: JSON.parse(v.data) as unknown })),
    }),
    "application/json",
  );
  await ctx.blobs.put(
    `archives/${userId}/user.json`,
    JSON.stringify({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, offboardedAt: iso(u.status_changed_at), archivedAt: at }),
    "application/json",
  );
  kvSet(ctx.db, layerArchivedFlag(u), true);
}

/** Retry what a previous offboarding could not finish (keys, devices, layer copy, tasks of inactive users). */
export async function finishOffboarding(ctx: Ctx): Promise<void> {
  const inactive = ctx.db.prepare("SELECT id FROM users WHERE status != 'active'").all() as { id: string }[];
  for (const { id } of inactive) {
    if (keyRow(ctx, id)) await revokeKey(ctx, id).catch(() => {});
    await revokeDevices(ctx, id).catch(() => {});
    await archiveLayer(ctx, id).catch(() => {});
    archiveTasksOf(ctx, id);
  }
}

// ---- devices ------------------------------------------------------------------------------------

export function deviceView(d: DeviceRow): DeviceView {
  return { id: d.id, userId: d.user_id, name: d.name, model: d.model, createdAt: iso(d.created_at), lastSeenAt: iso(d.last_seen_at) };
}

export function listDevices(ctx: Ctx, userId: string | null): DeviceRow[] {
  return (
    userId
      ? ctx.db.prepare("SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at").all(userId)
      : ctx.db.prepare("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at").all()
  ) as unknown as DeviceRow[];
}

export function requireDevice(ctx: Ctx, id: string): DeviceRow {
  const d = ctx.db.prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) as DeviceRow | undefined;
  if (!d) throw notFound("device");
  return d;
}

export async function pairDevice(ctx: Ctx, user: UserRow, o: { name: string; model: string }): Promise<{ id: string; clientId: string; clientSecret: string }> {
  const newest = ctx.db.prepare("SELECT MAX(created_at) AS t FROM devices WHERE user_id = ?").get(user.id) as { t: number | null };
  if (newest.t !== null && ctx.clock.now() - newest.t < 30_000) throw httpError("too_many_requests", "a device was paired less than 30 s ago — try again shortly");
  const name = String(o.name || "device").slice(0, 80);
  const tok = await ctx.deviceTokens.mint(`${ctx.config.instanceName} device ${user.email} ${name}`);
  const id = randomId();
  const now = ctx.clock.now();
  try {
    ctx.db
      .prepare("INSERT INTO devices(id, user_id, name, model, client_id, service_token_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, user.id, name, String(o.model || "").slice(0, 40), tok.clientId, tok.id, now, now);
  } catch (e) {
    await ctx.deviceTokens.revoke(tok.id).catch(() => {});
    throw e;
  }
  return { id, clientId: tok.clientId, clientSecret: tok.clientSecret };
}

export async function revokeDevice(ctx: Ctx, d: DeviceRow): Promise<void> {
  ctx.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(ctx.clock.now(), d.id);
  await ctx.deviceTokens.revoke(d.service_token_id);
}

async function revokeDevices(ctx: Ctx, userId: string): Promise<void> {
  for (const d of listDevices(ctx, userId)) {
    try {
      await revokeDevice(ctx, d);
    } catch (e) {
      ctx.log("device revoke at Cloudflare failed (the server already refuses it)", { device: d.id, error: (e as Error).message });
    }
  }
}
