// Layer order, shadowing, locked-policy precedence; the personal layer's CRUD, Reset and Undo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { harness, seedUsers, call, asEmail, asService, createTask, fakeSession, GATE, type Harness } from "./helpers.ts";
import { assemble, POLICY_PREAMBLE, type PersonalData } from "../src/layers.ts";
import { readTar, writeTar } from "../src/tar.ts";

const enc = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, new TextEncoder().encode(v)]));
const personal = (p: Partial<PersonalData> = {}): PersonalData => ({ instructions: "", skills: [], notes: [], ...p });

test("instructions load in order org, role, personal, policy; the policy comes last with its override preamble", () => {
  const b = assemble({
    commit: "c".repeat(40),
    role: "staff",
    files: enc({ "AGENTS.md": "ORG", "roles/staff/AGENTS.md": "ROLE", "roles/admin/AGENTS.md": "ADMIN ROLE", "policy/AGENTS.md": "POLICY" }),
    personal: personal({ instructions: "MINE", notes: [{ id: "n", text: "likes tables", createdAt: "", source: "user", taskId: null }] }),
  });
  assert.deepEqual(
    b.instructions.map((i) => [i.layer, i.source]),
    [
      ["org", "AGENTS.md"],
      ["role", "roles/staff/AGENTS.md"],
      ["personal", "personal:instructions"],
      ["personal", "personal:notes"],
      ["policy", "policy/AGENTS.md"],
    ],
  );
  assert.ok(b.instructions.at(-1)!.text.startsWith(POLICY_PREAMBLE));
  assert.ok(b.instructions.at(-1)!.text.endsWith("POLICY"));
  assert.match(b.instructions[3]!.text, /- likes tables/);
  assert.ok(!b.instructions.some((i) => i.text.includes("ADMIN ROLE")), "another role's layer is not loaded");
  assert.equal(b.orgEnvCommit, "c".repeat(40));
});

test("skills: nothing shadows a policy or org skill; clashing names are renamed with their layer", () => {
  const b = assemble({
    commit: "0".repeat(40),
    role: "staff",
    files: enc({
      "policy/skills/send-mail/SKILL.md": "locked",
      "skills/send-mail/SKILL.md": "org tries to override policy",
      "skills/report/SKILL.md": "org report",
      "skills/report/template.md": "tpl",
      "roles/staff/skills/report/SKILL.md": "role report",
      "roles/staff/skills/crm/SKILL.md": "role crm",
    }),
    personal: personal({
      skills: [
        { name: "report", files: { "SKILL.md": "my report" } },
        { name: "crm", files: { "SKILL.md": "my crm" } },
        { name: "send-mail", files: { "SKILL.md": "my send-mail" } },
        { name: "notes", files: { "SKILL.md": "mine only" } },
      ],
    }),
  });
  const by = Object.fromEntries(b.skills.map((s) => [s.name, s]));
  assert.equal(by["send-mail"]!.layer, "policy");
  assert.equal(by["send-mail"]!.files["SKILL.md"], "locked");
  assert.equal(by["org-send-mail"]!.files["SKILL.md"], "org tries to override policy");
  assert.equal(by["personal-send-mail"]!.files["SKILL.md"], "my send-mail");
  assert.equal(by["report"]!.layer, "org");
  assert.deepEqual(Object.keys(by["report"]!.files).sort(), ["SKILL.md", "template.md"]);
  assert.equal(by["role-report"]!.files["SKILL.md"], "role report");
  assert.equal(by["personal-report"]!.files["SKILL.md"], "my report");
  assert.equal(by["crm"]!.layer, "role");
  assert.equal(by["personal-crm"]!.originalName, "crm");
  assert.equal(by["notes"]!.layer, "personal", "an unclashing personal skill keeps its name");
  assert.deepEqual(
    b.skills.map((s) => s.layer),
    [...b.skills.map((s) => s.layer)].sort((x, y) => ["org", "role", "personal", "policy"].indexOf(x) - ["org", "role", "personal", "policy"].indexOf(y)),
  );
});

