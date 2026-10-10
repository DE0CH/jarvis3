// "Suggest for everyone": a personal skill, the instructions or a note become a pull request on the
// org-env repo, opened by the server's GitHubForge against a fake GitHub API (token and App auth);
// admins see it, its state is followed, and nobody else can suggest from someone's layer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { harness, seedUsers, call, asEmail, type Harness } from "./helpers.ts";
import { FakeGitHub } from "../src/fakes/github.ts";
import { GitHubForge } from "../src/github.ts";

const REPO = "example-org/example-env";
const BASE_FILES = {
  "AGENTS.md": "# Example Org\n\nBe helpful.\n",
  "skills/invoices/SKILL.md": "old invoices skill",
  "skills/invoices/old-notes.md": "to be removed",
  "skills/search/SKILL.md": "org search",
};

async function run(fn: (h: Harness, gh: FakeGitHub, u: Awaited<ReturnType<typeof seedUsers>>) => Promise<void>, o: { forge?: boolean } = {}) {
  const gh = new FakeGitHub(REPO, BASE_FILES, "ghp_repo_scoped");
  const url = await gh.start();
  const h = await harness(o.forge === false ? {} : { forge: new GitHubForge({ repo: REPO, apiUrl: url, auth: { kind: "token", token: "ghp_repo_scoped" } }) });
  try {
    await fn(h, gh, await seedUsers(h));
  } finally {
    await h.close();
    await gh.stop();
  }
}

const idOf = async (h: Harness, email: string) => (await call(h, await asEmail(h, email), "GET", "/api/me")).body.user.id as string;

test("a personal skill becomes a pull request that replaces skills/<name>/ exactly; admins are told and see it", () =>
  run(async (h, gh, u) => {
    const c = await asEmail(h, u.alice);
    const me = await call(h, c, "GET", "/api/me");
    assert.deepEqual(me.body.features, { suggestions: true });
    const alice = me.body.user.id;
    await call(h, c, "PUT", `/api/users/${alice}/layer/skills/invoices`, { files: { "SKILL.md": "better invoices", "refs/vendors.md": "ACME" } });
    const r = await call(h, c, "POST", `/api/users/me/layer/suggest`, { kind: "skill", name: "invoices", message: "We all need this." });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.state, "open");
    assert.equal(r.body.number, 1);
    assert.equal(r.body.userEmail, u.alice);
    assert.match(r.body.url, /\/pull\/1$/);
    const pr = gh.pulls[0]!;
    assert.equal(pr.base, "main");
    assert.match(pr.head, /^jarvis\/suggest-skill-invoices-/);
    assert.match(pr.title, /skill "invoices"/);
    assert.match(pr.body, /Alice \(alice@example\.org\)/);
    assert.match(pr.body, /> We all need this\./);
    const files = gh.filesAt(pr.head);
    assert.equal(files["skills/invoices/SKILL.md"], "better invoices");
    assert.equal(files["skills/invoices/refs/vendors.md"], "ACME");
    assert.equal(files["skills/invoices/old-notes.md"], undefined, "files the personal skill lacks are removed");
    assert.equal(files["skills/search/SKILL.md"], "org search", "the rest of the repo is untouched");
    assert.deepEqual(gh.filesAt("main"), BASE_FILES, "main itself is not touched");

    // the admin sees it in the list and as a notice
    const a = await asEmail(h, u.admin);
    const all = await call(h, a, "GET", "/api/suggestions?all=1");
    assert.equal(all.body.suggestions.length, 1);
    const notices = (await call(h, a, "GET", "/api/notices")).body.notices;
    assert.ok(notices.some((n: { kind: string; text: string }) => n.kind === "suggestion" && n.text.includes(r.body.url)));
    // the owner sees their own; another staff member sees none of it
    assert.equal((await call(h, c, "GET", "/api/suggestions")).body.suggestions.length, 1);
    const b = await asEmail(h, u.bob);
    assert.equal((await call(h, b, "GET", "/api/suggestions")).body.suggestions.length, 0);
    assert.equal((await call(h, b, "GET", "/api/suggestions?all=1")).status, 404);
    assert.equal((await call(h, b, "GET", `/api/suggestions?userId=${alice}`)).status, 404);
    assert.equal((await call(h, b, "POST", `/api/users/${alice}/layer/suggest`, { kind: "skill", name: "invoices" })).status, 404);

    // a second press while it's open is refused with the link
    const again = await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "invoices" });
    assert.equal(again.status, 409);
    assert.match(again.body.error.message, /pull\/1/);
  }));

