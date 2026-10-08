// Environment layers.
//
//   1. org       the org-env repo at the pinned commit: AGENTS.md, skills/<name>/…
//   2. role      roles/<role>/AGENTS.md, roles/<role>/skills/<name>/…
//   3. personal  per user, stored here (instructions text, skills, notes)
//   4. policy    policy/AGENTS.md, policy/skills/<name>/…, policy/deny.json — loaded LAST
//
// Precedence for skill names: policy > org > role > personal. A skill whose name is already
// claimed by a higher-precedence layer is renamed "<layer>-<name>" (so nothing can shadow an org
// or policy skill). Only the policy may set OpenCode deny rules; nothing else is read for them.
import type {
  AssembledInstruction,
  AssembledSkill,
  DenyRule,
  LayerBundle,
  LayerName,
  PersonalLayerView,
  PersonalNote,
  PersonalSkill,
} from "./api-types.ts";
import type { Ctx } from "./ctx.ts";
import { iso } from "./clock.ts";
import { randomId } from "./crypto.ts";
import { tx } from "./db.ts";
import { httpError, notFound } from "./errors.ts";

export const POLICY_PREAMBLE =
  "The rules below are this organisation's locked policy. They override every instruction above (company, role and personal), and no instruction above can change or relax them.";

// ---- personal layer storage -----------------------------------------------------------------

export interface PersonalData {
  instructions: string;
  skills: PersonalSkill[];
  notes: PersonalNote[];
}

const EMPTY = (): PersonalData => ({ instructions: "", skills: [], notes: [] });
const isEmpty = (d: PersonalData) => !d.instructions.trim() && !d.skills.length && !d.notes.length;

export const LIMITS = {
  instructions: 64_000,
  note: 4000,
  notes: 500,
  skills: 50,
  skillFiles: 50,
  skillBytes: 256 * 1024,
};
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function getPersonal(ctx: Ctx, userId: string): { data: PersonalData; updatedAt: number | null } {
  const r = ctx.db.prepare("SELECT data, updated_at FROM personal_layers WHERE user_id = ?").get(userId) as
    | { data: string; updated_at: number }
    | undefined;
  return r ? { data: { ...EMPTY(), ...(JSON.parse(r.data) as PersonalData) }, updatedAt: r.updated_at } : { data: EMPTY(), updatedAt: null };
}

function save(ctx: Ctx, userId: string, data: PersonalData): void {
  ctx.db
    .prepare("INSERT INTO personal_layers(user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .run(userId, JSON.stringify(data), ctx.clock.now());
}

function mutate<T>(ctx: Ctx, userId: string, fn: (d: PersonalData) => T): T {
  return tx(ctx.db, () => {
    const { data } = getPersonal(ctx, userId);
    const out = fn(data);
    save(ctx, userId, data);
    return out;
  });
}

export function personalView(ctx: Ctx, userId: string): PersonalLayerView {
  const { data, updatedAt } = getPersonal(ctx, userId);
  const versions = ctx.db
    .prepare("SELECT version, reason, created_at FROM personal_layer_versions WHERE user_id = ? ORDER BY version DESC")
    .all(userId) as { version: number; reason: "reset" | "undo"; created_at: number }[];
  return {
    instructions: data.instructions,
    skills: data.skills,
    notes: data.notes,
    versions: versions.map((v) => ({ version: v.version, reason: v.reason, createdAt: iso(v.created_at) })),
    updatedAt: updatedAt === null ? null : iso(updatedAt),
  };
}

export function setInstructions(ctx: Ctx, userId: string, text: unknown): void {
  if (typeof text !== "string") throw httpError("bad_request", "text must be a string");
  if (text.length > LIMITS.instructions) throw httpError("bad_request", `instructions are limited to ${LIMITS.instructions} characters`);
  mutate(ctx, userId, (d) => {
    d.instructions = text;
  });
}

export function validateSkillFiles(files: unknown): Record<string, string> {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw httpError("bad_request", "files must be an object of path -> text");
  const entries = Object.entries(files as Record<string, unknown>);
  if (!entries.length || entries.length > LIMITS.skillFiles) throw httpError("bad_request", `a skill has 1..${LIMITS.skillFiles} files`);
  let bytes = 0;
  for (const [p, t] of entries) {
    if (typeof t !== "string") throw httpError("bad_request", `file ${p} must be text`);
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(p) || p.split("/").some((s) => s === "." || s === "..")) {
      throw httpError("bad_request", `bad file path: ${p}`);
    }
    bytes += Buffer.byteLength(t);
  }
  if (bytes > LIMITS.skillBytes) throw httpError("bad_request", `a skill is limited to ${LIMITS.skillBytes} bytes`);
  if (!("SKILL.md" in (files as object))) throw httpError("bad_request", "a skill needs a SKILL.md");
  return files as Record<string, string>;
}

