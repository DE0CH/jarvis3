// Projects (docs/API.md section 17): who sees and changes which Project, the limits, secrets sealed
// and never returned, tasks that pick Projects (clash refusal, the session's view, resume with a new
// clash, deletion), and offboarding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, asService, fakeSession, sessionTokenOf, machineOf, GATE, type Harness } from "./helpers.ts";

async function run(fn: (h: Harness, u: Awaited<ReturnType<typeof seedUsers>>) => Promise<void>) {
  const h = await harness();
  try {
    await fn(h, await seedUsers(h));
  } finally {
    await h.jarvis.settle();
    await h.close();
  }
}

const SECRET_A = "secret-value-alpha-7f3a";
const SECRET_B = "secret-value-beta-91c2";
const TOKEN = "github_pat_itest_0123456789";

const as = async (h: Harness, email: string) => asEmail(h, email);
/** Every value we stored as a secret: no user-facing answer may contain one. */
const noSecrets = (what: string, body: unknown) => {
  const s = JSON.stringify(body);
  for (const v of [SECRET_A, SECRET_B, TOKEN, "other-value"]) assert.ok(!s.includes(v), `${what} leaked a secret value`);
};

test("create, read, update, delete a private Project; limits and validation; no route returns a secret value", () =>
  run(async (h, u) => {
    const alice = await as(h, u.alice);
    const r = await call(h, alice, "POST", "/api/projects", {
      name: "  Website  ",
      description: "The company site",
      repos: [{ url: "https://github.com/example/site.git", ref: "main", tokenSecret: "GH_TOKEN" }, { url: "https://github.com/example/docs" }],
      secrets: { GH_TOKEN: TOKEN, API_KEY: SECRET_A },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    noSecrets("create", r.body);
    const p = r.body;
    assert.equal(p.name, "Website");
    assert.equal(p.shared, false);
    assert.deepEqual(p.roles, []);
    assert.equal(p.canEdit, true);
    assert.deepEqual(p.repos, [
      { url: "https://github.com/example/site.git", ref: "main", tokenSecret: "GH_TOKEN" },
      { url: "https://github.com/example/docs", ref: null, tokenSecret: null },
    ]);
    assert.deepEqual(p.secrets.map((s: { key: string }) => s.key), ["API_KEY", "GH_TOKEN"]);
    // sealed at rest
    const raw = JSON.stringify(h.jarvis.ctx.db.prepare("SELECT * FROM project_secrets").all());
    assert.ok(!raw.includes(SECRET_A) && !raw.includes(TOKEN), "secrets are sealed in the DB");

    const me = (await call(h, alice, "GET", "/api/me")).body;
    assert.equal(me.features.projects, true);
    const list = await call(h, alice, "GET", "/api/projects");
    noSecrets("list", list.body);
    assert.equal(list.body.projects.length, 1);
    assert.equal(list.body.roles, undefined, "role names are for admins");
    noSecrets("get", (await call(h, alice, "GET", `/api/projects/${p.id}`)).body);

    // PATCH: a value sets, null deletes, absent keeps; repos replace
    const up = await call(h, alice, "PATCH", `/api/projects/${p.id}`, { secrets: { API_KEY: SECRET_B, NEW_ONE: "other-value" }, description: "" });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    noSecrets("update", up.body);
    assert.deepEqual(up.body.secrets.map((s: { key: string }) => s.key), ["API_KEY", "GH_TOKEN", "NEW_ONE"]);
    assert.equal(up.body.description, "");
    // the token secret can't be deleted while a repo names it
    assert.equal((await call(h, alice, "PATCH", `/api/projects/${p.id}`, { secrets: { GH_TOKEN: null } })).status, 400);
    const up2 = await call(h, alice, "PATCH", `/api/projects/${p.id}`, { repos: [{ url: "https://gitlab.com/x/y.git" }], secrets: { GH_TOKEN: null, NEW_ONE: null } });
    assert.equal(up2.status, 200, JSON.stringify(up2.body));
    assert.deepEqual(up2.body.secrets.map((s: { key: string }) => s.key), ["API_KEY"]);
    assert.deepEqual(up2.body.repos, [{ url: "https://gitlab.com/x/y.git", ref: null, tokenSecret: null }]);
    assert.equal((await call(h, alice, "PATCH", `/api/projects/${p.id}`, { roles: ["staff"] })).status, 400, "roles are for shared projects");

    // validation
    const bad = async (body: unknown, why: string) => assert.equal((await call(h, alice, "POST", "/api/projects", body)).status, 400, why);
    await bad({ name: "" }, "empty name");
    await bad({ name: "x".repeat(81) }, "long name");
    await bad({ name: "x", description: "d".repeat(2001) }, "long description");
    await bad({ name: "x", repos: [{ url: "http://github.com/a/b" }] }, "http");
    await bad({ name: "x", repos: [{ url: "https://user:pw@github.com/a/b" }] }, "credentials in the url");
    await bad({ name: "x", repos: [{ url: "https://tok@github.com/a/b" }] }, "a token in the url");
    await bad({ name: "x", repos: [{ url: "git@github.com:a/b.git" }] }, "ssh");
    await bad({ name: "x", repos: [{ url: "https://github.com/a/b", ref: "--upload-pack=x" }] }, "ref");
    await bad({ name: "x", repos: [{ url: "https://github.com/a/b", ref: "a b" }] }, "ref with a space");
    await bad({ name: "x", repos: [{ url: "https://github.com/a/b", tokenSecret: "MISSING" }] }, "tokenSecret names no secret");
    await bad({ name: "x", repos: Array.from({ length: 11 }, (_, i) => ({ url: `https://github.com/a/r${i}` })) }, "11 repos");
    await bad({ name: "x", secrets: { lower: "v" } }, "lower-case key");
    await bad({ name: "x", secrets: { PATH: "v" } }, "reserved key");
    await bad({ name: "x", secrets: { JARVIS_URL: "v" } }, "reserved prefix");
    await bad({ name: "x", secrets: { OPENROUTER_API_KEY: "v" } }, "reserved prefix");
    await bad({ name: "x", secrets: { OK: "" } }, "empty value");
    await bad({ name: "x", secrets: { OK: "v".repeat(16385) } }, "value too long");
    await bad({ name: "x", secrets: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`K${i}`, "v"])) }, "51 secrets");
    await bad({ name: "x", roles: ["staff"] }, "roles on a private project");

    assert.equal((await call(h, alice, "DELETE", `/api/projects/${p.id}`)).status, 200);
    assert.equal((await call(h, alice, "GET", `/api/projects/${p.id}`)).status, 404);
    assert.equal(h.jarvis.ctx.db.prepare("SELECT count(*) AS n FROM project_secrets").get()!.n, 0);
  }));