test("merged and closed pull requests are followed; the owner is told", () =>
  run(async (h, gh, u) => {
    const c = await asEmail(h, u.alice);
    const alice = await idOf(h, u.alice);
    await call(h, c, "PUT", `/api/users/${alice}/layer/skills/one`, { files: { "SKILL.md": "1" } });
    await call(h, c, "PUT", `/api/users/${alice}/layer/skills/two`, { files: { "SKILL.md": "2" } });
    await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "one" });
    await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "two" });
    gh.merge(1);
    gh.close(2);
    // a listing within a minute of the last check doesn't ask GitHub again
    let list = (await call(h, c, "GET", "/api/suggestions")).body.suggestions;
    assert.deepEqual(list.map((s: { state: string }) => s.state), ["open", "open"]);
    h.clock.advance(61_000);
    list = (await call(h, await asEmail(h, u.alice), "GET", "/api/suggestions")).body.suggestions;
    const byName = Object.fromEntries(list.map((s: { name: string; state: string }) => [s.name, s.state]));
    assert.deepEqual(byName, { one: "merged", two: "closed" });
    assert.equal(gh.filesAt("main")["skills/one/SKILL.md"], "1");
    const notices = (await call(h, await asEmail(h, u.alice), "GET", "/api/notices")).body.notices.map((n: { text: string }) => n.text);
    assert.ok(notices.some((t: string) => /accepted for everyone/.test(t)));
    assert.ok(notices.some((t: string) => /closed without being merged/.test(t)));
    // once closed, the same skill can be suggested again
    assert.equal((await call(h, await asEmail(h, u.alice), "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "two" })).status, 201);
  }));

test("the background tick follows open pull requests every few minutes", () =>
  run(async (h, gh, u) => {
    const c = await asEmail(h, u.alice);
    await call(h, c, "PUT", "/api/users/me/layer/instructions", { text: "Always cite the contract number." });
    await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "instructions" });
    gh.merge(1);
    await h.jarvis.tick();
    assert.equal((await call(h, await asEmail(h, u.alice), "GET", "/api/suggestions")).body.suggestions[0].state, "open");
    h.clock.advance(5 * 60_000);
    await h.jarvis.tick();
    const n = gh.requests.length;
    assert.equal((await call(h, await asEmail(h, u.alice), "GET", "/api/suggestions")).body.suggestions[0].state, "merged");
    assert.equal(gh.requests.length, n, "the listing used the tick's answer");
  }));

test("instructions and notes are appended to AGENTS.md; an admin can suggest from someone's layer", () =>
  run(async (h, gh, u) => {
    const c = await asEmail(h, u.alice);
    const alice = await idOf(h, u.alice);
    assert.equal((await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "instructions" })).status, 409, "empty instructions");
    await call(h, c, "PUT", "/api/users/me/layer/instructions", { text: "Always cite the contract number." });
    const r1 = await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "instructions" });
    assert.equal(r1.status, 201);
    assert.equal(gh.filesAt(gh.pulls[0]!.head)["AGENTS.md"], "# Example Org\n\nBe helpful.\n\nAlways cite the contract number.\n");
    const note = (await call(h, c, "POST", "/api/users/me/layer/notes", { text: "Invoices go to\nfinance@example.org" })).body;
    const r2 = await call(h, await asEmail(h, u.admin), "POST", `/api/users/${alice}/layer/suggest`, { kind: "note", noteId: note.id });
    assert.equal(r2.status, 201);
    assert.equal(r2.body.userId, alice);
    assert.notEqual(r2.body.byUserId, alice);
    assert.match(gh.pulls[1]!.body, /on Alice \(alice@example\.org\)'s behalf/);
    assert.match(gh.filesAt(gh.pulls[1]!.head)["AGENTS.md"]!, /\n- Invoices go to finance@example\.org\n$/);
    assert.equal((await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "note", noteId: "nope" })).status, 404);
    assert.equal((await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "nope" })).status, 404);
    assert.equal((await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "other" })).status, 400);
  }));

