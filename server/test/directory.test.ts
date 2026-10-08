// Directory sync: groups -> roles, suspension and removal and their effects, failure safety,
// and the Google Directory client against a fake Google.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8 } from "jose";
import { harness, seedUsers, call, asEmail, asService, createTask, fakeSession, openWs, closed, type Harness } from "./helpers.ts";
import { GoogleDirectory, StaticDirectory } from "../src/directory-google.ts";

async function run(fn: (h: Harness) => Promise<void>, config?: Parameters<typeof harness>[0]) {
  const h = await harness(config);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}
const me = async (h: Harness, email: string) => call(h, await asEmail(h, email), "GET", "/api/me");

test("groups map to roles; first role in config order wins; unmapped users are not members", () =>
  run(async (h) => {
    h.directory.set("both@example.org", { groups: ["jarvis-staff@example.org", "JARVIS-ADMIN@example.org"] });
    h.directory.set("staff@example.org", { groups: ["jarvis-staff@example.org"] });
    h.directory.set("nogroup@example.org", { groups: ["marketing@example.org"] });
    h.directory.set("suspended-new@example.org", { groups: ["jarvis-staff@example.org"], suspended: true });
    const r = await h.jarvis.syncDirectory();
    assert.deepEqual(r.added.sort(), ["both@example.org", "staff@example.org"]);
    assert.equal((await me(h, "both@example.org")).body.user.role, "admin");
    assert.equal((await me(h, "staff@example.org")).body.user.role, "staff");
    assert.equal((await me(h, "nogroup@example.org")).status, 403);
    assert.equal((await me(h, "suspended-new@example.org")).status, 403);
  }));

test("bootstrap admins are admins whatever their groups; suspension still wins", () =>
  run(
    async (h) => {
      h.directory.set("owner@example.org", { groups: [] });
      await h.jarvis.syncDirectory();
      const r = await me(h, "owner@example.org");
      assert.equal(r.body.user.role, "admin");
      assert.equal(r.body.user.isAdmin, true);
      h.directory.set("owner@example.org", { suspended: true });
      await h.jarvis.syncDirectory();
      assert.equal((await me(h, "owner@example.org")).status, 403);
    },
    { config: { bootstrapAdmins: ["Owner@example.org"] } },
  ));

test("suspension: 403 at once, sessions paused, OpenRouter key deleted, devices revoked, open daemon sockets closed", () =>
  run(async (h) => {
    const { alice } = await seedUsers(h);
    const c = await asEmail(h, alice);
    const task = await createTask(h, alice);
    const s = await fakeSession(h, task);
    const pair = await call(h, c, "GET", "/api/devices/pair?state=abcdefghijklmnop1234&name=phone");
    const clientId = new URL(pair.headers.get("location")!).searchParams.get("clientId")!;
    const deviceCred = await asService(h, clientId);
    assert.equal((await call(h, deviceCred, "GET", "/api/me")).status, 200);
    const app = await openWs(h, c, `/api/tasks/${task}/daemon`);
    const appClosed = closed(app);
    assert.equal(h.keys.keys.size, 1);

    h.directory.set(alice, { suspended: true });
    const r = await h.jarvis.syncDirectory();
    assert.deepEqual(r.offboarded, [alice]);
    assert.equal((await appClosed).code, 4403);
    assert.equal((await me(h, alice)).status, 403);
    assert.equal((await call(h, deviceCred, "GET", "/api/me")).status, 403);
    await h.jarvis.settle();
    assert.equal(h.keys.keys.size, 0, "key deleted at OpenRouter");
    assert.ok(h.keys.log.some((l) => l.startsWith("delete ")));
    assert.equal(h.deviceTokens.tokens.size, 0, "device token deleted at Cloudflare");
    assert.equal(h.machines.machines.size, 0, "machine destroyed");
    const admin = await asEmail(h, "admin@example.org");
    const t = await call(h, admin, "GET", `/api/tasks/${task}`);
    assert.equal(t.body.state, "paused");
    assert.equal(t.body.pausedReason, "offboarded");
    // the task and the personal layer are kept for the organisation
    const users = await call(h, admin, "GET", "/api/users");
    assert.equal(users.body.users.find((u: { user: { email: string } }) => u.user.email === alice).user.status, "suspended");
    s.ws.close();
  }));

test("offboarding destroys the machine even if its snapshot fails", () =>
  run(async (h) => {
    const { alice } = await seedUsers(h);
    const task = await createTask(h, alice);
    h.machines.failSnapshot = "broken";
    h.directory.set(alice, { suspended: true });
    await h.jarvis.syncDirectory();
    await h.jarvis.settle();
    assert.equal(h.machines.machines.size, 0);
    const t = await call(h, await asEmail(h, "admin@example.org"), "GET", `/api/tasks/${task}`);
    assert.equal(t.body.state, "paused");
    assert.match(t.body.error, /snapshot failed/);
  }));

