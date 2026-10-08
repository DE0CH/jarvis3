// Access JWT edge cases, with tokens signed by a test key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { harness, seedUsers, call, TEAM, AUD, type Harness } from "./helpers.ts";

async function withUsers(fn: (h: Harness, u: Awaited<ReturnType<typeof seedUsers>>) => Promise<void>) {
  const h = await harness();
  try {
    await fn(h, await seedUsers(h));
  } finally {
    await h.close();
  }
}

const get = (h: Harness, jwt: string | null, extra: Record<string, string> = {}) =>
  fetch(h.base + "/api/me", { headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...extra } });

test("a valid identity token for a member is accepted (header and cookie)", () =>
  withUsers(async (h, u) => {
    const jwt = await h.signer.sign({ email: u.alice });
    assert.equal((await get(h, jwt)).status, 200);
    const viaCookie = await get(h, null, { cookie: `other=1; CF_Authorization=${jwt}` });
    assert.equal(viaCookie.status, 200);
    // email matching is case-insensitive
    assert.equal((await get(h, await h.signer.sign({ email: u.alice.toUpperCase() }))).status, 200);
  }));

test("wrong audience, wrong issuer, expired, unknown key, forged signature, alg none, garbage -> 401", () =>
  withUsers(async (h, u) => {
    const now = Math.floor(h.clock.now() / 1000);
    const cases: [string, string][] = [
      ["wrong audience", await h.signer.sign({ email: u.alice }, { aud: "another-app" })],
      ["wrong issuer", await h.signer.sign({ email: u.alice }, { iss: "https://evil.cloudflareaccess.com" })],
      ["expired", await h.signer.sign({ email: u.alice }, { iat: now - 7200, exp: now - 60 })],
      ["unknown kid", await h.signer.sign({ email: u.alice }, { kid: "other-key" })],
    ];
    const { privateKey } = await generateKeyPair("RS256");
    cases.push([
      "forged signature",
      await new SignJWT({ email: u.alice }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setExpirationTime(now + 600).sign(privateKey),
    ]);
    cases.push(["alg none", new UnsecuredJWT({ email: u.alice }).setIssuer(`https://${TEAM}`).setAudience(AUD).setExpirationTime(now + 600).encode()]);
    cases.push(["garbage", "not.a.jwt"]);
    for (const [name, jwt] of cases) {
      const r = await get(h, jwt);
      assert.equal(r.status, 401, name);
      assert.equal(((await r.json()) as { error: { code: string } }).error.code, "unauthenticated", name);
    }
  }));

test("a token whose nbf lies in the future is refused even when signed by the right key", () =>
  withUsers(async (h, u) => {
    const now = Math.floor(h.clock.now() / 1000);
    const jwt = await h.signer.sign({ email: u.alice, nbf: now + 600 });
    assert.equal((await get(h, jwt)).status, 401);
    h.clock.advance(601_000);
    assert.equal((await get(h, jwt)).status, 200, "valid once nbf has passed");
  }));

test("expiry follows the server clock (with 5 s tolerance)", () =>
  withUsers(async (h, u) => {
    const now = Math.floor(h.clock.now() / 1000);
    const jwt = await h.signer.sign({ email: u.alice }, { exp: now + 60 });
    assert.equal((await get(h, jwt)).status, 200);
    h.clock.advance(64_000);
    assert.equal((await get(h, jwt)).status, 200, "within tolerance");
    h.clock.advance(10_000);
    assert.equal((await get(h, jwt)).status, 401);
  }));

test("a token with neither email nor common_name is refused; missing token is 401", () =>
  withUsers(async (h) => {
    assert.equal((await get(h, await h.signer.sign({ sub: "x" }))).status, 401);
    assert.equal((await get(h, await h.signer.sign({ email: "" }))).status, 401);
    assert.equal((await get(h, null)).status, 401);
  }));

test("a valid token for an unknown email, or an unknown service token, is 403 even past Access", () =>
  withUsers(async (h) => {
    assert.equal((await get(h, await h.signer.sign({ email: "outsider@example.net" }))).status, 403);
    assert.equal((await get(h, await h.signer.sign({ common_name: "random.access" }))).status, 403);
  }));

test("client-sent identity headers are ignored: only the verified JWT counts", () =>
  withUsers(async (h, u) => {
    const r = await call(h, null, "GET", "/api/me");
    assert.equal(r.status, 401);
    const spoof = await fetch(h.base + "/api/me", { headers: { "x-access-email": u.admin, "cf-access-authenticated-user-email": u.admin } });
    assert.equal(spoof.status, 401);
  }));
