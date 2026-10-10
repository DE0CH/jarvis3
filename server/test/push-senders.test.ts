// The real push senders against local stand-ins: APNs (an HTTP/2 TLS server) and a Web Push
// service (an HTTPS server). Checks what goes over the wire: Apple's headers and provider JWT, the
// environment fallback, the VAPID header and an aes128gcm body the subscriber can decrypt.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createECDH, generateKeyPairSync, createPublicKey } from "node:crypto";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { createServer as createHttpsServer, Agent, type Server as HttpsServer } from "node:https";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { jwtVerify, decodeProtectedHeader } from "jose";
import webpush from "web-push";
import { RealPushSender, type PushMessage } from "../src/push.ts";

const require = createRequire(import.meta.url);
const ece = require("http_ece") as { decrypt(buf: Buffer, o: Record<string, unknown>): Buffer };

let cert = "", key = "", dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "push-test-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  cert = readFileSync(join(dir, "c.pem"), "utf8");
  key = readFileSync(join(dir, "k.pem"), "utf8");
});
after(() => rmSync(dir, { recursive: true, force: true }));

const MESSAGE: PushMessage = { title: "Approval needed", body: "Open Jarvis to see it.", badge: 3, data: { jarvis3: "notice", noticeId: "n1", kind: "approval_needed", pushKind: "approval_needed", approvalId: "ap1" }, thread: "approval_needed" };
const TOKEN = "ab".repeat(32);