test("at most 50 private Projects per person", () =>
  run(async (h, u) => {
    const alice = await as(h, u.alice);
    for (let i = 0; i < 50; i++) assert.equal((await call(h, alice, "POST", "/api/projects", { name: `p${i}` })).status, 201);
    assert.equal((await call(h, alice, "POST", "/api/projects", { name: "one too many" })).status, 409);
    // someone else still can
    assert.equal((await call(h, await as(h, u.bob), "POST", "/api/projects", { name: "bob's" })).status, 201);
  }));

test("who sees what: private Projects are their owner's only (admins included); shared ones by role; edit rights", () =>
  run(async (h, u) => {
    const alice = await as(h, u.alice);
    const bob = await as(h, u.bob);
    const admin = await as(h, u.admin);
    const priv = (await call(h, alice, "POST", "/api/projects", { name: "Alice's", secrets: { A: SECRET_A } })).body;
    // staff can't make shared ones
    assert.equal((await call(h, alice, "POST", "/api/projects", { name: "Shared?", shared: true, roles: ["staff"] })).status, 403);
    assert.equal((await call(h, admin, "POST", "/api/projects", { name: "Shared", shared: true, roles: [] })).status, 400, "a shared project needs a role");
    assert.equal((await call(h, admin, "POST", "/api/projects", { name: "Shared", shared: true, roles: ["nobody"] })).status, 400, "unknown role");
    const staffShared = (await call(h, admin, "POST", "/api/projects", { name: "Staff tools", shared: true, roles: ["staff"], secrets: { B: SECRET_B } })).body;
    assert.equal(staffShared.shared, true);
    assert.equal(staffShared.ownerId, null);
    assert.deepEqual(staffShared.roles, ["staff"]);
    const adminShared = (await call(h, admin, "POST", "/api/projects", { name: "Admin tools", shared: true, roles: ["admin"] })).body;
    const adminPriv = (await call(h, admin, "POST", "/api/projects", { name: "Admin's own" })).body;

    const names = async (c: Awaited<ReturnType<typeof as>>) => (await call(h, c, "GET", "/api/projects")).body.projects.map((p: { name: string }) => p.name).sort();
    assert.deepEqual(await names(alice), ["Alice's", "Staff tools"]);
    assert.deepEqual(await names(bob), ["Staff tools"]);
    assert.deepEqual(await names(admin), ["Admin tools", "Admin's own", "Staff tools"], "admins: their own + every shared one, never someone's private one");
    assert.deepEqual((await call(h, admin, "GET", "/api/projects")).body.roles, ["admin", "staff"]);

    // another person's private Project: the uniform 404, for admins too, on every route
    for (const c of [bob, admin]) {
      assert.equal((await call(h, c, "GET", `/api/projects/${priv.id}`)).status, 404);
      assert.equal((await call(h, c, "PATCH", `/api/projects/${priv.id}`, { name: "mine" })).status, 404);
      assert.equal((await call(h, c, "DELETE", `/api/projects/${priv.id}`)).status, 404);
    }
    assert.equal((await call(h, alice, "GET", `/api/projects/${adminPriv.id}`)).status, 404);
    // a shared one outside the caller's role: 404
    assert.equal((await call(h, alice, "GET", `/api/projects/${adminShared.id}`)).status, 404);
    assert.equal((await call(h, alice, "PATCH", `/api/projects/${adminShared.id}`, { name: "x" })).status, 404);
    // visible but not theirs to change: 403
    const seen = (await call(h, alice, "GET", `/api/projects/${staffShared.id}`)).body;
    assert.equal(seen.canEdit, false);
    assert.equal((await call(h, alice, "PATCH", `/api/projects/${staffShared.id}`, { name: "x" })).status, 403);
    assert.equal((await call(h, alice, "DELETE", `/api/projects/${staffShared.id}`)).status, 403);
    // any admin edits a shared one, roles included
    const up = await call(h, admin, "PATCH", `/api/projects/${staffShared.id}`, { roles: ["admin"] });
    assert.equal(up.status, 200);
    assert.equal(up.body.canEdit, true);
    assert.deepEqual(await names(alice), ["Alice's"], "staff lost it with the role change");
    assert.equal((await call(h, admin, "PATCH", `/api/projects/${staffShared.id}`, { roles: [] })).status, 400);
    // nothing anyone got back carried a value
    for (const c of [alice, bob, admin]) noSecrets("list", (await call(h, c, "GET", "/api/projects")).body);
  }));

