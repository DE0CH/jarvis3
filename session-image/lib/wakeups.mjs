// Wakeups, channel posts and the task inbox, session side (docs/API.md section 12):
//   - the request a wakeup tool call / `jarvis-wakeup` command line becomes (POST /api/session/wakeups)
//   - wall-clock times in the owner's zone (JARVIS_TIME_ZONE) turned into instants
//   - the inbox delivery: messages the server queued for this task go to the task's main agent as
//     ONE new user message, only while that agent is not mid-turn (a send would interrupt it, and
//     a message must never be taken as the answer to something pending: lessons/52 of Jarvis 1)
//
// Pure functions and one small class with its I/O injected; test/wakeups.test.mjs covers them.

/** "90s", "15m", "2h", "3d", or a bare number of seconds -> seconds. */
export function parseDuration(s) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?\s*$/i.exec(String(s ?? ""));
  if (!m) throw new Error(`"${s}" is not a duration (e.g. 90s, 15m, 2h, 3d)`);
  const n = Number(m[1]);
  const unit = (m[2] || "s").toLowerCase()[0];
  return Math.round(n * { s: 1, m: 60, h: 3600, d: 86400 }[unit]);
}

/** Offset of `tz` from UTC at instant `t`, ms (wall clock minus UTC). */
function offsetMs(tz, t) {
  const p = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t)))
    p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
}

/**
 * An ISO time. With an offset or Z it is taken as is; without one ("2026-10-12T09:00", or "09:00"
 * meaning the next such time) it is a wall-clock time in `tz`.
 */
export function toInstant(text, tz, now = Date.now()) {
  const s = String(text ?? "").trim();
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(s)) {
    const t = Date.parse(s);
    if (!Number.isFinite(t)) throw new Error(`"${s}" is not a time`);
    return new Date(t).toISOString();
  }
  const instant = (wall) => {
    // two passes find the instant whose wall clock in tz is `wall` (DST-safe except inside a gap)
    const t = wall - offsetMs(tz, wall);
    return wall - offsetMs(tz, t);
  };
  let m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?)?$/.exec(s);
  if (m) return new Date(instant(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 9), +(m[5] ?? 0), +(m[6] ?? 0)))).toISOString();
  if ((m = /^(\d\d?):(\d\d)$/.exec(s))) {
    const today = new Date(now + offsetMs(tz, now)); // the wall-clock date in tz, read with UTC getters
    let wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), +m[1], +m[2]);
    if (instant(wall) <= now) wall += 86400_000;
    return new Date(instant(wall)).toISOString();
  }
  throw new Error(`"${s}" is not a time (ISO like 2026-10-12T09:00, or HH:MM)`);
}

/** The tool call's arguments (or the command line's options) as a SessionWakeupRequest. */
export function wakeupRequest(a, { tz = "UTC", now = Date.now() } = {}) {
  const req = { prompt: a.prompt };
  if (a.name) req.name = a.name;
  const ways = ["in", "at", "cron", "checkUrl"].filter((k) => a[k] !== undefined && a[k] !== null && a[k] !== "");
  if (ways.length !== 1) throw new Error("say exactly one of: in (a delay), at (a time), cron (a schedule) or a check URL");
  if (a.in !== undefined && a.in !== null && a.in !== "") req.inSeconds = typeof a.in === "number" ? a.in : parseDuration(a.in);
  if (a.at) req.at = toInstant(a.at, a.timeZone || tz, now);
  if (a.cron) {
    req.cron = a.cron;
    req.timeZone = a.timeZone || tz;
  }
  if (a.checkUrl) {
    req.check = { url: a.checkUrl };
    if (a.status !== undefined && a.status !== null) req.check.status = Number(a.status);
    if (a.contains) req.check.contains = a.contains;
    if (a.absent) req.check.absent = a.absent;
    if (a.changed) req.check.changed = true;
    if (a.every) req.intervalSeconds = typeof a.every === "number" ? a.every : parseDuration(a.every);
    if (a.failPrompt) req.failPrompt = a.failPrompt;
  }
  if (a.until) req.until = toInstant(a.until, a.timeZone || tz, now);
  return req;
}

/** One line per wakeup, for the agent. */
export function describeWakeup(w) {
  const when =
    w.kind === "check"
      ? `when ${w.check.url} ${[w.check.status !== undefined && `answers ${w.check.status}`, w.check.contains && `contains "${w.check.contains}"`, w.check.absent && `no longer contains "${w.check.absent}"`, w.check.changed && "changes"].filter(Boolean).join(" and ")} (checked every ${w.intervalSeconds}s until ${w.expiresAt})`
      : w.cron
        ? `${w.cron} (${w.timeZone})${w.expiresAt ? ` until ${w.expiresAt}` : ""}, next ${w.at}`
        : `at ${w.at}`;
  return `- ${w.name} [${w.state}${w.lastError ? `; ${w.lastError}` : ""}]: ${when}: "${w.prompt.slice(0, 120)}"`;
}

/** Several queued messages become one user message. */
export const combine = (messages) => messages.map((m) => m.text).join("\n\n");

/**
 * Delivers the inbox to the main agent. `io`:
 *   fetchInbox(waitSeconds) -> InboxMessage[]       (GET /api/session/inbox)
 *   ack(id)                                         (POST /api/session/inbox/:id/ack)
 *   agentState() -> {exists, busy}                  the main agent, as the daemon sees it
 *   send(text)                                      a new user message to the main agent (or a new main agent)
 *   delivered: {has(id), add(ids)}                  ids already handed over (kept across restarts)
 *   sleep(ms), log(msg, extra)
 */
export class InboxDelivery {
  constructor(io, { waitSeconds = 50, busyPollMs = 2000 } = {}) {
    this.io = io;
    this.waitSeconds = waitSeconds;
    this.busyPollMs = busyPollMs;
    this.stopped = false;
  }
  stop() {
    this.stopped = true;
  }
  /** One round: wait for mail, deliver what is new once the agent is free, ack everything. Returns what was delivered. */
  async once() {
    const msgs = await this.io.fetchInbox(this.waitSeconds);
    if (!msgs.length) return [];
    const fresh = msgs.filter((m) => !this.io.delivered.has(m.id));
    if (fresh.length) {
      for (;;) {
        if (this.stopped) return [];
        const s = await this.io.agentState();
        if (!s.busy) break;
        await this.io.sleep(this.busyPollMs);
      }
      // anything that arrived while we waited goes in the same message
      const later = (await this.io.fetchInbox(0)).filter((m) => !this.io.delivered.has(m.id) && !fresh.some((f) => f.id === m.id));
      const batch = [...fresh, ...later];
      await this.io.send(combine(batch));
      this.io.delivered.add(batch.map((m) => m.id));
      this.io.log("inbox delivered", { messages: batch.map((m) => m.id) });
      for (const m of later) msgs.push(m);
    }
    for (const m of msgs) await this.io.ack(m.id);
    return fresh;
  }
  async run() {
    while (!this.stopped) {
      try {
        await this.once();
      } catch (e) {
        this.io.log("inbox delivery failed; retrying", { error: e.message });
        await this.io.sleep(5000);
      }
    }
  }
}