test("renaming never collides: a second clash gets a number", () => {
  const b = assemble({
    commit: "0".repeat(40),
    role: "staff",
    files: enc({ "skills/x/SKILL.md": "org x", "skills/role-x/SKILL.md": "org role-x", "roles/staff/skills/x/SKILL.md": "role x" }),
    personal: personal(),
  });
  assert.deepEqual(b.skills.map((s) => s.name).sort(), ["role-x", "role-x-2", "x"]);
  assert.equal(b.skills.find((s) => s.name === "role-x-2")!.files["SKILL.md"], "role x");
});

test("deny rules come only from the locked policy", () => {
  const b = assemble({
    commit: "0".repeat(40),
    role: "staff",
    files: enc({
      "policy/deny.json": JSON.stringify([{ permission: "bash", pattern: "curl *" }]),
      "roles/staff/deny.json": JSON.stringify([{ permission: "edit", pattern: "*" }]),
      "deny.json": "[]",
    }),
    personal: personal({ skills: [{ name: "deny", files: { "SKILL.md": "x", "deny.json": "[]" } }] }),
  });
  assert.deepEqual(b.deny, [{ permission: "bash", pattern: "curl *" }]);
  assert.throws(
    () => assemble({ commit: "0".repeat(40), role: "staff", files: enc({ "policy/deny.json": '{"permission":"bash"}' }), personal: personal() }),
    /array/,
  );
});

// ---- personal layer through the API -------------------------------------------------------------

async function run(fn: (h: Harness, alice: string, aliceId: string) => Promise<void>) {
  const h = await harness();
  try {
    const u = await seedUsers(h);
    const id = (await call(h, await asEmail(h, u.alice), "GET", "/api/me")).body.user.id;
    await fn(h, u.alice, id);
  } finally {
    await h.close();
  }
}

test("personal layer CRUD with validation", () =>
  run(async (h, alice) => {
    const c = await asEmail(h, alice);
    const base = "/api/users/me/layer";
    assert.equal((await call(h, c, "PUT", `${base}/instructions`, { text: "Answer in German." })).body.instructions, "Answer in German.");
    assert.equal((await call(h, c, "PUT", `${base}/instructions`, { text: "x".repeat(64_001) })).status, 400);
    assert.equal((await call(h, c, "PUT", `${base}/skills/Bad_Name`, { files: { "SKILL.md": "x" } })).status, 400);
    assert.equal((await call(h, c, "PUT", `${base}/skills/ok`, { files: { "README.md": "no SKILL.md" } })).status, 400);
    assert.equal((await call(h, c, "PUT", `${base}/skills/ok`, { files: { "SKILL.md": "x", "../escape": "y" } })).status, 400);
    assert.equal((await call(h, c, "PUT", `${base}/skills/ok`, { files: { "SKILL.md": "x", "/abs": "y" } })).status, 400);
    const put = await call(h, c, "PUT", `${base}/skills/invoices`, { files: { "SKILL.md": "how I do invoices", "refs/vendors.md": "list" } });
    assert.equal(put.status, 200);
    assert.equal(put.body.skills[0].name, "invoices");
    const n = await call(h, c, "POST", `${base}/notes`, { text: "  My manager is Dana.  " });
    assert.equal(n.status, 201);
    assert.equal(n.body.text, "My manager is Dana.");
    assert.equal(n.body.source, "user");
    assert.equal((await call(h, c, "POST", `${base}/notes`, { text: "" })).status, 400);
    assert.equal((await call(h, c, "DELETE", `${base}/notes/nope`)).status, 404);
    assert.equal((await call(h, c, "DELETE", `${base}/notes/${n.body.id}`)).body.notes.length, 0);
    assert.equal((await call(h, c, "DELETE", `${base}/skills/invoices`)).body.skills.length, 0);
    assert.equal((await call(h, c, "DELETE", `${base}/skills/invoices`)).status, 404);
  }));

