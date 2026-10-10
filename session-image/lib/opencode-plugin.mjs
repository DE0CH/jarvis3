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
//
// There are no harness permission prompts: OpenCode runs with `allow`, and only these stop.
// OpenCode treats every export of a plugin file as a plugin, so this file exports only the plugin.
import { tool } from "@opencode-ai/plugin";
import { LocalClient, errorText, matchGuard, outcome, waitSettled, waitingText } from "./policy.mjs";

const z = tool.schema;
const OWN_TOOLS = new Set(["jarvis_actions", "jarvis_action", "jarvis_request_access", "jarvis_ask_boss"]);

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
    },
  };
};
