// The locked-policy hook: an OpenCode plugin loaded from opencode.json (`plugin`, a file:// entry
// written by lib/assemble.mjs), root-owned in the image. DESIGN "Actions and approvals".
//
//   tool.execute.before   a tool call matching a guard rule (policy/guards.json) stops: the rule's
//                         approver decides in the app, and the call runs only once approved
//                         (a denial fails the tool call with the reason)
//   jarvis_actions        the organisation's named actions (the broker's; credentials stay on the server)
//   jarvis_action         run one; the policy approves it, or the task's owner / an admin / the owner
//   jarvis_request_access ask an admin for an action this task's role lacks
//   jarvis_ask_boss       ask an admin a judgement question and wait for the answer
//   jarvis_wakeup         be woken later: at a time, on a schedule, or when a web page/API says so
//                         (the server resumes the task if it was paused and delivers the prompt)
//   jarvis_wakeups        list this task's wakeups, or cancel one
//   jarvis_post           post a result to this task's channel in the app (the owner is notified)
//   web_search, web_fetch Tier 0 web tools (lib/web.mjs): metered by the server against the task
//                         owner's monthly allowance, with the organisation's keys (never in here)
//
// There are no harness permission prompts: OpenCode runs with `allow`, and only these stop.
// OpenCode treats every export of a plugin file as a plugin, so this file exports only the plugin.
import { tool } from "@opencode-ai/plugin";
import { LocalClient, errorText, matchGuard, outcome, waitSettled, waitingText } from "./policy.mjs";
import { DEFAULT_INLINE_CHARS, fetchOutput, formatSearch, webCall } from "./web.mjs";
import { describeWakeup, wakeupRequest } from "./wakeups.mjs";
import { join } from "node:path";

const z = tool.schema;
// the web tools are NOT exempt: a guard rule may name web_fetch (or "*") like any other tool
const OWN_TOOLS = new Set(["jarvis_actions", "jarvis_action", "jarvis_request_access", "jarvis_ask_boss", "jarvis_wakeup", "jarvis_wakeups", "jarvis_post"]);
const PAGES_DIR = () => join(process.env.HOME || "/home/jarvis", "workspace", ".web");

