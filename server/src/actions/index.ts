// The broker's action types. A named action in the config (`actions.<name>`) picks one of these
// types and gives it settings, credentials and a policy; the type knows its parameters, how to
// show a call to a person (the preview), what the policy rules look at (subjects, amount), and how
// to run it with credentials only the server holds. docs/ACTIONS.md describes them for operators.
import type { ActionParamView, ApprovalPreview } from "../api-types.ts";
import type { ActionConfig } from "../config.ts";
import type { Ctx } from "../ctx.ts";
import { httpError } from "../errors.ts";
import { smtpSend } from "./smtp.ts";
import { setBudget } from "./budget.ts";

export type Params = Record<string, unknown>;

export interface RunInput {
  ctx: Ctx;
  name: string;
  config: ActionConfig;
  /** This action's credentials (Tier 2), from the server's environment. */
  secrets: Record<string, string>;
  params: Params;
}

export interface ActionType {
  type: string;
  /** 2: a shared company asset. 3: infrastructure — only the owner approves, with a passkey. */
  tier: 2 | 3;
  params: Record<string, ActionParamView>;
  /** Settings the config must give (checked at start-up). */
  requiredSettings?: string[];
  /** Credentials the config must name (checked at start-up). */
  requiredCredentials?: string[];
  /** Check and normalise a call's parameters (throws 400 with a message the agent can act on). */
  validate(params: Params, config: ActionConfig): Params;
  /** Exactly what will happen, for the person deciding. */
  preview(params: Params, config: ActionConfig, ctx: Ctx): ApprovalPreview;
  /** What an allow-list rule checks (e.g. every recipient). */
  subjects?(params: Params, config: ActionConfig): string[];
  /** What a threshold rule checks (e.g. an amount). */
  amount?(params: Params, config: ActionConfig): number;
  /** Run it. The result goes back to the agent; keep it small and free of secrets. */
  run(input: RunInput): Promise<Record<string, unknown>>;
}

const TYPES = new Map<string, ActionType>([smtpSend, setBudget].map((t) => [t.type, t]));

/** Tests register extra types (e.g. a fake payment with an amount). */
export function registerActionType(t: ActionType): void {
  TYPES.set(t.type, t);
}

export function actionType(type: string): ActionType | null {
  return TYPES.get(type) ?? null;
}

/** Start-up check of the config's actions against their types. */
export function checkActions(actions: Record<string, ActionConfig> | undefined, secrets: Record<string, Record<string, string>>): void {
  for (const [name, a] of Object.entries(actions ?? {})) {
    const t = TYPES.get(a.type);
    if (!t) throw new Error(`config: actions.${name}: unknown type ${a.type} (known: ${[...TYPES.keys()].join(", ")})`);
    for (const s of t.requiredSettings ?? []) if (a.settings?.[s] === undefined) throw new Error(`config: actions.${name}: settings.${s} is required for ${a.type}`);
    for (const c of t.requiredCredentials ?? []) {
      if (!a.credentials?.[c]) throw new Error(`config: actions.${name}: credentials.${c} is required for ${a.type}`);
      if (!secrets[name]?.[c]) throw new Error(`config: actions.${name}: credential ${c} has no value`);
    }
  }
}

// ---- parameter helpers ----------------------------------------------------------------------------

export function str(params: Params, key: string, o: { max: number; required?: boolean; multiline?: boolean }): string {
  const v = params[key];
  if (v === undefined || v === null || v === "") {
    if (o.required === false) return "";
    throw httpError("bad_request", `${key} is required`);
  }
  if (typeof v !== "string") throw httpError("bad_request", `${key} must be a string`);
  if (v.length > o.max) throw httpError("bad_request", `${key} must be at most ${o.max} characters`);
  if (!o.multiline && /[\r\n]/.test(v)) throw httpError("bad_request", `${key} must be one line`);
  return v;
}

export const EMAIL = /^[^@\s<>",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function emails(params: Params, key: string, o: { required: boolean; max: number }): string[] {
  let v = params[key];
  if (v === undefined || v === null || v === "") v = [];
  if (typeof v === "string") v = v.split(/[,;]\s*/).filter(Boolean);
  if (!Array.isArray(v)) throw httpError("bad_request", `${key} must be a list of email addresses`);
  const out = v.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : ""));
  for (const e of out) if (!EMAIL.test(e)) throw httpError("bad_request", `${key}: not an email address: ${String(e).slice(0, 80)}`);
  if (o.required && !out.length) throw httpError("bad_request", `${key} needs at least one address`);
  if (out.length > o.max) throw httpError("bad_request", `${key}: at most ${o.max} addresses`);
  return [...new Set(out)];
}

/** "x@example.org" exactly, or "*@example.org" for any address of that domain. */
export function allowListed(subject: string, list: string[]): boolean {
  const s = subject.toLowerCase();
  return list.some((e) => {
    const p = e.toLowerCase();
    return p.startsWith("*@") ? s.endsWith(p.slice(1)) : s === p;
  });
}