test("a task with Projects: ids checked, clash refused, refs on the TaskView, values only to its session (not in the machine env)", () =>
  run(async (h, u) => {
    const alice = await as(h, u.alice);
    const bob = await as(h, u.bob);
    const admin = await as(h, u.admin);
    const site = (await call(h, alice, "POST", "/api/projects", {
      name: "Site",
      repos: [{ url: "https://github.com/example/site.git", ref: "main", tokenSecret: "GH_TOKEN" }, { url: "https://github.com/other/site" }],
      secrets: { GH_TOKEN: TOKEN, API_KEY: SECRET_A, SAME: "same" },
    })).body;
    const shared = (await call(h, admin, "POST", "/api/projects", { name: "Shared", shared: true, roles: ["staff"], repos: [{ url: "https://example.org/git/attachments.git" }], secrets: { SAME: "same", OTHER: SECRET_B } })).body;
    const clash = (await call(h, alice, "POST", "/api/projects", { name: "Clash", secrets: { API_KEY: SECRET_B } })).body;
    const bobs = (await call(h, bob, "POST", "/api/projects", { name: "Bob's" })).body;

    assert.equal((await call(h, alice, "POST", "/api/tasks", { prompt: "x", projects: [bobs.id] })).status, 400, "not visible to alice");
    assert.equal((await call(h, alice, "POST", "/api/tasks", { prompt: "x", projects: ["nope"] })).status, 400);
    assert.equal((await call(h, alice, "POST", "/api/tasks", { prompt: "x", projects: "nope" })).status, 400);
    assert.equal((await call(h, alice, "POST", "/api/tasks", { prompt: "x", projects: Array(11).fill(site.id) })).status, 400);
    const c = await call(h, alice, "POST", "/api/tasks", { prompt: "x", projects: [site.id, clash.id] });
    assert.equal(c.status, 400);
    assert.match(c.body.error.message, /API_KEY/);
    assert.match(c.body.error.message, /"Site"/);
    assert.match(c.body.error.message, /"Clash"/);
    noSecrets("clash error", c.body);
    assert.equal(h.machines.machines.size, 0, "nothing started");

    const r = await call(h, alice, "POST", "/api/tasks", { prompt: "x", projects: [site.id, shared.id] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.projects, [{ id: site.id, name: "Site" }, { id: shared.id, name: "Shared" }]);
    noSecrets("task", r.body);
    await h.jarvis.settle();
    const m = machineOf(h, r.body.id)!;
    noSecrets("machine env", m.env);
    // the session's view: repos with folders and the token, every secret
    const sess = await asService(h, GATE, sessionTokenOf(h, r.body.id));
    const sp = await call(h, sess, "GET", "/api/session/projects");
    assert.equal(sp.status, 200, JSON.stringify(sp.body));
    assert.deepEqual(sp.body.env, { GH_TOKEN: TOKEN, API_KEY: SECRET_A, SAME: "same", OTHER: SECRET_B });
    assert.deepEqual(sp.body.projects, [
      {
        id: site.id,
        name: "Site",
        repos: [
          { url: "https://github.com/example/site.git", ref: "main", dir: "site", token: TOKEN, tokenEnv: "GH_TOKEN" },
          { url: "https://github.com/other/site", ref: null, dir: "site-2" },
        ],
        secrets: ["API_KEY", "GH_TOKEN", "SAME"],
      },
      { id: shared.id, name: "Shared", repos: [{ url: "https://example.org/git/attachments.git", ref: null, dir: "attachments-repo" }], secrets: ["OTHER", "SAME"] },
    ]);
    // a person (even the owner) can't call the session route
    assert.equal((await call(h, alice, "GET", "/api/session/projects")).status, 401);
    // listing and reading tasks never carries values
    noSecrets("task list", (await call(h, alice, "GET", "/api/tasks")).body);
    noSecrets("admin task list", (await call(h, admin, "GET", "/api/tasks?all=1")).body);
  }));

test("every start uses the Projects as they are now: a new clash fails the resume; a deleted Project is left out", () =>
  run(async (h, u) => {
    const alice = await as(h, u.alice);
    const one = (await call(h, alice, "POST", "/api/projects", { name: "One", secrets: { KEY: "v1" } })).body;
    const two = (await call(h, alice, "POST", "/api/projects", { name: "Two", secrets: { OTHER: "x" } })).body;
    const id = (await call(h, alice, "POST", "/api/tasks", { prompt: "x", projects: [one.id, two.id] })).body.id;
    await h.jarvis.settle();
    await call(h, alice, "POST", `/api/tasks/${id}/pause`);
    await h.jarvis.settle();
    // the clash appears after the task was made
    await call(h, alice, "PATCH", `/api/projects/${two.id}`, { secrets: { KEY: "v2" } });
    assert.equal((await call(h, alice, "POST", `/api/tasks/${id}/resume`)).status, 202);
    await h.jarvis.settle();
    const t = (await call(h, alice, "GET", `/api/tasks/${id}`)).body;
    assert.equal(t.state, "paused");
    assert.match(t.error, /could not resume: .*KEY/);
    assert.equal(machineOf(h, id), null);
    // a renamed Project keeps its old name on the task; deleting one drops it from the next start
    await call(h, alice, "PATCH", `/api/projects/${one.id}`, { name: "One renamed" });
    assert.equal((await call(h, alice, "DELETE", `/api/projects/${one.id}`)).status, 200);
    assert.equal((await call(h, alice, "POST", `/api/tasks/${id}/resume`)).status, 202);
    await h.jarvis.settle();
    const t2 = (await call(h, alice, "GET", `/api/tasks/${id}`)).body;
    assert.equal(t2.state, "starting", JSON.stringify(t2));
    assert.deepEqual(t2.projects, [{ id: one.id, name: "One" }, { id: two.id, name: "Two" }], "the task keeps its refs");
    const s = await fakeSession(h, id);
    const sp = (await call(h, await asService(h, GATE, s.token), "GET", "/api/session/projects")).body;
    assert.deepEqual(sp.projects.map((p: { name: string }) => p.name), ["Two"]);
    assert.deepEqual(sp.env, { KEY: "v2", OTHER: "x" });
    s.ws.close();
  }));

test("offboarding keeps a person's private Projects in the DB; nobody can see them", () =>
  run(async (h, u) => {
    const alice = await as(h, u.alice);
    const p = (await call(h, alice, "POST", "/api/projects", { name: "Kept", secrets: { K: SECRET_A } })).body;
    h.directory.set(u.alice, { suspended: true });
    await h.jarvis.syncDirectory();
    await h.jarvis.settle();
    assert.equal((await call(h, await as(h, u.alice), "GET", "/api/projects")).status, 403);
    const admin = await as(h, u.admin);
    assert.equal((await call(h, admin, "GET", `/api/projects/${p.id}`)).status, 404);
    assert.ok(!(await call(h, admin, "GET", "/api/projects")).body.projects.some((x: { id: string }) => x.id === p.id));
    assert.equal(h.jarvis.ctx.db.prepare("SELECT count(*) AS n FROM projects WHERE id = ?").get(p.id)!.n, 1, "kept as the organisation's record");
    assert.equal(h.jarvis.ctx.db.prepare("SELECT count(*) AS n FROM project_secrets WHERE project_id = ?").get(p.id)!.n, 1);
  }));