interface Seen {
  host: "production" | "sandbox";
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

async function fakeApple(answer: (s: Seen) => { status: number; reason?: string }): Promise<{ hosts: { production: string; sandbox: string }; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const servers: Http2SecureServer[] = [];
  const hosts = { production: "", sandbox: "" };
  for (const which of ["production", "sandbox"] as const) {
    const srv = createSecureServer({ key, cert });
    srv.on("stream", (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const s: Seen = { host: which, path: String(headers[":path"]), headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)])), body: JSON.parse(Buffer.concat(chunks).toString()) };
        seen.push(s);
        const a = answer(s);
        stream.respond({ ":status": a.status, "apns-id": "id-1", "content-type": "application/json" });
        stream.end(a.status === 200 ? "" : JSON.stringify({ reason: a.reason }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    hosts[which] = `https://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    servers.push(srv);
  }
  return { hosts, seen, close: async () => void (await Promise.all(servers.map((s) => new Promise((r) => s.close(r))))) };
}

function apnsKey(): { pem: string; publicKey: ReturnType<typeof createPublicKey> } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey };
}

const apnsConfig = { apns: { teamId: "TEAM123456", keyId: "KEY1234567", bundleId: "org.example.jarvis" } };

test("APNs: headers, provider JWT, payload without private content", async () => {
  const apple = await fakeApple(() => ({ status: 200 }));
  const k = apnsKey();
  const sender = new RealPushSender(apnsConfig, { apnsKeyP8: k.pem, vapidPrivateKey: "" }, { apnsHosts: apple.hosts, apnsConnect: { ca: cert } });
  try {
    const out = await sender.send({ kind: "apns", address: TOKEN, p256dh: null, auth: null, environment: null }, MESSAGE);
    assert.deepEqual(out, { ok: true, status: 200, environment: "production" });
    const [s] = apple.seen;
    assert.equal(s!.host, "production", "a token that didn't say goes to production");
    assert.equal(s!.path, `/3/device/${TOKEN}`);
    assert.equal(s!.headers["apns-topic"], "org.example.jarvis");
    assert.equal(s!.headers["apns-push-type"], "alert");
    const jwt = s!.headers.authorization!.replace(/^bearer /, "");
    assert.deepEqual(decodeProtectedHeader(jwt), { alg: "ES256", kid: "KEY1234567" });
    const { payload } = await jwtVerify(jwt, k.publicKey);
    assert.equal(payload.iss, "TEAM123456");
    const body = s!.body as { aps: { alert: { title: string; body: string }; badge: number }; body: Record<string, string> };
    assert.deepEqual(body.aps.alert, { title: "Approval needed", body: "Open Jarvis to see it." });
    assert.equal(body.aps.badge, 3);
    assert.equal(body.body.approvalId, "ap1");
    // the JWT is reused, not minted per push
    await sender.send({ kind: "apns", address: TOKEN, p256dh: null, auth: null, environment: "production" }, MESSAGE);
    assert.equal(apple.seen[1]!.headers.authorization, s!.headers.authorization);
  } finally {
    sender.close();
    await apple.close();
  }
});

test("APNs: a token of the other environment falls back once; a dead token is gone", async () => {
  // the token is a sandbox (simulator / development) token: production says BadDeviceToken
  const apple = await fakeApple((s) => (s.path.endsWith("dead".padEnd(64, "0")) ? { status: 410, reason: "Unregistered" } : s.host === "sandbox" ? { status: 200 } : { status: 400, reason: "BadDeviceToken" }));
  const k = apnsKey();
  const sender = new RealPushSender(apnsConfig, { apnsKeyP8: k.pem, vapidPrivateKey: "" }, { apnsHosts: apple.hosts, apnsConnect: { ca: cert } });
  try {
    const out = await sender.send({ kind: "apns", address: TOKEN, p256dh: null, auth: null, environment: null }, MESSAGE);
    assert.deepEqual(out, { ok: true, status: 200, environment: "sandbox" });
    assert.deepEqual(apple.seen.map((s) => s.host), ["production", "sandbox"]);
    const dead = await sender.send({ kind: "apns", address: "dead".padEnd(64, "0"), p256dh: null, auth: null, environment: "sandbox" }, MESSAGE);
    assert.equal(dead.ok, false);
    assert.equal(dead.ok === false && dead.gone, true);
    assert.match(dead.ok === false ? dead.error : "", /Unregistered \(410, sandbox\)/);
  } finally {
    sender.close();
    await apple.close();
  }
});

test("APNs: a token bad in both environments is gone", async () => {
  const apple = await fakeApple(() => ({ status: 400, reason: "BadDeviceToken" }));
  const sender = new RealPushSender(apnsConfig, { apnsKeyP8: apnsKey().pem, vapidPrivateKey: "" }, { apnsHosts: apple.hosts, apnsConnect: { ca: cert } });
  try {
    const out = await sender.send({ kind: "apns", address: TOKEN, p256dh: null, auth: null, environment: "production" }, MESSAGE);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.gone, true);
    assert.equal(out.ok === false && out.error, "BadDeviceToken (400, production); BadDeviceToken (400, sandbox)");
  } finally {
    sender.close();
    await apple.close();
  }
});

test("Web Push: VAPID, aes128gcm the browser can decrypt, gone on 410", async () => {
  const vapid = webpush.generateVAPIDKeys();
  const browser = createECDH("prime256v1");
  browser.generateKeys();
  const authSecret = Buffer.alloc(16, 9).toString("base64url");
  const got: { headers: Record<string, string | string[] | undefined>; body: Buffer; path: string }[] = [];
  let status = 201;
  const srv: HttpsServer = createHttpsServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url ?? "" });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const host = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const sender = new RealPushSender(
    { webPush: { subject: "mailto:ops@example.org", publicKey: vapid.publicKey, allowedHosts: [host] } },
    { apnsKeyP8: "", vapidPrivateKey: vapid.privateKey },
    { webAgent: new Agent({ ca: cert }) },
  );
  const target = { kind: "web" as const, address: `https://${host}/push/abc`, p256dh: browser.getPublicKey().toString("base64url"), auth: authSecret, environment: null };
  try {
    assert.deepEqual(await sender.send(target, MESSAGE), { ok: true, status: 201 });
    const [r] = got;
    assert.equal(r!.path, "/push/abc");
    assert.equal(r!.headers["content-encoding"], "aes128gcm");
    assert.equal(r!.headers.ttl, "86400");
    assert.match(String(r!.headers.authorization), new RegExp(`^vapid t=[^,]+, k=${vapid.publicKey}$`));
    const plain = JSON.parse(ece.decrypt(r!.body, { version: "aes128gcm", privateKey: browser, authSecret }).toString("utf8"));
    assert.deepEqual(plain, { title: "Approval needed", body: "Open Jarvis to see it.", badge: 3, tag: "approval_needed", data: MESSAGE.data });
    // an endpoint off the allowed hosts is never contacted
    const off = await sender.send({ ...target, address: "https://127.0.0.2:1/x" }, MESSAGE);
    assert.equal(off.ok, false);
    assert.equal(got.length, 1);
    status = 410;
    const gone = await sender.send(target, MESSAGE);
    assert.equal(gone.ok === false && gone.gone, true);
  } finally {
    sender.close();
    await new Promise((r) => srv.close(r));
  }
});

test("push config and secrets are checked at start", async () => {
  const { testConfig } = await import("./helpers.ts");
  const { loadPushSecrets } = await import("../src/config.ts");
  const pub = webpush.generateVAPIDKeys();
  assert.throws(() => testConfig({ push: { apns: { teamId: "short", keyId: "KEY1234567", bundleId: "a.b" } } }), /teamId/);
  assert.throws(() => testConfig({ push: { webPush: { subject: "ops@example.org", publicKey: pub.publicKey } } }), /subject/);
  assert.throws(() => testConfig({ push: { webPush: { subject: "mailto:ops@example.org", publicKey: "nope" } } }), /publicKey/);
  const c = testConfig({ push: { apns: { teamId: "TEAM123456", keyId: "KEY1234567", bundleId: "a.b" }, webPush: { subject: "mailto:ops@example.org", publicKey: pub.publicKey } } });
  assert.throws(() => loadPushSecrets(c, {}), /APNS_KEY_P8/);
  assert.throws(() => loadPushSecrets(c, { APNS_KEY_P8: apnsKey().pem }), /VAPID_PRIVATE_KEY/);
  assert.equal(loadPushSecrets(c, { APNS_KEY_P8: apnsKey().pem, VAPID_PRIVATE_KEY: pub.privateKey }).vapidPrivateKey, pub.privateKey);
  // no push config: no secrets needed
  assert.deepEqual(loadPushSecrets(testConfig(), {}), { apnsKeyP8: "", vapidPrivateKey: "" });
});
