// The app's web build at the instance root (src/web.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { harness, asEmail, asService, call, seedUsers, type Harness } from "./helpers.ts";
import { WebApp } from "../src/web.ts";

function webDir(): string {
  const root = mkdtempSync(join(tmpdir(), "jarvis3-web-"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Jarvis</title>");
  mkdirSync(join(root, "_expo/static/js/web"), { recursive: true });
  writeFileSync(join(root, "_expo/static/js/web/entry-0123abcd.js"), "console.log(1)");
  writeFileSync(join(root, "favicon.ico"), "ico");
  writeFileSync(join(root, "jarvis3-push-sw.js"), "self.addEventListener('push', () => {})");
  writeFileSync(join(root, "..", "outside-secret.txt"), "nope");
  return root;
}

async function withWeb(fn: (h: Harness) => Promise<void>) {
  const h = await harness({ webDir: webDir() });
  try {
    await seedUsers(h);
    await fn(h);
  } finally {
    await h.close();
  }
}

const get = async (h: Harness, jwt: string | null, path: string, method = "GET") => {
  const r = await fetch(h.base + path, { method, headers: jwt ? { "cf-access-jwt-assertion": jwt } : {} });
  return { status: r.status, headers: r.headers, text: await r.text() };
};

/** A request with a raw (unnormalised) path, as an attacker would send it. */
const rawGet = (h: Harness, jwt: string, path: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const u = new URL(h.base);
    const req = request({ host: u.hostname, port: u.port, path, headers: { "cf-access-jwt-assertion": jwt } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject);
    req.end();
  });

test("the web build is served at the root with a valid Access JWT; app routes get index.html", () =>
  withWeb(async (h) => {
    const jwt = (await asEmail(h, "alice@example.org")).jwt!;
    const root = await get(h, jwt, "/");
    assert.equal(root.status, 200);
    assert.match(root.text, /<title>Jarvis<\/title>/);
    assert.equal(root.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(root.headers.get("cache-control"), "no-cache");
    assert.equal(root.headers.get("x-frame-options"), "DENY");
    assert.equal(root.headers.get("x-content-type-options"), "nosniff");
    for (const route of ["/tasks", "/tasks/7ce0326a5435ab61", "/me/layer", "/admin/users"]) {
      const r = await get(h, jwt, route);
      assert.equal(r.status, 200, route);
      assert.match(r.text, /<title>Jarvis/, route);
    }
    const js = await get(h, jwt, "/_expo/static/js/web/entry-0123abcd.js");
    assert.equal(js.text, "console.log(1)");
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(js.headers.get("cache-control"), "public, max-age=31536000, immutable");
    // the push service worker is re-checked on every registration
    const sw = await get(h, jwt, "/jarvis3-push-sw.js");
    assert.equal(sw.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(sw.headers.get("cache-control"), "no-cache");
    const head = await get(h, jwt, "/favicon.ico", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "3");
    assert.equal((await get(h, jwt, "/missing.png")).status, 404, "a missing asset is not the app");
  }));

test("no JWT or a bad one: 401; a valid JWT of a non-member still gets the page; /api keeps its own 404", () =>
  withWeb(async (h) => {
    const none = await get(h, null, "/");
    assert.equal(none.status, 401);
    assert.equal(JSON.parse(none.text).error.code, "unauthenticated");
    assert.equal((await get(h, "not.a.jwt", "/tasks")).status, 401);
    assert.equal((await get(h, (await asEmail(h, "stranger@example.net")).jwt!, "/")).status, 200);
    assert.equal((await get(h, (await asService(h, "some-device.access")).jwt!, "/")).status, 200);
    const api = await call(h, await asEmail(h, "alice@example.org"), "GET", "/api/nope");
    assert.equal(api.status, 404);
    assert.equal(api.body.error.code, "not_found");
    assert.equal((await call(h, null, "GET", "/api/health")).status, 200);
    const post = await fetch(h.base + "/", { method: "POST", headers: { "cf-access-jwt-assertion": (await asEmail(h, "alice@example.org")).jwt! } });
    assert.equal(post.status, 404);
  }));

test("paths can't leave the web directory", () =>
  withWeb(async (h) => {
    const jwt = (await asEmail(h, "alice@example.org")).jwt!;
    for (const p of ["/../outside-secret.txt", "/%2e%2e/outside-secret.txt", "/..%2foutside-secret.txt", "/%00.js"]) {
      const r = await rawGet(h, jwt, p);
      assert.ok(!r.body.includes("nope"), p);
      assert.ok(r.status === 404 || (r.status === 200 && r.body.includes("<title>Jarvis")), `${p} -> ${r.status}`);
    }
  }));

test("WebApp refuses a directory without index.html", () => {
  assert.throws(() => new WebApp(mkdtempSync(join(tmpdir(), "jarvis3-empty-"))), /no index.html/);
});
