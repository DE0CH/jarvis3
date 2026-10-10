// Turn the server's LayerBundle (GET /api/session/bundle, server/src/api-types.ts) into what
// OpenCode loads: one instructions file (layers concatenated in the bundle's load order: org,
// role, personal, policy — policy last), one folder per skill (names as the server assigned them,
// renames applied to the SKILL.md front matter too), and opencode.json (OpenRouter, the task's
// model, permission allow + the locked policy's deny rules, and the policy plugin).
//
// Pure functions + one writer; test/assemble.test.mjs covers them.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, isAbsolute } from "node:path";

/** OpenCode permissions that take a single action, not pattern rules (OpenCode config schema). */
const ACTION_ONLY = new Set(["todowrite", "question", "webfetch", "websearch", "doom_loop"]);

export const PLATFORM_PREAMBLE = (o) =>
  [
    "# Jarvis session",
    "",
    "You are an agent in a Jarvis task: a machine of your own, started for one person of the organisation.",
    `Your working directory is ${o.workspace}. The organisation's environment (its scripts and reference files) is at ${o.orgDir}, read-only.`,
    "There are no permission prompts: act, but stop and ask before anything outward-facing or irreversible the instructions below don't clearly allow.",
    'When the user asks you to remember something for future tasks, save it with the shell command: jarvis-remember "<the note>" (one short sentence per note).',
    `The user's own files (the Files tab of the Jarvis app) are copied to ${o.filesDir ?? "~/files"} when the task starts; a change there is not saved back. To hand the user a file (a report, an export, a draft), save it to their files: jarvis-files save <file> [<path in their files>]. jarvis-files list shows all their files (a large collection is copied only in part); jarvis-files get <path> fetches one. Files the user attached to their first message are in ${o.workspace}/attachments/.`,
    'To find what was said or done in the user\'s earlier tasks (and this one), run: jarvis-search "<words>"; then jarvis-search --read <task id> --around <seq> shows the conversation around a hit.',
    "To come back to something later (a reply, a deadline, a page that should change), don't wait in the session: arm a wakeup with jarvis_wakeup and end your turn; Jarvis delivers its prompt to this task at the time, starting it again if it was paused. Post results worth keeping (reports, the outcome of a scheduled run) to this task's channel in the app with jarvis_post; the user is notified there. The same are shell commands: jarvis-wakeup and jarvis-post.",
    "Outward-facing or irreversible steps go through Jarvis: jarvis_actions lists the organisation's named actions (company mail, payments, …) and jarvis_action runs one; the right person approves it in the Jarvis app while you wait. If your role lacks an action, ask with jarvis_request_access; for a judgement call, ask an admin with jarvis_ask_boss. Some tool calls are stopped by the locked policy until someone approves them; a denial is final, so tell the user rather than trying another way.",
    ...webToolsLines(o.tools, o.proxyUrl),
    "",
    "The instructions below come in layers: the organisation's, then the user's role, then the user's own, and last the organisation's locked policy, which overrides everything before it.",
  ].join("\n");

/** The preamble's lines on the Tier 0 web tools (none when the instance has none). */
export function webToolsLines(tools, proxyUrl) {
  if (!tools) return [];
  const have = [];
  if (tools.search) have.push("web_search (a real search engine, current results)");
  if (tools.fetch) have.push("web_fetch (any page, also JavaScript-built and bot-walled ones; saved under ~/workspace/.web)");
  const lines = [];
  if (have.length) lines.push(`Web: use ${have.join(" and ")} for anything on the web, instead of guessing or relying on memory for current facts; from scripts, the same through the shell command jarvis-web (jarvis-web --help). They are always on and cost a little of the user's monthly allowance, so be purposeful: one good query, then fetch the pages that matter.`);
  if (tools.proxy) lines.push(`A proxy is available at ${proxyUrl} ($JARVIS_PROXY_URL) for tools that need another IP or country (see the jarvis-web skill); use it only when the machine's own IP is blocked or a country matters.`);
  if (lines.length) lines.push("If the allowance is used up, the tools say so: tell the user rather than working around it.");
  return lines.length ? ["", ...lines] : [];
}

