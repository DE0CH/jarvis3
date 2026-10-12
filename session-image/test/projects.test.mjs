// lib/projects.mjs: clone commands, the token's credential helper, the instructions' Projects section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneAll, cloneCommands, credentialHelper, gitConfigFromEnv, projectsSection, safeEnv } from "../lib/projects.mjs";

const git = (args, o = {}) => {
  const r = spawnSync("git", args, { encoding: "utf8", ...o });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("the credential helper answers get with x-access-token and the variable's value, and nothing else", () => {
  const h = credentialHelper("GH_TOKEN");
  const fill = spawnSync("git", ["-c", "credential.helper=", "-c", `credential.helper=${h}`, "credential", "fill"], {
    input: "protocol=https\nhost=github.com\npath=org/repo.git\n\n",
    env: { PATH: process.env.PATH, HOME: tmpdir(), GH_TOKEN: "tok-123", GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
  });
  assert.equal(fill.status, 0, fill.stderr);
  assert.match(fill.stdout, /^username=x-access-token$/m);
  assert.match(fill.stdout, /^password=tok-123$/m);
  assert.throws(() => credentialHelper("bad name; rm -rf /"));
});

test("clone commands: token only through the helper, ref as --branch=, never in the URL", () => {
  const c = cloneCommands({ url: "https://github.com/o/r.git", ref: "main", dir: "r", tokenEnv: "GH_TOKEN", token: "tok" }, "/home/jarvis/workspace");
  assert.equal(c.dest, "/home/jarvis/workspace/r");
  assert.ok(c.clone.includes("--branch=main"));
  assert.ok(c.clone.includes("https://github.com/o/r.git"));
  assert.ok(!c.clone.join(" ").includes("tok "), "no token on the command line");
  assert.equal(c.after.length, 2);
  const plain = cloneCommands({ url: "https://github.com/o/p", ref: null, dir: "p" }, "/w");
  assert.equal(plain.after.length, 0);
  assert.ok(!plain.clone.some((a) => a.startsWith("--branch")));
  assert.throws(() => cloneCommands({ url: "https://x/y", dir: "../evil" }, "/w"));
  assert.throws(() => cloneCommands({ url: "https://x/y", dir: ".." }, "/w"));
});

test("cloneAll clones once, keeps the token out of .git/config, leaves a repo-local helper, notes failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "projects-"));
  const src = join(dir, "src");
  mkdirSync(src);
  const genv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };
  git(["init", "-q", "-b", "main", src]);
  writeFileSync(join(src, "README.md"), "PROJECT-REPO-MARK\n");
  git(["-C", src, "add", "-A"]);
  git(["-C", src, "commit", "-q", "-m", "x"], { env: genv });
  const workspace = join(dir, "ws");
  mkdirSync(workspace);
  // the URL the server would send is https; a rewrite (passed like GIT_CONFIG_* from the machine env) points it here
  const pass = gitConfigFromEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.file://" + src + ".insteadOf", GIT_CONFIG_VALUE_0: "https://git.example.test/org/site.git" });
  const projects = [
    {
      id: "p1",
      name: "Site",
      repos: [
        { url: "https://git.example.test/org/site.git", ref: "main", dir: "site", token: "SECRET-TOKEN-VALUE", tokenEnv: "GH_TOKEN" },
        { url: "https://git.example.test/org/missing.git", ref: null, dir: "missing" },
      ],
      secrets: ["GH_TOKEN"],
    },
  ];
  const logs = [];
  const io = {
    exists: existsSync,
    run: (argv, env) => spawnSync(argv[0], argv.slice(1), { env, encoding: "utf8" }),
    log: (m, e) => logs.push([m, e]),
  };
  const baseEnv = { PATH: process.env.PATH, HOME: dir };
  const problems = cloneAll(projects, { workspace, baseEnv, passThrough: pass }, io);
  assert.equal(readFileSync(join(workspace, "site", "README.md"), "utf8"), "PROJECT-REPO-MARK\n");
  const cfg = readFileSync(join(workspace, "site", ".git", "config"), "utf8");
  assert.ok(!cfg.includes("SECRET-TOKEN-VALUE"), "no token in .git/config");
  assert.match(cfg, /url = https:\/\/git\.example\.test\/org\/site\.git/);
  assert.match(cfg, /helper = "!f\(\) .*GH_TOKEN/);
  // the agent's own git (pull/push) gets the token from the variable in its env
  const fill = spawnSync("git", ["-C", join(workspace, "site"), "credential", "fill"], { input: "protocol=https\nhost=git.example.test\n\n", env: { PATH: process.env.PATH, HOME: dir, GH_TOKEN: "from-env", GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8" });
  assert.match(fill.stdout, /^password=from-env$/m, fill.stderr);
  assert.equal(problems.size, 1);
  assert.ok(problems.has(join(workspace, "missing")));
  assert.ok(!JSON.stringify(logs).includes("SECRET-TOKEN-VALUE"));
  // a second boot (a resumed snapshot): nothing cloned again
  writeFileSync(join(workspace, "site", "local-change.txt"), "kept");
  const again = cloneAll([{ ...projects[0], repos: [projects[0].repos[0]] }], { workspace, baseEnv, passThrough: pass }, io);
  assert.equal(again.size, 0);
  assert.ok(existsSync(join(workspace, "site", "local-change.txt")));
  // the section names folders and secret names, and the failure
  const text = projectsSection(projects, workspace, problems);
  assert.match(text, /^## Projects/);
  assert.match(text, /### Site/);
  assert.ok(text.includes(join(workspace, "site")));
  assert.match(text, /\$GH_TOKEN/);
  assert.match(text, /missing .*NOT cloned/);
  assert.ok(!text.includes("SECRET-TOKEN-VALUE"));
  assert.equal(projectsSection([], workspace), "");
});

test("safeEnv drops names the machine sets itself", () => {
  assert.deepEqual(safeEnv({ API_KEY: "a", PATH: "/x", JARVIS_URL: "u", OPENROUTER_API_KEY: "k", GIT_DIR: "g", lower: "l", LD_PRELOAD: "p" }), { API_KEY: "a" });
});
