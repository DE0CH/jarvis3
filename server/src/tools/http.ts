// Shared plumbing for the provider adapters: one JSON/text call with a timeout and an injectable
// fetch (tests), errors that never echo the organisation's key.
import { httpError } from "../errors.ts";

export interface AdapterOptions {
  /** The organisation's credential (from the env var the config names). */
  key: string;
  /** Replaces the provider's API origin (tests, stubs). */
  baseUrl?: string;
  fetch?: typeof fetch;
  pricing?: { perCallUsd?: number; perCreditUsd?: number; perGbUsd?: number };
  settings?: Record<string, unknown>;
}

export const TIMEOUT_MS = 90_000;

/** A provider error (no key in the message; the body is cut short). */
export function providerError(provider: string, status: number, text: string) {
  return httpError("upstream", `${provider} answered ${status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
}

export async function callJson<T>(f: typeof fetch, provider: string, url: string, init: RequestInit): Promise<T> {
  const r = await f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  if (!r.ok) throw providerError(provider, r.status, text);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw providerError(provider, r.status, "not JSON");
  }
}

export const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const strSetting = (s: Record<string, unknown> | undefined, k: string, d: string): string => (typeof s?.[k] === "string" && s[k] ? (s[k] as string) : d);
