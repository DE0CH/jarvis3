// Session side of wakeups, channel posts and the inbox (lib/wakeups.mjs), plus the two commands
// against a fake jarvis-agent socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { InboxDelivery, combine, describeWakeup, parseDuration, toInstant, wakeupRequest } from "../lib/wakeups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0); // Thu 8 Oct 2026 12:00 UTC = 13:00 in London

test("durations and wall-clock times in the owner's zone", () => {
  assert.equal(parseDuration("90s"), 90);
  assert.equal(parseDuration("15m"), 900);
  assert.equal(parseDuration("2h"), 7200);
  assert.equal(parseDuration("1.5d"), 129600);
  assert.equal(parseDuration("45"), 45);
  assert.throws(() => parseDuration("soon"));
  assert.equal(toInstant("2026-10-12T09:00", "Europe/London", NOW), "2026-10-12T08:00:00.000Z");
  assert.equal(toInstant("2026-10-26T09:00", "Europe/London", NOW), "2026-10-26T09:00:00.000Z", "after the clocks go back");
  assert.equal(toInstant("2026-10-12", "Asia/Tokyo", NOW), "2026-10-12T00:00:00.000Z", "a date alone is 09:00 there");
  assert.equal(toInstant("09:00", "Europe/London", NOW), "2026-10-09T08:00:00.000Z", "already past today: tomorrow");
  assert.equal(toInstant("14:30", "Europe/London", NOW), "2026-10-08T13:30:00.000Z");
  assert.equal(toInstant("2026-10-12T09:00+02:00", "Europe/London", NOW), "2026-10-12T07:00:00.000Z", "an offset wins");
  assert.equal(toInstant("2026-10-12T09:00Z", "Asia/Tokyo", NOW), "2026-10-12T09:00:00.000Z");
  assert.throws(() => toInstant("next tuesday", "UTC", NOW));
});

test("tool arguments become the server's request", () => {
  assert.deepEqual(wakeupRequest({ prompt: "p", in: "2h", name: "x" }), { prompt: "p", name: "x", inSeconds: 7200 });
  assert.deepEqual(wakeupRequest({ prompt: "p", at: "09:00" }, { tz: "Europe/London", now: NOW }), { prompt: "p", at: "2026-10-09T08:00:00.000Z" });
  assert.deepEqual(wakeupRequest({ prompt: "p", cron: "0 9 * * MON" }, { tz: "Asia/Tokyo" }), { prompt: "p", cron: "0 9 * * MON", timeZone: "Asia/Tokyo" });
  assert.deepEqual(wakeupRequest({ prompt: "p", checkUrl: "https://ci.example.org/x", contains: "done", status: 200, changed: true, every: "10m", until: "2026-10-20T00:00Z", failPrompt: "f" }, { now: NOW }), {
    prompt: "p",
    check: { url: "https://ci.example.org/x", status: 200, contains: "done", changed: true },
    intervalSeconds: 600,
    failPrompt: "f",
    until: "2026-10-20T00:00:00.000Z",
  });
  assert.throws(() => wakeupRequest({ prompt: "p" }), /exactly one/);
  assert.throws(() => wakeupRequest({ prompt: "p", in: "1h", cron: "0 9 * * *" }), /exactly one/);
  const line = describeWakeup({ name: "ci", state: "armed", kind: "check", check: { url: "https://x", contains: "ok" }, intervalSeconds: 300, expiresAt: "2026-10-15T12:00:00.000Z", prompt: "go", lastError: null });
  assert.equal(line, '- ci [armed]: when https://x contains "ok" (checked every 300s until 2026-10-15T12:00:00.000Z): "go"');
});

function fakeIo({ inbox, busy = [] }) {
  const sent = [];
  const acked = [];
  const ids = new Set();
  const states = [...busy];
  return {
    sent,
    acked,
    io: {
      fetchInbox: async () => inbox.filter((m) => !acked.includes(m.id)),
      ack: async (id) => void acked.push(id),
      agentState: async () => ({ exists: true, busy: states.length ? states.shift() : false }),
      send: async (text) => void sent.push(text),
      delivered: { has: (id) => ids.has(id), add: (l) => l.forEach((i) => ids.add(i)) },
      sleep: async () => {},
      log: () => {},
    },
  };
}

test("the inbox waits until the agent is free, sends one message, acks everything", async () => {
  const msgs = [
    { id: "a", text: "[wakeup a]\nfirst" },
    { id: "b", text: "[wakeup b]\nsecond" },
  ];
  const f = fakeIo({ inbox: msgs, busy: [true, true, false] });
  const d = new InboxDelivery(f.io);
  const got = await d.once();
  assert.deepEqual(got.map((m) => m.id), ["a", "b"]);
  assert.deepEqual(f.sent, [combine(msgs)]);
  assert.equal(f.sent[0], "[wakeup a]\nfirst\n\n[wakeup b]\nsecond");
  assert.deepEqual(f.acked, ["a", "b"]);
  // nothing left: nothing sent
  assert.deepEqual(await d.once(), []);
  assert.equal(f.sent.length, 1);
});