/** The built-in skill on the web tools (written next to the layers' skills, unless one has its name). */
export const WEB_SKILL = "jarvis-web";
export function webSkill(tools, proxyUrl) {
  const parts = [
    "---",
    `name: ${WEB_SKILL}`,
    "description: Search the web, fetch pages (also JavaScript-built and bot-walled ones) and use a proxy, from the agent or from scripts. Use whenever a task needs anything from the web.",
    "---",
    "# Web tools",
    "",
    "Every call is metered against the user's monthly web-tools allowance; the organisation's keys never enter this machine. A call refused for the allowance says so: tell the user, don't work around it.",
    "",
  ];
  if (tools.search)
    parts.push(
      "## Search",
      "- Tool `web_search` {query, numResults?, textChars?, since?, includeDomains?, country?}.",
      '- Shell: `jarvis-web search "query" [--n 10] [--text 2000] [--since 2026-01-01] [--domain gov.uk] [--country de] [--json]`.',
      "- One precise query beats several vague ones. `textChars` adds each page's extracted text (dearer): use it when you'd fetch every result anyway.",
      "",
    );
  if (tools.fetch)
    parts.push(
      "## Fetch",
      "- Tool `web_fetch` {url, render?, premium?, country?, format?}: raw HTML by default (keep it: tables, links and embedded JSON survive), `format: text` for prose.",
      "- Shell: `jarvis-web fetch URL [--render] [--premium] [--country de] [--text] [-o file]` (prints the page, or saves it with -o).",
      "- Order of escalation, cheapest first: plain → `render` (the page builds its content with JavaScript) → `premium` (the site blocks datacenter IPs).",
      "- The whole page is saved under ~/workspace/.web/; read it from there instead of fetching again.",
      "",
    );
  if (tools.proxy)
    parts.push(
      "## Proxy",
      `- \`${proxyUrl}\` (also \`$JARVIS_PROXY_URL\`), an HTTP proxy (https via CONNECT): \`curl -x $JARVIS_PROXY_URL https://example.com\`, \`HTTPS_PROXY=$JARVIS_PROXY_URL python3 x.py\`, \`chromium --proxy-server=$JARVIS_PROXY_URL\`.`,
      "- Exit country in the proxy user name: `http://country-de:x@127.0.0.1:3128`; a sticky IP for a while: `country-us-session-ab12cd34` (8 letters/digits).",
      "- `jarvis-web proxy` shows this month's traffic. Only route what needs it through the proxy: every byte counts.",
      "",
    );
  return parts.join("\n");
}

const LAYER_TITLE = { org: "Organisation", role: "Role", personal: "Personal", policy: "Locked policy" };

/** The instructions file: the platform preamble, then every bundle instruction in load order. */
export function renderInstructions(bundle, o) {
  const parts = [PLATFORM_PREAMBLE(o)];
  for (const i of bundle.instructions) {
    parts.push(`<!-- jarvis layer: ${i.layer} (${i.source}) -->\n## ${LAYER_TITLE[i.layer] || i.layer} instructions\n\n${i.text.trim()}`);
  }
  return parts.join("\n\n") + "\n";
}

/** A relative path from the bundle, refused if it could leave the skill folder. */
export function safeRel(p) {
  const n = normalize(p);
  if (!p || isAbsolute(p) || n.startsWith("..") || n.split(/[\\/]/).includes("..")) throw new Error(`unsafe path in bundle: ${p}`);
  return n;
}

export function safeSkillName(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(name)) throw new Error(`unsafe skill name in bundle: ${name}`);
  return name;
}

/**
 * SKILL.md with its front matter `name:` set to the name the session sees (the server renames a
 * clashing skill, e.g. `role-report`); a SKILL.md without front matter gets one (OpenCode needs a
 * name and a description).
 */
export function fixSkillMd(text, name) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (fm) {
    let head = fm[1];
    head = /^name:.*$/m.test(head) ? head.replace(/^name:.*$/m, `name: ${name}`) : `name: ${name}\n${head}`;
    if (!/^description:/m.test(head)) head += `\ndescription: ${name}`;
    return `---\n${head}\n---\n${text.slice(fm[0].length)}`;
  }
  const first = text.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || name;
  const desc = first.slice(0, 200).replace(/\s+/g, " ");
  return `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n${text}`;
}

