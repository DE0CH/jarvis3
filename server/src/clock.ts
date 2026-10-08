/** Injected everywhere time matters, so tests can move it. */
export interface Clock {
  now(): number; // ms epoch
}
export const systemClock: Clock = { now: () => Date.now() };

export const iso = (ms: number): string => new Date(ms).toISOString();
/** UTC calendar month "YYYY-MM". */
export const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7);
export function monthBounds(ms: number): { start: number; end: number } {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}
