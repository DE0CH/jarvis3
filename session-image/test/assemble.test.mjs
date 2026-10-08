import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderInstructions, skillFiles, fixSkillMd, permissions, opencodeConfig, writeLayers, safeRel } from "../lib/assemble.mjs";

// A bundle shaped like the server's assemble() output (server/src/layers.ts).
const bundle = {
  orgEnvCommit: "a".repeat(40),
  role: "staff",
  instructions: [
    { layer: "org", source: "AGENTS.md", text: "ORG-MARK: be helpful." },
    { layer: "role", source: "roles/staff/AGENTS.md", text: "ROLE-MARK: staff rules." },
    { layer: "personal", source: "personal:instructions", text: "PERSONAL-MARK: answer briefly." },
    { layer: "personal", source: "personal:notes", text: "Things the user asked you to remember:\n- NOTE-MARK" },
    { layer: "policy", source: "policy/AGENTS.md", text: "POLICY-MARK: never send money." },
  ],
  skills: [
    { name: "search", originalName: "search", layer: "org", files: { "SKILL.md": "---\nname: search\ndescription: Search things\n---\nbody", "refs/a.md": "ref" } },
    { name: "role-search", originalName: "search", layer: "role", files: { "SKILL.md": "---\nname: search\ndescription: Role search\n---\nrole body" } },
    { name: "notes", originalName: "notes", layer: "personal", files: { "SKILL.md": "# My notes skill\n\nDoes notes." } },
    { name: "send-mail", originalName: "send-mail", layer: "policy", files: { "SKILL.md": "locked" } },
  ],
  deny: [
    { permission: "bash", pattern: "rm -rf /*" },
    { permission: "bash", pattern: "curl *" },
    { permission: "webfetch", pattern: "*" },
  ],
};
const o = { workspace: "/home/jarvis/workspace", orgDir: "/home/jarvis/org" };

test("instructions: platform preamble first, then the layers exactly in bundle order, policy last", () => {
  const text = renderInstructions(bundle, o);
  const at = (s) => text.indexOf(s);
  assert.ok(at("# Jarvis session") === 0);
  assert.ok(at("jarvis-remember") > 0);
  const marks = ["ORG-MARK", "ROLE-MARK", "PERSONAL-MARK", "NOTE-MARK", "POLICY-MARK"].map(at);
  assert.ok(marks.every((m) => m > 0));
  assert.deepEqual([...marks].sort((a, b) => a - b), marks, "in load order");
  assert.match(text, /<!-- jarvis layer: policy \(policy\/AGENTS.md\) -->/);
});

test("skills: one folder per assembled name; a renamed skill's front matter follows the new name", () => {
  const files = skillFiles(bundle);
  assert.deepEqual([...files.keys()].sort(), ["notes/SKILL.md", "role-search/SKILL.md", "search/SKILL.md", "search/refs/a.md", "send-mail/SKILL.md"]);
  assert.match(files.get("role-search/SKILL.md"), /^---\nname: role-search\ndescription: Role search\n---\nrole body$/);
  assert.match(files.get("search/SKILL.md"), /^---\nname: search\n/);
  assert.equal(files.get("search/refs/a.md"), "ref");
  // no front matter -> one is added (OpenCode needs name + description)
  assert.match(files.get("notes/SKILL.md"), /^---\nname: notes\ndescription: "My notes skill"\n---\n# My notes skill/);
});

test("front matter without a name or description gets them", () => {
  assert.equal(fixSkillMd("---\ndescription: d\n---\nx", "k"), "---\nname: k\ndescription: d\n---\nx");
  assert.equal(fixSkillMd("---\nname: old\n---\nx", "new"), "---\nname: new\ndescription: new\n---\nx");
});

test("unsafe paths and names in a bundle are refused", () => {
  assert.throws(() => safeRel("../etc/passwd"));
  assert.throws(() => safeRel("/abs"));
  assert.throws(() => safeRel("a/../../b"));
  assert.equal(safeRel("refs/a.md"), "refs/a.md");
  assert.throws(() => skillFiles({ skills: [{ name: "../x", files: { "SKILL.md": "" } }] }));
  assert.throws(() => skillFiles({ skills: [{ name: "ok", files: { "../SKILL.md": "" } }] }));
});

test("permissions: allow by default; deny rules from the policy only, after the allow-all", () => {
  assert.equal(permissions([]), "allow");
  const p = permissions(bundle.deny);
  assert.deepEqual(p, { "*": "allow", bash: { "*": "allow", "rm -rf /*": "deny", "curl *": "deny" }, webfetch: "deny" });
  assert.deepEqual(Object.keys(p.bash), ["*", "rm -rf /*", "curl *"], "specific rules after the wildcard (last match wins)");
});

test("opencode.json: the task's OpenRouter model, the key from env, instructions + skills paths, no sharing", () => {
  const c = opencodeConfig({ model: "anthropic/claude-test", bundle, instructionsPath: "/i.md", skillsDir: "/s", baseUrl: "http://stub/api/v1" });
  assert.equal(c.model, "openrouter/anthropic/claude-test");
  assert.equal(c.small_model, "openrouter/anthropic/claude-test");
  assert.equal(c.share, "disabled");
  assert.equal(c.autoupdate, false);
  assert.deepEqual(c.instructions, ["/i.md"]);
  assert.deepEqual(c.skills, { paths: ["/s"] });
  assert.equal(c.provider.openrouter.options.apiKey, "{env:OPENROUTER_API_KEY}");
  assert.equal(c.provider.openrouter.options.baseURL, "http://stub/api/v1");
  assert.ok(c.provider.openrouter.models["anthropic/claude-test"]);
  assert.ok(!JSON.stringify(c).includes("sk-or"), "no key material in the file");
  const prod = opencodeConfig({ model: "m/x", bundle: { deny: [] }, instructionsPath: "/i.md", skillsDir: "/s", baseUrl: "" });
  assert.equal(prod.provider.openrouter.options.baseURL, undefined);
  assert.equal(prod.permission, "allow");
});

test("writeLayers writes the files and replaces old skills on the next boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "layers-"));
  try {
    const opts = { jarvisDir: join(dir, ".jarvis"), workspace: "/w", orgDir: "/o", model: "m/x", baseUrl: "", opencodeConfigPath: join(dir, ".config/opencode/opencode.json") };
    writeLayers(bundle, opts);
    assert.ok(readFileSync(join(dir, ".jarvis/instructions.md"), "utf8").includes("POLICY-MARK"));
    assert.ok(existsSync(join(dir, ".jarvis/skills/role-search/SKILL.md")));
    assert.equal(JSON.parse(readFileSync(opts.opencodeConfigPath, "utf8")).model, "openrouter/m/x");
    writeLayers({ ...bundle, skills: bundle.skills.slice(0, 1) }, opts);
    assert.ok(!existsSync(join(dir, ".jarvis/skills/role-search")), "a skill gone from the bundle is gone from the machine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