/** path (relative to the skills dir) -> content, for every skill in the bundle. */
export function skillFiles(bundle) {
  const out = new Map();
  for (const s of bundle.skills) {
    const name = safeSkillName(s.name);
    for (const [rel, text] of Object.entries(s.files)) {
      const r = safeRel(rel);
      out.set(join(name, r), r === "SKILL.md" ? fixSkillMd(text, name) : text);
    }
  }
  return out;
}

/** OpenCode permissions: allow everything, then the locked policy's deny rules on top. */
export function permissions(deny) {
  if (!deny.length) return "allow";
  const p = { "*": "allow" };
  for (const r of deny) {
    if (ACTION_ONLY.has(r.permission)) {
      // these take no patterns in OpenCode: any deny rule on one denies the whole permission
      p[r.permission] = "deny";
      continue;
    }
    const cur = p[r.permission];
    const rules = typeof cur === "object" ? cur : { "*": cur === "deny" ? "deny" : "allow" };
    rules[r.pattern] = "deny"; // OpenCode: the last matching rule wins, so specific denies come after "*"
    p[r.permission] = rules;
  }
  return p;
}

/** The OpenCode model id for an OpenRouter slug. */
export const opencodeModel = (slug) => `openrouter/${slug}`;

/** The locked-policy plugin (guards + the jarvis_* tools), root-owned in the image. */
export const POLICY_PLUGIN = "/usr/local/lib/jarvis/lib/opencode-plugin.mjs";

export function opencodeConfig(o) {
  const model = opencodeModel(o.model);
  return {
    $schema: "https://opencode.ai/config.json",
    model,
    plugin: [`file://${o.pluginPath || POLICY_PLUGIN}`],
    small_model: model,
    autoupdate: false,
    share: "disabled",
    instructions: [o.instructionsPath],
    skills: { paths: [o.skillsDir] },
    permission: permissions(o.bundle.deny),
    provider: {
      openrouter: {
        options: {
          apiKey: "{env:OPENROUTER_API_KEY}",
          ...(o.baseUrl ? { baseURL: o.baseUrl } : {}),
        },
        // the curated model is always known to OpenCode, even when models.dev lacks it
        // images: the instance config says the model takes image input (models[].images), so
        // OpenCode passes attached images to it instead of refusing them
        models: { [o.model]: { tool_call: true, ...(o.images ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}) } },
      },
    },
  };
}

/**
 * Write everything for one boot. Instructions, skills and the OpenCode config are rebuilt from the
 * bundle every boot (a resumed task loads the layers as they are now); the workspace is untouched.
 */
export function writeLayers(bundle, o) {
  const instructionsPath = join(o.jarvisDir, "instructions.md");
  const skillsDir = join(o.jarvisDir, "skills");
  mkdirSync(o.jarvisDir, { recursive: true });
  writeFileSync(instructionsPath, renderInstructions(bundle, o));
  writeFileSync(join(o.jarvisDir, "bundle.json"), JSON.stringify(bundle, null, 1));
  rmSync(skillsDir, { recursive: true, force: true });
  for (const [rel, text] of skillFiles(bundle)) {
    const p = join(skillsDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  // the built-in web-tools skill, unless a layer already has a skill of that name
  if (o.tools && !bundle.skills.some((sk) => sk.name === WEB_SKILL)) {
    mkdirSync(join(skillsDir, WEB_SKILL), { recursive: true });
    writeFileSync(join(skillsDir, WEB_SKILL, "SKILL.md"), webSkill(o.tools, o.proxyUrl));
  }
  const cfg = opencodeConfig({ model: o.model, bundle, instructionsPath, skillsDir, baseUrl: o.baseUrl, pluginPath: o.pluginPath, images: o.images });
  mkdirSync(dirname(o.opencodeConfigPath), { recursive: true });
  writeFileSync(o.opencodeConfigPath, JSON.stringify(cfg, null, 1));
  return { instructionsPath, skillsDir, config: cfg };
}
