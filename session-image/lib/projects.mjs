// Projects, session side (docs/API.md section 17, docs/SESSION-IMAGE.md): at boot, before the daemon
// starts, jarvis-agent fetches GET /api/session/projects, clones each repo into ~/workspace/<dir> as
// the agent's user when that folder doesn't exist yet (a resumed snapshot already has it), merges the
// secrets into the daemon's env, and adds a "Projects" section to the agent's instructions.
//
// A repo's token never goes into a URL or .git/config: the clone gets it through a credential
// helper that reads an env var set for that one git process, and the clone keeps a repo-local
// helper that reads the same variable (the Project's secret, which is in the agent's env) so the
// agent can pull and push.
//
// Pure functions plus one function with its I/O injected; test/projects.test.mjs covers them.
import { join } from "node:path";

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const DIR_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A git credential helper that answers `get` with x-access-token and the value of $<envName>. */
export function credentialHelper(envName) {
  if (!ENV_NAME.test(envName)) throw new Error(`bad token variable name: ${envName}`);
  return `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=\${${envName}}"; }; f`;
}

/**
 * The git commands for one repo: the clone (with the token helper for this one process only), then
 * the repo-local helper. `git -c credential.helper=` first clears any helper from other configs.
 */
export function cloneCommands(repo, workspace) {
  if (!DIR_NAME.test(repo.dir) || repo.dir === "." || repo.dir === "..") throw new Error(`bad folder name: ${repo.dir}`);
  const dest = join(workspace, repo.dir);
  const helper = repo.tokenEnv ? credentialHelper(repo.tokenEnv) : null;
  const clone = ["git", "-c", "credential.helper=", ...(helper ? ["-c", `credential.helper=${helper}`] : []), "clone", "--quiet", ...(repo.ref ? [`--branch=${repo.ref}`] : []), "--", repo.url, dest];
  const after = helper
    ? [
        ["git", "-C", dest, "config", "--local", "--replace-all", "credential.helper", ""],
        ["git", "-C", dest, "config", "--local", "--add", "credential.helper", helper],
      ]
    : [];
  return { dest, clone, after };
}

/** The env one clone runs with: the agent user's basics, the token (if any), no prompts. */
export function cloneEnv(base, repo, passThrough = {}) {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", ...passThrough };
  if (repo.tokenEnv && repo.token !== undefined) env[repo.tokenEnv] = repo.token;
  return env;
}

/**
 * GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n from the machine's env, passed to clones
 * (an operator's URL rewrite to a mirror; the integration test serves its repo over plain HTTP
 * this way).
 */
export function gitConfigFromEnv(env) {
  const n = Number(env.GIT_CONFIG_COUNT || 0);
  if (!Number.isInteger(n) || n <= 0 || n > 20) return {};
  const out = { GIT_CONFIG_COUNT: String(n) };
  for (let i = 0; i < n; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`] === undefined || env[`GIT_CONFIG_VALUE_${i}`] === undefined) return {};
    out[`GIT_CONFIG_KEY_${i}`] = env[`GIT_CONFIG_KEY_${i}`];
    out[`GIT_CONFIG_VALUE_${i}`] = env[`GIT_CONFIG_VALUE_${i}`];
  }
  return out;
}

/** The instructions' Projects section: names, folders, secret NAMES (never values), clone problems. */
export function projectsSection(projects, workspace, problems = new Map()) {
  if (!projects?.length) return "";
  const lines = [
    "## Projects",
    "",
    `The user picked ${projects.length === 1 ? "this Project" : "these Projects"} for this task. Their repos are cloned into ${workspace}; their secrets are environment variables in your shell (use them by name; never print, log or commit their values).`,
  ];
  for (const p of projects) {
    lines.push("", `### ${p.name}`);
    if (p.repos.length) {
      lines.push("Repos:");
      for (const r of p.repos) {
        const where = join(workspace, r.dir);
        const extra = [r.ref ? `ref ${r.ref}` : null, r.tokenEnv ? `git pull/push authenticate with $${r.tokenEnv}` : null].filter(Boolean).join("; ");
        const problem = problems.get(where);
        lines.push(`- ${where} (${r.url}${extra ? `; ${extra}` : ""})${problem ? ` — NOT cloned: ${problem}` : ""}`);
      }
    }
    lines.push(p.secrets.length ? `Secrets: ${p.secrets.map((k) => `$${k}`).join(", ")}` : "Secrets: none");
  }
  return lines.join("\n");
}

/** Only the names the server may hand to the agent's env (never ones the machine sets itself). */
export function safeEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (!ENV_NAME.test(k) || /^(JARVIS_|PASEO_|OPENROUTER_|OPENCODE_|CF_ACCESS_|LC_|LD_|GIT_)/.test(k)) continue;
    if (["HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "LANGUAGE", "TZ", "PWD", "OLDPWD", "TERM", "HOSTNAME", "SHLVL", "NODE_OPTIONS", "TMPDIR", "MAIL"].includes(k)) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Clone every repo whose folder doesn't exist yet. `io`: exists(path), run(argv, env) -> {status,
 * stderr}, log. Returns the problems (folder -> message); a failure never stops the boot.
 */
export function cloneAll(projects, { workspace, baseEnv, passThrough = {} }, io) {
  const problems = new Map();
  for (const p of projects || []) {
    for (const repo of p.repos) {
      let cmds;
      try {
        cmds = cloneCommands(repo, workspace);
      } catch (e) {
        problems.set(join(workspace, String(repo.dir)), e.message);
        continue;
      }
      if (io.exists(cmds.dest)) {
        io.log("project repo already there", { project: p.name, dir: repo.dir });
        continue;
      }
      const env = cloneEnv(baseEnv, repo, passThrough);
      const r = io.run(cmds.clone, env);
      if (r.status !== 0) {
        // never echo a token git might have put in its message
        let msg = String(r.stderr || `git exited ${r.status}`).trim().split("\n").slice(-2).join(" ").slice(0, 300);
        if (repo.token) msg = msg.split(repo.token).join("***");
        problems.set(cmds.dest, msg);
        io.log("project repo not cloned", { project: p.name, dir: repo.dir, error: msg });
        continue;
      }
      for (const c of cmds.after) io.run(c, env);
      io.log("project repo cloned", { project: p.name, dir: repo.dir });
    }
  }
  return problems;
}
