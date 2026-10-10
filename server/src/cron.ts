// Five-field cron expressions evaluated in an IANA time zone (scheduled tasks, recurring wakeups).
//
//   minute hour day-of-month month day-of-week
//   "*", "5", "1-5", "*/15", "1-30/2", "1,15", month names JAN..DEC, weekday names SUN..SAT (0 or 7 = Sunday)
//
// Day-of-month and day-of-week follow classic cron: when both are restricted, a day matches if
// either does. Times are wall-clock times in the zone. A time that doesn't exist on a
// spring-forward day is skipped that day; one that happens twice on a fall-back day can fire twice.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
  source: string;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export class CronError extends Error {}

function parseField(text: string, min: number, max: number, names: string[] | null, nameBase: number): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  const value = (s: string): number => {
    const up = s.toUpperCase();
    if (names) {
      const i = names.indexOf(up);
      if (i >= 0) return i + nameBase;
    }
    if (!/^\d{1,2}$/.test(s)) throw new CronError(`"${s}" is not a number`);
    return Number(s);
  };
  for (const part of text.split(",")) {
    if (!part) throw new CronError(`empty item in "${text}"`);
    const [range, stepText] = part.split("/") as [string, string | undefined];
    if (part.split("/").length > 2) throw new CronError(`"${part}" has two steps`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || (stepText !== undefined && !/^\d{1,2}$/.test(stepText))) throw new CronError(`bad step in "${part}"`);
    let lo: number, hi: number;
    if (range === "*") [lo, hi] = [min, max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-") as [string, string];
      [lo, hi] = [value(a), value(b)];
    } else {
      lo = value(range);
      hi = stepText === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`"${part}" is outside ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { set, star: text === "*" || text.startsWith("*/") };
}

export function parseCron(expr: unknown): Cron {
  if (typeof expr !== "string" || expr.length > 120) throw new CronError("a schedule is five fields: minute hour day month weekday");
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new CronError("a schedule is five fields: minute hour day month weekday");
  const minute = parseField(f[0]!, 0, 59, null, 0);
  const hour = parseField(f[1]!, 0, 23, null, 0);
  const dom = parseField(f[2]!, 1, 31, null, 0);
  const month = parseField(f[3]!, 1, 12, MONTHS, 1);
  const dowRaw = parseField(f[4]!, 0, 7, DAYS, 0);
  const dow = new Set([...dowRaw.set].map((d) => (d === 7 ? 0 : d)));
  return { minute: minute.set, hour: hour.set, dom: dom.set, month: month.set, dow, domStar: dom.star, dowStar: dowRaw.star, source: f.join(" ") };
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Local {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dow: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

export function localParts(ms: number, tz: string): Local {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour! % 24, minute: +p.minute!, dow: DAYS.indexOf(p.weekday!.toUpperCase().slice(0, 3)) };
}

function dayMatches(c: Cron, l: Local): boolean {
  if (!c.month.has(l.month)) return false;
  const d = c.dom.has(l.day);
  const w = c.dow.has(l.dow);
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return w;
  if (c.dowStar) return d;
  return d || w;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How far ahead nextRun looks before giving up (covers "Feb 29" schedules). */
const HORIZON = 5 * 366 * 24 * HOUR;

/** The first firing strictly after `after` (ms epoch), or null if none within five years. */
export function nextRun(c: Cron, tz: string, after: number): number | null {
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const end = after + HORIZON;
  while (t <= end) {
    const l = localParts(t, tz);
    // jump by whole hours while the day or hour can't match: never past a matching minute, since
    // every zone's offset is a whole number of minutes and an hour boundary is always visited
    if (!dayMatches(c, l) || !c.hour.has(l.hour)) {
      t += HOUR - l.minute * MINUTE;
      continue;
    }
    if (c.minute.has(l.minute)) return t;
    t += MINUTE;
  }
  return null;
}

/** The next `n` firings after `after`. */
export function nextRuns(c: Cron, tz: string, after: number, n: number): number[] {
  const out: number[] = [];
  let t = after;
  while (out.length < n) {
    const x = nextRun(c, tz, t);
    if (x === null) break;
    out.push(x);
    t = x;
  }
  return out;
}

/** The shortest gap (minutes) between consecutive firings over the next `sample` firings. */
export function shortestGapMinutes(c: Cron, tz: string, after: number, sample = 60): number | null {
  const runs = nextRuns(c, tz, after, sample);
  if (runs.length < 2) return null;
  let min = Infinity;
  for (let i = 1; i < runs.length; i++) min = Math.min(min, (runs[i]! - runs[i - 1]!) / MINUTE);
  return min;
}