test("a suggestion identical to the org-env repo is refused; a GitHub failure is a 502 and records nothing", () =>
  run(async (h, gh, u) => {
    const c = await asEmail(h, u.alice);
    await call(h, c, "PUT", "/api/users/me/layer/skills/search", { files: { "SKILL.md": "org search" } });
    const same = await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "search" });
    assert.equal(same.status, 409);
    assert.match(same.body.error.message, /already has exactly this/);
    gh.fail = "GitHub is down";
    await call(h, c, "PUT", "/api/users/me/layer/skills/new", { files: { "SKILL.md": "n" } });
    const down = await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "new" });
    assert.equal(down.status, 502);
    assert.equal(down.body.error.code, "upstream");
    assert.equal((await call(h, c, "GET", "/api/suggestions")).body.suggestions.length, 0);
  }));

test("without a suggestions config the feature is off", () =>
  run(
    async (h, _gh, u) => {
      const c = await asEmail(h, u.alice);
      assert.deepEqual((await call(h, c, "GET", "/api/me")).body.features, { suggestions: false });
      await call(h, c, "PUT", "/api/users/me/layer/skills/x", { files: { "SKILL.md": "x" } });
      const r = await call(h, c, "POST", "/api/users/me/layer/suggest", { kind: "skill", name: "x" });
      assert.equal(r.status, 409);
      assert.match(r.body.error.message, /not set up/);
    },
    { forge: false },
  ));

test("GitHubForge with a GitHub App: a JWT for an installation token narrowed to the org-env repo, cached", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString(); // GitHub hands out PKCS#1
  const gh = new FakeGitHub(REPO, BASE_FILES);
  gh.app = { appId: "12345", installationId: "678", publicKey };
  const url = await gh.start();
  try {
    const forge = new GitHubForge({ repo: REPO, apiUrl: url, auth: { kind: "app", appId: "12345", installationId: "678", privateKeyPem: pem } });
    const pr = await forge.openPullRequest({
      branch: "jarvis/test",
      title: "t",
      body: "b",
      message: "m",
      edit: async (base) => ({ "skills/x/SKILL.md": "x", "AGENTS.md": (await base.read("AGENTS.md")) + "more\n" }),
    });
    assert.equal(pr.number, 1);
    assert.equal(await forge.pullRequestState(1), "open");
    assert.equal(gh.installationRequests.length, 1, "one installation token, reused");
    assert.deepEqual(gh.installationRequests[0]!.body, { repositories: ["example-env"], permissions: { contents: "write", pull_requests: "write" } });
    // a wrong key gets nothing
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bad = new GitHubForge({ repo: REPO, apiUrl: url, auth: { kind: "app", appId: "12345", installationId: "678", privateKeyPem: other } });
    await assert.rejects(bad.pullRequestState(1), /401/);
  } finally {
    await gh.stop();
  }
});

test("GitHubForge with a token: a wrong token is refused", async () => {
  const gh = new FakeGitHub(REPO, BASE_FILES, "right");
  const url = await gh.start();
  try {
    await assert.rejects(new GitHubForge({ repo: REPO, apiUrl: url, auth: { kind: "token", token: "wrong" } }).pullRequestState(1), /401 Bad credentials/);
  } finally {
    await gh.stop();
  }
});