test("a message delivered before a restart is acked, not delivered again", async () => {
  const f = fakeIo({ inbox: [{ id: "a", text: "x" }] });
  f.io.delivered.add(["a"]);
  await new InboxDelivery(f.io).once();
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.acked, ["a"]);
});

test("a failed send leaves the message unacked for the next round", async () => {
  const f = fakeIo({ inbox: [{ id: "a", text: "x" }] });
  f.io.send = async () => {
    throw new Error("daemon gone");
  };
  await assert.rejects(new InboxDelivery(f.io).once(), /daemon gone/);
  assert.deepEqual(f.acked, []);
});

// ---- the commands, against a fake jarvis-agent socket ----------------------------------------------

function fakeAgent() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-wakeup-"));
  const socket = join(dir, "agent.sock");
  const calls = [];
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      const reply = (s, b) => {
        res.writeHead(s, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      const w = { name: "x", state: "armed", kind: "time", at: "2026-10-09T08:00:00.000Z", prompt: "p", cron: null, lastError: null };
      if (req.method === "POST" && req.url === "/wakeups") return reply(201, { ...w, ...(calls.at(-1).body.name ? { name: calls.at(-1).body.name } : {}) });
      if (req.method === "GET" && req.url === "/wakeups") return reply(200, { wakeups: [w, { ...w, name: "old", state: "fired" }] });
      if (req.method === "DELETE" && req.url === "/wakeups/x") return reply(200, { ...w, state: "cancelled" });
      if (req.method === "DELETE") return reply(404, { error: { code: "not_found", message: "no such wakeup" } });
      if (req.method === "POST" && req.url === "/posts") return reply(201, { id: "p1", title: calls.at(-1).body.title ?? "First line" });
      reply(404, { error: "no" });
    });
  });
  return new Promise((r) => srv.listen(socket, () => r({ socket, calls, close: () => (srv.close(), rmSync(dir, { recursive: true, force: true })) })));
}

const run = (bin, args, env, input) =>
  new Promise((resolve) => {
    const p = execFile(process.execPath, [join(HERE, "..", "bin", bin), ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    if (input !== undefined) p.stdin.end(input);
  });

test("jarvis-wakeup and jarvis-post go through the agent socket", async () => {
  const a = await fakeAgent();
  const env = { JARVIS_AGENT_SOCKET: a.socket, JARVIS_LIB: join(HERE, "..", "lib"), JARVIS_TIME_ZONE: "Europe/London" };
  try {
    let r = await run("jarvis-wakeup", ["--name", "x", "--in", "2h", "Check", "the", "invoice"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Wakeup armed: x \[armed\]/);
    assert.deepEqual(a.calls.at(-1), { method: "POST", path: "/wakeups", body: { prompt: "Check the invoice", name: "x", inSeconds: 7200 } });
    r = await run("jarvis-wakeup", ["--check-url", "https://ci.example.org/1", "--contains", "completed", "--every", "5m", "CI done"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(a.calls.at(-1).body, { prompt: "CI done", check: { url: "https://ci.example.org/1", contains: "completed" }, intervalSeconds: 300 });
    r = await run("jarvis-wakeup", ["--cron", "0 9 * * MON", "Weekly"], env);
    assert.deepEqual(a.calls.at(-1).body, { prompt: "Weekly", cron: "0 9 * * MON", timeZone: "Europe/London" });
    r = await run("jarvis-wakeup", ["--list"], env);
    assert.equal(r.stdout.trim().split("\n").length, 1, "armed ones only");
    r = await run("jarvis-wakeup", ["--cancel", "x"], env);
    assert.match(r.stdout, /Cancelled the wakeup "x"/);
    r = await run("jarvis-wakeup", ["--cancel", "nope"], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no such wakeup/);
    r = await run("jarvis-wakeup", ["--in", "2h"], env);
    assert.equal(r.code, 1, "no prompt");
    r = await run("jarvis-wakeup", ["--bogus", "x", "p"], env);
    assert.equal(r.code, 1);
    r = await run("jarvis-post", ["--title", "Report", "## Done\n- 3 items"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(a.calls.at(-1).body, { text: "## Done\n- 3 items", title: "Report" });
    r = await run("jarvis-post", ["-"], env, "from stdin\n");
    assert.deepEqual(a.calls.at(-1).body, { text: "from stdin\n" });
    r = await run("jarvis-post", [], env);
    assert.equal(r.code, 2);
  } finally {
    a.close();
  }
});