test("Reset archives a numbered version and empties the layer; Undo restores it without losing newer content", () =>
  run(async (h, alice) => {
    const c = await asEmail(h, alice);
    const base = "/api/users/me/layer";
    assert.equal((await call(h, c, "POST", `${base}/undo`)).status, 409, "nothing to undo");
    assert.equal((await call(h, c, "POST", `${base}/reset`)).body.version, null, "an empty layer archives nothing");
    await call(h, c, "PUT", `${base}/instructions`, { text: "v1 instructions" });
    await call(h, c, "POST", `${base}/notes`, { text: "v1 note" });
    const r1 = await call(h, c, "POST", `${base}/reset`);
    assert.equal(r1.body.version, 1);
    assert.deepEqual([r1.body.layer.instructions, r1.body.layer.notes.length, r1.body.layer.skills.length], ["", 0, 0]);
    assert.deepEqual(r1.body.layer.versions.map((v: { version: number; reason: string }) => [v.version, v.reason]), [[1, "reset"]]);
    // Undo with an empty layer: v1 comes back
    const u1 = await call(h, c, "POST", `${base}/undo`);
    assert.equal(u1.body.instructions, "v1 instructions");
    assert.equal(u1.body.notes[0].text, "v1 note");
    // Reset again, add something new, Undo: v1 back AND the new content kept as a version
    await call(h, c, "POST", `${base}/reset`);
    await call(h, c, "POST", `${base}/notes`, { text: "after reset" });
    const u2 = await call(h, c, "POST", `${base}/undo`);
    assert.equal(u2.body.instructions, "v1 instructions");
    assert.deepEqual(u2.body.versions.map((v: { version: number; reason: string }) => [v.version, v.reason]), [[3, "undo"], [2, "reset"], [1, "reset"]]);
    // a second Undo swaps back to the post-reset content
    const u3 = await call(h, c, "POST", `${base}/undo`);
    assert.deepEqual(u3.body.notes.map((n: { text: string }) => n.text), ["after reset"]);
  }));

test("a session's 'remember' notes land in its owner's layer and show up in the next session's bundle", () =>
  run(async (h, alice) => {
    const id = await createTask(h, alice);
    const s = await fakeSession(h, id);
    const sess = await asService(h, GATE, s.token);
    const n = await call(h, sess, "POST", "/api/session/notes", { text: "Quarter ends in March" });
    assert.equal(n.status, 201);
    assert.equal(n.body.source, "session");
    assert.equal(n.body.taskId, id);
    await call(h, await asEmail(h, alice), "PUT", "/api/users/me/layer/skills/report", { files: { "SKILL.md": "my report" } });
    const b = await call(h, sess, "GET", "/api/session/bundle");
    assert.equal(b.status, 200);
    assert.equal(b.body.role, "staff");
    assert.deepEqual(
      b.body.instructions.map((i: { layer: string }) => i.layer),
      ["org", "role", "personal", "policy"],
    );
    assert.match(b.body.instructions[2].text, /Quarter ends in March/);
    const names = b.body.skills.map((x: { name: string }) => x.name);
    assert.ok(names.includes("report") && names.includes("role-report") && names.includes("personal-report") && names.includes("send-mail"));
    assert.deepEqual(b.body.deny, [{ permission: "bash", pattern: "rm -rf /*" }]);
    // the preview for the owner equals what the session gets
    const preview = await call(h, await asEmail(h, alice), "GET", "/api/users/me/layers");
    assert.deepEqual(preview.body, b.body);
    // the org-env tarball
    const tar = await fetch(h.base + "/api/session/org-env.tar", { headers: { "cf-access-jwt-assertion": sess.jwt!, authorization: `Bearer ${s.token}` } });
    assert.equal(tar.headers.get("content-type"), "application/x-tar");
    const files = readTar(new Uint8Array(await tar.arrayBuffer()));
    assert.equal(new TextDecoder().decode(files.get("policy/AGENTS.md")), "Never send money.");
    s.ws.close();
  }));

test("tar: write/read round trip incl. long paths", () => {
  const long = "a/".repeat(60) + "file.md";
  const files = enc({ "x.md": "hello", [long]: "deep", "empty": "" });
  const back = readTar(writeTar(files));
  assert.deepEqual([...back.keys()].sort(), [...files.keys()].sort());
  assert.equal(new TextDecoder().decode(back.get(long)), "deep");
});