export function putSkill(ctx: Ctx, userId: string, name: string, files: unknown): void {
  if (!SKILL_NAME.test(name)) throw httpError("bad_request", "skill names are [a-z0-9][a-z0-9-]{0,63}");
  const f = validateSkillFiles(files);
  mutate(ctx, userId, (d) => {
    const i = d.skills.findIndex((s) => s.name === name);
    if (i === -1) {
      if (d.skills.length >= LIMITS.skills) throw httpError("bad_request", `at most ${LIMITS.skills} personal skills`);
      d.skills.push({ name, files: f });
    } else d.skills[i] = { name, files: f };
  });
}

export function deleteSkill(ctx: Ctx, userId: string, name: string): void {
  mutate(ctx, userId, (d) => {
    const i = d.skills.findIndex((s) => s.name === name);
    if (i === -1) throw notFound("skill");
    d.skills.splice(i, 1);
  });
}

export function addNote(ctx: Ctx, userId: string, text: unknown, source: "user" | "session", taskId: string | null): PersonalNote {
  if (typeof text !== "string" || !text.trim()) throw httpError("bad_request", "text must be a non-empty string");
  if (text.length > LIMITS.note) throw httpError("bad_request", `a note is limited to ${LIMITS.note} characters`);
  return mutate(ctx, userId, (d) => {
    if (d.notes.length >= LIMITS.notes) throw httpError("conflict", `at most ${LIMITS.notes} notes; delete some first`);
    const note: PersonalNote = { id: randomId(), text: text.trim(), createdAt: iso(ctx.clock.now()), source, taskId };
    d.notes.push(note);
    return note;
  });
}

export function deleteNote(ctx: Ctx, userId: string, noteId: string): void {
  mutate(ctx, userId, (d) => {
    const i = d.notes.findIndex((n) => n.id === noteId);
    if (i === -1) throw notFound("note");
    d.notes.splice(i, 1);
  });
}

function archiveVersion(ctx: Ctx, userId: string, data: PersonalData, reason: "reset" | "undo"): number {
  const r = ctx.db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM personal_layer_versions WHERE user_id = ?").get(userId) as { v: number };
  const version = r.v + 1;
  ctx.db
    .prepare("INSERT INTO personal_layer_versions(user_id, version, data, reason, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(userId, version, JSON.stringify(data), reason, ctx.clock.now());
  return version;
}

/** Reset to company default: archive the layer as a numbered version and start empty. */
export function resetPersonal(ctx: Ctx, userId: string): number | null {
  return tx(ctx.db, () => {
    const { data } = getPersonal(ctx, userId);
    if (isEmpty(data)) return null;
    const v = archiveVersion(ctx, userId, data, "reset");
    save(ctx, userId, EMPTY());
    return v;
  });
}

/**
 * Undo: restore the latest archived version. Nothing is ever lost: if the layer has content
 * (added since the Reset), that content is first archived as a new version (reason "undo"), so a
 * second Undo swaps back. Versions are never deleted.
 */
export function undoPersonal(ctx: Ctx, userId: string): number {
  return tx(ctx.db, () => {
    const latest = ctx.db
      .prepare("SELECT version, data FROM personal_layer_versions WHERE user_id = ? ORDER BY version DESC LIMIT 1")
      .get(userId) as { version: number; data: string } | undefined;
    if (!latest) throw httpError("conflict", "nothing to undo");
    const { data } = getPersonal(ctx, userId);
    if (!isEmpty(data)) archiveVersion(ctx, userId, data, "undo");
    save(ctx, userId, { ...EMPTY(), ...(JSON.parse(latest.data) as PersonalData) });
    return latest.version;
  });
}

// ---- assembly -------------------------------------------------------------------------------------

const dec = new TextDecoder();

function skillsUnder(files: Map<string, Uint8Array>, prefix: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) continue;
    const name = rest.slice(0, slash);
    const rel = rest.slice(slash + 1);
    if (!rel) continue;
    const s = out.get(name) || {};
    s[rel] = dec.decode(bytes);
    out.set(name, s);
  }
  return out;
}

