import type { ErrorCode } from "./api-types.ts";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  device_revoked: 403,
  not_found: 404,
  bad_request: 400,
  conflict: 409,
  busy: 409,
  machine_hours_cap: 429,
  instance_budget: 429,
  too_many_requests: 429,
  upstream: 502,
  unavailable: 503,
  internal: 500,
};

export class HttpError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
  }
}

export const httpError = (code: ErrorCode, message: string): HttpError => new HttpError(code, message);

/** The one "you can't see this" answer: identical for "doesn't exist" and "not yours". */
export const notFound = (what = "resource"): HttpError => new HttpError("not_found", `no such ${what}`);

export function asHttpError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new HttpError("internal", msg.slice(0, 500));
}
