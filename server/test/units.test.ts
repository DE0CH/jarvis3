// Small units: sealing, tokens, migrations, config validation, and the real provider clients
// against fake HTTP (Fly, S3, Cloudflare). Nothing here talks to a real service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Sealer, mintToken, sha256hex, verifyToken } from "../src/crypto.ts";
import { migrate, openDb, SCHEMA_VERSION } from "../src/db.ts";
import { validateConfig } from "../src/config.ts";
import { FlyMachines } from "../src/fly.ts";
import { S3BlobStore } from "../src/s3.ts";
import { CloudflareDeviceTokens } from "../src/cloudflare-devices.ts";
import { testConfig } from "./helpers.ts";

test("Sealer: round trip; bound to its row; wrong key fails", () => {
  const k = randomBytes(32).toString("base64");
  const s = new Sealer(k);
  const sealed = s.seal("sk-or-v1-secret", "openrouter:u1");
  assert.match(sealed, /^v1:/);
  assert.ok(!sealed.includes("secret"));
  assert.equal(s.open(sealed, "openrouter:u1"), "sk-or-v1-secret");
  assert.throws(() => s.open(sealed, "openrouter:u2"));
  assert.throws(() => new Sealer(randomBytes(32).toString("base64")).open(sealed, "openrouter:u1"));
  assert.throws(() => new Sealer("c2hvcnQ="), /32 bytes/);
});

test("session tokens: only the hash is compared, in constant time", () => {
  const t = mintToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(verifyToken(t, sha256hex(t)), true);
  assert.equal(verifyToken(t + "x", sha256hex(t)), false);
  assert.equal(verifyToken(t, "short"), false);
  assert.equal(verifyToken("", sha256hex("")), false);
  assert.equal(verifyToken(t, null), false);
});

test("migrations: apply to the current version and are idempotent", () => {
  const db = openDb(":memory:");
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.equal(migrate(db), SCHEMA_VERSION);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  for (const t of ["users", "devices", "openrouter_keys", "tasks", "machine_runs", "personal_layers", "personal_layer_versions", "notices", "kv"]) assert.ok(tables.includes(t), t);
});

test("config validation", () => {
  assert.doesNotThrow(() => testConfig());
  const bad = (over: object, re: RegExp) => assert.throws(() => validateConfig({ ...testConfig(), ...over }), re);
  bad({ publicUrl: "http://x" }, /publicUrl/);
  bad({ publicUrl: "https://x/path" }, /publicUrl/);
  bad({ defaultModel: "nope" }, /defaultModel/);
  bad({ roles: { staff: { openrouterMonthlyUsd: 1, machineHoursPerMonth: 1 } } }, /admin: true/);
  bad({ directory: { kind: "google", domain: "d", subject: "s", groupRoles: { "g@example.org": "ghost" } } }, /unknown role/);
  bad({ daemonPath: "ws" }, /daemonPath/);
});

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };
function fakeHttp(answer: (c: Call, n: number) => Response) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (input instanceof Request ? input.method : init?.method) || "GET";
    const hdrs: Record<string, string> = {};
    new Headers(input instanceof Request ? input.headers : (init?.headers as ConstructorParameters<typeof Headers>[0])).forEach((v, k) => (hdrs[k] = v));
    const raw = init?.body;
    const c = { method, url, body: typeof raw === "string" ? JSON.parse(raw) : null, headers: hdrs };
    calls.push(c);
    return answer(c, calls.length);
  }) as typeof fetch;
  return { f, calls };
}

test("FlyMachines: create payload, 429 retry, exec, destroy of a gone machine", async () => {
  const { f, calls } = fakeHttp((c, n) => {
    if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
    if (c.method === "POST" && c.url.endsWith("/machines")) return Response.json({ id: "m1", name: "task-x", state: "created", config: { metadata: { a: "b" } } });
    if (c.url.includes("/exec")) return Response.json({ stdout: "started\n", exit_code: 0 });
    if (c.method === "DELETE") return new Response("not found", { status: 404 });
    return Response.json({});
  });
  const slept: number[] = [];
  const fly = new FlyMachines({ token: "fly-token", app: "example-sessions", region: "ams", fetch: f, sleep: async (ms) => void slept.push(ms) });
  const m = await fly.create({ name: "task-x", image: "img", env: { A: "1" }, metadata: { a: "b" }, guest: { cpu_kind: "shared", cpus: 1, memory_mb: 1024 } });
  assert.equal(m.id, "m1");
  assert.deepEqual(slept, [1000]);
  const create = calls[1]!;
  assert.equal(create.url, "https://api.machines.dev/v1/apps/example-sessions/machines");
  assert.equal(create.headers.authorization, "Bearer fly-token");
  assert.deepEqual((create.body as { config: { rootfs: unknown } }).config.rootfs, { size_gb: 16 });
  assert.equal((create.body as { skip_launch: boolean }).skip_launch, true);
  assert.deepEqual(await fly.exec("m1", ["echo"]), { stdout: "started\n", stderr: "", exitCode: 0 });
  await fly.destroy("m1"); // 404 = already gone
  assert.match(calls.at(-1)!.url, /machines\/m1\?force=true$/);
});

test("S3BlobStore: signed requests, presigned URLs carry a signature and expiry, copy uses x-amz-copy-source", async () => {
  const { f, calls } = fakeHttp((c) => (c.method === "HEAD" ? new Response(null, { status: 404 }) : new Response("", { status: 200 })));
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    const s3 = new S3BlobStore({ endpoint: "https://s3.example.org", region: "eu", bucket: "bkt", accessKeyId: "AK", secretAccessKey: "SK" });
    await s3.put("snapshots/t1/state.tar.gz", "x");
    assert.equal(calls[0]!.url, "https://s3.example.org/bkt/snapshots/t1/state.tar.gz");
    assert.match(calls[0]!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AK\//);
    assert.equal(await s3.exists("nope"), false);
    await s3.copy("a/b c", "d/e");
    assert.equal(calls.at(-1)!.headers["x-amz-copy-source"], "/bkt/a/b%20c");
    const url = new URL(await s3.presignPut("snapshots/t1/state.tar.gz", 600));
    assert.equal(url.pathname, "/bkt/snapshots/t1/state.tar.gz");
    assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
    assert.ok(url.searchParams.get("X-Amz-Signature"));
    assert.ok(!url.toString().includes("SK"), "the secret never appears in a URL");
  } finally {
    globalThis.fetch = real;
  }
});

test("CloudflareDeviceTokens: mint and revoke (already gone is fine)", async () => {
  const { f, calls } = fakeHttp((c) =>
    c.method === "POST"
      ? Response.json({ success: true, result: { id: "tok1", client_id: "cid.access", client_secret: "sec" } })
      : Response.json({ success: false, errors: [{ code: 1000, message: "not found" }] }, { status: 404 }),
  );
  const cf = new CloudflareDeviceTokens("cf-token", "acct123", f);
  assert.deepEqual(await cf.mint("example device a@example.org phone"), { id: "tok1", clientId: "cid.access", clientSecret: "sec" });
  assert.equal(calls[0]!.url, "https://api.cloudflare.com/client/v4/accounts/acct123/access/service_tokens");
  assert.deepEqual(calls[0]!.body, { name: "example device a@example.org phone", duration: "forever" });
  await cf.revoke("tok1");
  assert.match(calls[1]!.url, /service_tokens\/tok1$/);
});