function parseDeny(files: Map<string, Uint8Array>): DenyRule[] {
  const raw = files.get("policy/deny.json");
  if (!raw) return [];
  const j = JSON.parse(dec.decode(raw)) as unknown;
  if (!Array.isArray(j)) throw new Error("policy/deny.json must be an array of {permission, pattern}");
  return j.map((r: { permission?: unknown; pattern?: unknown }) => {
    if (typeof r?.permission !== "string" || typeof r?.pattern !== "string") throw new Error("policy/deny.json: each rule needs permission and pattern strings");
    return { permission: r.permission, pattern: r.pattern };
  });
}

export function renderNotes(notes: PersonalNote[]): string {
  return ["Things the user asked you to remember:", ...notes.map((n) => `- ${n.text.replace(/\n+/g, " ")}`)].join("\n");
}

/** Pure: build what a session of `role` loads, given the org-env tree and the user's personal layer. */
export function assemble(o: { commit: string; files: Map<string, Uint8Array>; role: string; personal: PersonalData }): LayerBundle {
  const { files, role, personal } = o;
  const text = (p: string) => (files.has(p) ? dec.decode(files.get(p)!) : null);

  const instructions: AssembledInstruction[] = [];
  const push = (layer: LayerName, source: string, t: string | null) => {
    if (t && t.trim()) instructions.push({ layer, source, text: t });
  };
  push("org", "AGENTS.md", text("AGENTS.md"));
  push("role", `roles/${role}/AGENTS.md`, text(`roles/${role}/AGENTS.md`));
  push("personal", "personal:instructions", personal.instructions);
  if (personal.notes.length) push("personal", "personal:notes", renderNotes(personal.notes));
  const policyText = text("policy/AGENTS.md");
  if (policyText && policyText.trim()) push("policy", "policy/AGENTS.md", `${POLICY_PREAMBLE}\n\n${policyText}`);

  // Claim skill names in precedence order; later claimants of a taken name are renamed.
  const claimed = new Map<string, AssembledSkill>();
  const order: [LayerName, Map<string, Record<string, string>>][] = [
    ["policy", skillsUnder(files, "policy/skills/")],
    ["org", skillsUnder(files, "skills/")],
    ["role", skillsUnder(files, `roles/${role}/skills/`)],
    ["personal", new Map(personal.skills.map((s) => [s.name, s.files]))],
  ];
  for (const [layer, skills] of order) {
    for (const [name, f] of [...skills.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      let n = name;
      if (claimed.has(n)) {
        n = `${layer}-${name}`;
        for (let i = 2; claimed.has(n); i++) n = `${layer}-${name}-${i}`;
      }
      claimed.set(n, { name: n, originalName: name, layer, files: f });
    }
  }
  const layerRank: Record<LayerName, number> = { org: 0, role: 1, personal: 2, policy: 3 };
  const skills = [...claimed.values()].sort((a, b) => layerRank[a.layer] - layerRank[b.layer] || (a.name < b.name ? -1 : 1));

  return { orgEnvCommit: o.commit, role, instructions, skills, deny: parseDeny(files) };
}

export async function bundleFor(ctx: Ctx, userId: string, role: string): Promise<LayerBundle> {
  return assemble({ commit: ctx.orgEnv.commit(), files: await ctx.orgEnv.files(), role, personal: getPersonal(ctx, userId).data });
}