test("leaving every mapped group, or the directory, offboards as removed; coming back reactivates", () =>
  run(async (h) => {
    const { alice, bob } = await seedUsers(h);
    h.directory.set(alice, { groups: ["marketing@example.org"] });
    h.directory.remove(bob);
    const r = await h.jarvis.syncDirectory();
    assert.deepEqual(r.offboarded.sort(), [alice, bob]);
    assert.equal((await me(h, alice)).status, 403);
    const list = await call(h, await asEmail(h, "admin@example.org"), "GET", "/api/users");
    assert.equal(list.body.users.find((u: { user: { email: string } }) => u.user.email === bob).user.status, "removed");
    h.directory.set(alice, { groups: ["jarvis-staff@example.org"] });
    const back = await h.jarvis.syncDirectory();
    assert.deepEqual(back.reactivated, [alice]);
    assert.equal((await me(h, alice)).status, 200);
  }));

test("a reactivated user gets a fresh OpenRouter key on their next task", () =>
  run(async (h) => {
    const { alice } = await seedUsers(h);
    await createTask(h, alice);
    h.directory.set(alice, { suspended: true });
    await h.jarvis.syncDirectory();
    await h.jarvis.settle();
    assert.equal(h.keys.keys.size, 0);
    h.directory.set(alice, { suspended: false });
    await h.jarvis.syncDirectory();
    await createTask(h, alice);
    assert.equal(h.keys.keys.size, 1);
  }));

test("a failing or empty directory changes nothing", () =>
  run(async (h) => {
    const { alice } = await seedUsers(h);
    h.directory.fail = "503 from Google";
    const r1 = await h.jarvis.syncDirectory();
    assert.equal(r1.ok, false);
    assert.match(r1.error!, /nothing changed/);
    assert.equal((await me(h, alice)).status, 200);
    h.directory.fail = null;
    const saved = h.directory.users;
    h.directory.users = [];
    const r2 = await h.jarvis.syncDirectory();
    assert.equal(r2.ok, false);
    assert.equal((await me(h, alice)).status, 200);
    h.directory.users = saved;
  }));

test("a role change updates the user's OpenRouter limit", () =>
  run(async (h) => {
    const { alice } = await seedUsers(h);
    await createTask(h, alice);
    const [k] = [...h.keys.keys.values()];
    assert.equal(k!.limit, 20);
    h.directory.set(alice, { groups: ["jarvis-admin@example.org"] });
    const r = await h.jarvis.syncDirectory();
    assert.deepEqual(r.updated, [alice]);
    assert.equal(k!.limit, 100);
  }));

test("admin can trigger a sync through the API", () =>
  run(async (h) => {
    const { admin } = await seedUsers(h);
    h.directory.set("new@example.org", { groups: ["jarvis-staff@example.org"] });
    const r = await call(h, await asEmail(h, admin), "POST", "/api/admin/directory/sync");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.added, ["new@example.org"]);
  }));

test("static directory: the config's member list", async () => {
  const d = new StaticDirectory([{ email: "Me@Example.org", role: "admin" }]);
  assert.deepEqual(await d.listUsers(), [{ email: "me@example.org", name: "", suspended: false, groups: [], role: "admin" }]);
  await run(
    async (h) => {
      await h.jarvis.syncDirectory();
      // the harness wires FakeDirectory; StaticDirectory roles flow through roleFor via `role`
      h.directory.users = await d.listUsers();
      await h.jarvis.syncDirectory();
      assert.equal((await me(h, "me@example.org")).body.user.role, "admin");
    },
  );
});

test("GoogleDirectory: service-account token exchange, paging, derived group membership", async () => {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const sa = JSON.stringify({ client_email: "reader@example-project.iam.gserviceaccount.com", private_key: await exportPKCS8(privateKey) });
  const calls: string[] = [];
  let tokenRequests = 0;
  const fakeFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "oauth2.googleapis.com") {
      tokenRequests++;
      const body = new URLSearchParams(String(init?.body));
      assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const claims = JSON.parse(Buffer.from(body.get("assertion")!.split(".")[1]!, "base64url").toString());
      assert.equal(claims.sub, "it-admin@example.org");
      assert.match(claims.scope, /admin\.directory\.user\.readonly/);
      assert.match(claims.scope, /admin\.directory\.group\.member\.readonly/);
      return json({ access_token: "ya29.test", expires_in: 3600 });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer ya29.test");
    if (url.pathname === "/admin/directory/v1/users") {
      assert.equal(url.searchParams.get("domain"), "example.org");
      if (!url.searchParams.get("pageToken")) return json({ users: [{ primaryEmail: "A@example.org", name: { fullName: "A" } }], nextPageToken: "p2" });
      return json({ users: [{ primaryEmail: "b@example.org", suspended: true }, { primaryEmail: "c@example.org", archived: true }] });
    }
    if (url.pathname.startsWith("/admin/directory/v1/groups/")) {
      assert.equal(url.searchParams.get("includeDerivedMembership"), "true");
      return json({ members: [{ email: "a@example.org", type: "USER" }, { email: "nested-group@example.org", type: "GROUP" }] });
    }
    return json({}, 404);
  }) as typeof fetch;
  const g = new GoogleDirectory({ serviceAccountJson: sa, domain: "example.org", subject: "it-admin@example.org", groups: ["jarvis-staff@example.org"], fetch: fakeFetch });
  const users = await g.listUsers();
  assert.deepEqual(users, [
    { email: "a@example.org", name: "A", suspended: false, groups: ["jarvis-staff@example.org"] },
    { email: "b@example.org", name: "", suspended: true, groups: [] },
    { email: "c@example.org", name: "", suspended: true, groups: [] },
  ]);
  await g.listUsers();
  assert.equal(tokenRequests, 1, "the access token is cached");
});