export const JarvisPolicyPlugin = async () => {
  const client = new LocalClient();
  let guards = null;
  const loadGuards = async () => {
    if (guards) return guards;
    const r = await client.get("/guards");
    if (r.status !== 200 || !Array.isArray(r.body?.guards)) throw new Error(`the locked policy could not be loaded (${errorText(r)}); try again in a moment`);
    guards = r.body.guards;
    return guards;
  };

  /** File a request; then wait for its decision. */
  const ask = async (body, ctx) => {
    const r = await client.post("/approvals", body);
    if (r.status !== 201) throw new Error(errorText(r));
    const first = r.body;
    if (first.state === "pending") ctx?.metadata?.({ title: waitingText(first) });
    return waitSettled(client, first.id, { signal: ctx?.abort, onPending: (a) => ctx?.metadata?.({ title: waitingText(a) }) });
  };

  return {
    "tool.execute.before": async (input, output) => {
      if (OWN_TOOLS.has(input.tool)) return;
      const hit = matchGuard(await loadGuards(), input.tool, output.args);
      if (!hit) return;
      const a = await ask({ kind: "guard", rule: hit.rule.id, tool: input.tool, input: hit.input.slice(0, 20_000) });
      if (a.state !== "approved") throw new Error(`Stopped by the organisation's locked policy (${hit.rule.label}). ${outcome(a)}`);
      // approved: the tool call runs as asked
    },

    tool: {
      jarvis_actions: tool({
        description:
          "List the organisation's named actions (sending mail from a company mailbox, payments, …). They run on the Jarvis server with credentials this machine never holds. Use jarvis_action to run one.",
        args: {},
        async execute() {
          const r = await client.get("/actions");
          if (r.status !== 200) throw new Error(errorText(r));
          if (!r.body.actions.length) return "This organisation has no named actions.";
          return r.body.actions
            .map((a) => {
              const params = Object.entries(a.params)
                .map(([k, p]) => `    ${k}${p.required ? "" : "?"} (${p.type}): ${p.description}`)
                .join("\n");
              const avail = a.available ? `approval: ${a.approval}` : "NOT available to this task: ask with jarvis_request_access";
              return `- ${a.name}: ${a.label}${a.description ? ` — ${a.description}` : ""} [${avail}]\n${params}`;
            })
            .join("\n");
        },
      }),

      jarvis_action: tool({
        description:
          "Run one of the organisation's named actions (see jarvis_actions). The person who must approve it sees exactly what will happen; this call waits for the decision and returns the result. A denial is final: don't try another way.",
        args: {
          action: z.string().describe("the action's name, from jarvis_actions"),
          params: z.record(z.string(), z.any()).describe("the action's parameters, as listed by jarvis_actions"),
          reason: z.string().optional().describe("why, in one sentence, for the person deciding"),
        },
        async execute(args, ctx) {
          const a = await ask({ kind: "action", action: args.action, params: args.params ?? {}, ...(args.reason ? { reason: args.reason } : {}) }, ctx);
          return outcome(a);
        },
      }),

      jarvis_request_access: tool({
        description:
          "Ask an admin to let this task use a named action its role doesn't have (jarvis_actions marks it NOT available). Waits for the decision.",
        args: {
          action: z.string().describe("the action's name"),
          reason: z.string().describe("why this task needs it, for the admin"),
        },
        async execute(args, ctx) {
          return outcome(await ask({ kind: "access", action: args.action, reason: args.reason }, ctx));
        },
      }),

      web_search: tool({
        description:
          "Search the web (a real search engine, current results). Returns titles, URLs and snippets; set textChars to also get each page's extracted text. Each search costs a little of the user's monthly web-tools allowance, so prefer one well-phrased query over many. Then read pages with web_fetch.",
        args: {
          query: z.string().describe("what to search for, as you would type it into a search engine"),
          numResults: z.number().int().min(1).max(20).optional().describe("how many results, default 10"),
          textChars: z.number().int().min(0).max(20000).optional().describe("include up to this many characters of each page's text (dearer); default 0"),
          since: z.string().optional().describe("only pages published on or after this date, YYYY-MM-DD"),
          includeDomains: z.array(z.string()).max(20).optional().describe("only these domains, e.g. [\"gov.uk\"]"),
          country: z.string().length(2).optional().describe("two-letter country for localised results"),
        },
        async execute(args) {
          return formatSearch(await webCall(client, "/tools/search", args));
        },
      }),

      web_fetch: tool({
        description:
          "Fetch a web page through the organisation's scraping service: works on sites that block plain downloads, can run the page's JavaScript (render) and use residential IPs (premium, dearest) for bot-walled sites. Returns the raw HTML by default (format text for extracted text); the whole page is saved to a file under ~/workspace/.web and the start of it is returned. Costs a little of the user's monthly allowance (render and premium cost more): try a plain fetch first.",
        args: {
          url: z.string().describe("the page's absolute http(s) URL"),
          render: z.boolean().optional().describe("run the page's JavaScript first (pages that build their content in the browser)"),
          premium: z.boolean().optional().describe("residential IPs, for sites that block the plain fetch"),
          country: z.string().length(2).optional().describe("two-letter exit country (with premium)"),
          format: z.enum(["html", "text"]).optional().describe("html (default) or text"),
          inlineChars: z.number().int().min(1000).max(200000).optional().describe(`how much of the page to return inline, default ${DEFAULT_INLINE_CHARS}`),
        },
        async execute(args) {
          const { inlineChars, ...body } = args;
          const r = await webCall(client, "/tools/fetch", body);
          return fetchOutput(r, { url: args.url, dir: PAGES_DIR(), ...(inlineChars ? { inlineChars } : {}) });
        },
      }),

      jarvis_ask_boss: tool({
        description:
          "Ask an admin a judgement call you shouldn't make alone (a price, an exception, which customer first). Write the question so it can be answered without context; offer options when there are clear choices. Waits for the answer.",
        args: {
          question: z.string().describe("the question, self-contained"),
          options: z.array(z.string()).max(6).optional().describe("suggested answers"),
        },
        async execute(args, ctx) {
          return outcome(await ask({ kind: "question", question: args.question, ...(args.options?.length ? { options: args.options } : {}) }, ctx));
        },
      }),

      jarvis_wakeup: tool({
        description:
          "Be woken later with a prompt, instead of waiting: Jarvis delivers `prompt` to this task as a new message at the time (or when the condition holds), starting the task again first if it was paused meanwhile. Give exactly one of: `in` (a delay like 30m, 2h, 3d), `at` (a time: ISO with offset, or a wall-clock time in the user's zone like 2026-10-12T09:00 or 09:00), `cron` (a recurring five-field schedule in the user's zone, at most every 15 minutes), or `checkUrl` (a public https URL the server fetches every `every` until the condition holds: `contains`, `absent`, `status`, `changed`; no credentials, so only public pages/APIs). Write the prompt so it makes sense on its own later. Arming the same `name` again replaces that wakeup.",
        args: {
          prompt: z.string().describe("what to do when woken, self-contained"),
          name: z.string().optional().describe("a short name ([A-Za-z0-9_-]), to replace or cancel it later; default 'default'"),
          in: z.string().optional().describe("a delay: 90s, 30m, 2h, 3d"),
          at: z.string().optional().describe("a time: 2026-10-12T09:00 (user's zone), 09:00 (next), or ISO with offset"),
          cron: z.string().optional().describe("minute hour day month weekday, e.g. '0 9 * * MON'"),
          checkUrl: z.string().optional().describe("a public https URL to check"),
          contains: z.string().optional().describe("check: passes when the body contains this text"),
          absent: z.string().optional().describe("check: passes when the body no longer contains this text"),
          status: z.number().int().optional().describe("check: passes when the HTTP status is this"),
          changed: z.boolean().optional().describe("check: passes when the body differs from the first check's"),
          every: z.string().optional().describe("check: how often, e.g. 5m (default 5m, at least 1m)"),
          until: z.string().optional().describe("check: give up at this time (default 7 days, at most 30); cron: last firing before this"),
          failPrompt: z.string().optional().describe("check: delivered instead if it gives up"),
        },
        async execute(args) {
          const req = wakeupRequest(args, { tz: process.env.JARVIS_TIME_ZONE || "UTC" });
          const r = await client.post("/wakeups", req);
          if (r.status !== 201) throw new Error(errorText(r));
          return `Wakeup armed. ${describeWakeup(r.body).slice(2)}. You may end your turn now; the task can be paused meanwhile.`;
        },
      }),

      jarvis_wakeups: tool({
        description: "List this task's armed wakeups, or cancel one by name.",
        args: { cancel: z.string().optional().describe("the name of a wakeup to cancel") },
        async execute(args) {
          if (args.cancel) {
            const r = await client.request("DELETE", `/wakeups/${encodeURIComponent(args.cancel)}`);
            if (r.status !== 200) throw new Error(errorText(r));
            return `Cancelled the wakeup "${args.cancel}".`;
          }
          const r = await client.get("/wakeups");
          if (r.status !== 200) throw new Error(errorText(r));
          const armed = r.body.wakeups.filter((w) => w.state === "armed");
          return armed.length ? armed.map(describeWakeup).join("\n") : "No wakeups are armed.";
        },
      }),

      jarvis_post: tool({
        description:
          "Post a result to this task's channel in the Jarvis app: a report, a summary, the outcome of a scheduled run. The task's owner gets a notice and reads it in the app. Markdown, up to 20000 characters. Use it for results worth keeping, not for progress chatter.",
        args: {
          text: z.string().describe("the post, markdown"),
          title: z.string().optional().describe("a short title (default: the first line)"),
        },
        async execute(args) {
          const r = await client.post("/posts", { text: args.text, ...(args.title ? { title: args.title } : {}) });
          if (r.status !== 201) throw new Error(errorText(r));
          return `Posted to the task's channel: ${r.body.title}`;
        },
      }),
    },
  };
};
