// Cron expressions in a time zone (server/src/cron.ts) and the condition checks' address guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CronError, nextRun, nextRuns, parseCron, shortestGapMinutes, validTimeZone } from "../src/cron.ts";
import { checkUrl, isPublicAddress } from "../src/httpcheck.ts";

const T0 = Date.UTC(2026, 9, 8, 12, 0, 0); // Thu 8 Oct 2026 12:00 UTC
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

test("parse: fields, ranges, steps, lists and names", () => {
  const c = parseCron("*/15 9-17 * JAN,jun mon-FRI");
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.deepEqual([...c.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...c.month], [1, 6]);
  assert.deepEqual([...c.dow], [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron("0 0 * * 7").dow], [0], "7 is Sunday");
  assert.deepEqual([...parseCron("5/20 * * * *").minute], [5, 25, 45]);
  for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "*/0 * * * *", "1-x * * * *", "5-1 * * * *", "a b c d e", "1,,2 * * * *", 42])
    assert.throws(() => parseCron(bad), CronError, String(bad));
});

test("next run in a zone, across DST, with dom/dow semantics", () => {
  // 09:00 London on weekdays; Thu 8 Oct 12:00 UTC = 13:00 BST, so the next is Fri 9 Oct 08:00 UTC
  assert.equal(iso(nextRun(parseCron("0 9 * * 1-5"), "Europe/London", T0)), "2026-10-09T08:00:00.000Z");
  // after the clocks go back (25 Oct 2026), 09:00 London is 09:00 UTC
  const runs = nextRuns(parseCron("0 9 * * *"), "Europe/London", Date.UTC(2026, 9, 24, 12), 2).map(iso);
  assert.deepEqual(runs, ["2026-10-25T09:00:00.000Z", "2026-10-26T09:00:00.000Z"]);
  // a half-hour zone
  assert.equal(iso(nextRun(parseCron("30 8 * * *"), "Asia/Kolkata", T0)), "2026-10-09T03:00:00.000Z");
  // the minute itself is not "after"
  assert.equal(iso(nextRun(parseCron("0 12 * * *"), "UTC", T0)), "2026-10-09T12:00:00.000Z");
  // both day fields restricted: either matches (the 1st, or any Monday)
  const both = nextRuns(parseCron("0 0 1 * MON"), "UTC", T0, 3).map(iso);
  assert.deepEqual(both, ["2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z", "2026-10-26T00:00:00.000Z"]);
  // 29 Feb: years ahead, still found
  assert.equal(iso(nextRun(parseCron("0 0 29 2 *"), "UTC", T0)), "2028-02-29T00:00:00.000Z");
  // never (31 Feb)
  assert.equal(nextRun(parseCron("0 0 31 2 *"), "UTC", T0), null);
  // a spring-forward gap: 01:30 London doesn't exist on 29 Mar 2026; the 30th's still does
  assert.equal(iso(nextRun(parseCron("30 1 * * *"), "Europe/London", Date.UTC(2026, 2, 28, 12))), "2026-03-30T00:30:00.000Z");
});

test("shortest gap and time zone names", () => {
  assert.equal(shortestGapMinutes(parseCron("*/5 * * * *"), "UTC", T0), 5);
  assert.equal(shortestGapMinutes(parseCron("0 9,10 * * *"), "UTC", T0), 60);
  assert.equal(shortestGapMinutes(parseCron("0 0 31 2 *"), "UTC", T0), null);
  assert.ok(validTimeZone("Europe/London") && validTimeZone("UTC") && validTimeZone("Asia/Shanghai"));
  assert.ok(!validTimeZone("Mars/Base") && !validTimeZone("") && !validTimeZone(5));
});

test("condition checks reach only public HTTPS addresses", () => {
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.ok(isPublicAddress(a), a);
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:8.8.8.8", "224.0.0.1", "not-an-ip"])
    assert.ok(!isPublicAddress(a), a);
  assert.equal(checkUrl("https://example.org/status?x=1").hostname, "example.org");
  for (const u of ["http://example.org/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.1:8443/", "https://localhost/", "https://jarvis.svc/", "https://kubernetes.default.svc.cluster.local/", "https://u:p@example.org/", "ftp://x/", "nope", 7])
    assert.throws(() => checkUrl(u), String(u));
});
