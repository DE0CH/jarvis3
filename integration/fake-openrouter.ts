// A stand-in for OpenRouter, for the integration test: the key-management API the server mints
// per-user keys with, and an OpenAI-compatible chat completions endpoint that OpenCode (inside the
// real session image) talks to. Its "model" is a script:
//
//   last message is a tool result          -> "TOOL RESULT: <first line of the output>"
//   the user says "remember: <note>"       -> a bash tool call: jarvis-remember "<note>"
//   the user says "run: <command>"         -> a bash tool call running <command>
//   the user says "call: <tool> <json>"    -> a call of any tool (e.g. jarvis_action) with those arguments
//   a request without tools (title etc.)   -> "Scripted title"
//   anything else                          -> "ECHO: <the user's text>"
//
// Every chat request is recorded (with the key it carried) so the test can check what the model
// was given: the system prompt with the layers in order, the user's own key.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

export interface ChatRecord {
  key: string;
  model: string;
  system: string;
  lastUser: string;
  lastRole: string;
  /** Every message's text, in order: what the model was given of the conversation. */
  transcript: string;
  tools: string[];
  reply: Reply;
  /** Image parts in the user messages (an attachment sent inline). */
  images: number;
}

type Reply = { text: string } | { tool: { name: string; args: Record<string, unknown> } };

interface Msg {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
}

export class FakeOpenRouter {
  readonly keys = new Map<string, { hash: string; name: string; limit: number | null; deleted: boolean }>();
  readonly chats: ChatRecord[] = [];
  readonly managementKey = "mgmt-" + randomBytes(8).toString("hex");
  #server: Server;
  #n = 0;
  constructor() {
    this.#server = createServer((req, res) => {
      void this.#handle(req, res).catch((e: Error) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: e.message } }));
      });
    });
  }

  listen(host = "0.0.0.0"): Promise<number> {
    return new Promise((r) => this.#server.listen(0, host, () => r((this.#server.address() as AddressInfo).port)));
  }
  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((r) => this.#server.close(() => r()));
  }

  /** Keys minted and not deleted. */
  liveKeys(): string[] {
    return [...this.keys.entries()].filter(([, v]) => !v.deleted).map(([k]) => k);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, "http://x");
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "";
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
    const json = (status: number, b: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(b));
    };
    const path = url.pathname.replace(/\/+$/, "");

    // ---- key management (OpenRouterKeys) ----
    if (path.startsWith("/api/v1/keys")) {
      if (auth !== this.managementKey) return json(401, { error: { message: "bad management key" } });
      const hash = path.split("/")[4];
      if (req.method === "POST" && !hash) {
        const key = `sk-or-v1-fake-${randomBytes(12).toString("hex")}`;
        const h = `hash${++this.#n}`;
        this.keys.set(key, { hash: h, name: String(body.name), limit: body.limit ?? null, deleted: false });
        return json(201, { data: { hash: h, name: body.name, limit: body.limit }, key });
      }
      const entry = [...this.keys.values()].find((k) => k.hash === hash && !k.deleted);
      if (!entry) return json(404, { error: { message: "no such key" } });
      if (req.method === "PATCH") {
        entry.limit = body.limit ?? null;
        return json(200, { data: entry });
      }
      if (req.method === "DELETE") {
        entry.deleted = true;
        return json(200, { deleted: true });
      }
    }

    // ---- models (in case a client lists them) ----
    if (req.method === "GET" && path === "/api/v1/models") {
      return json(200, { data: [] });
    }

    // ---- chat ----
    if (req.method === "POST" && path === "/api/v1/chat/completions") {
      const k = this.keys.get(auth);
      if (!k || k.deleted) return json(401, { error: { message: "unknown key", code: 401 } });
      const messages = (body.messages || []) as Msg[];
      const reply = script(messages, (body.tools || []).length > 0);
      this.chats.push({
        key: auth,
        model: String(body.model),
        system: messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n"),
        lastUser: lastUserText(messages),
        lastRole: messages.at(-1)?.role || "",
        transcript: messages.map((m) => textOf(m.content)).join("\n"),
        tools: (body.tools || []).map((t: { function?: { name?: string } }) => t.function?.name || ""),
        reply,
        images: messages
          .filter((m) => m.role === "user" && Array.isArray(m.content))
          .flatMap((m) => m.content as { type?: string }[])
          .filter((p) => p?.type === "image_url" || p?.type === "image" || p?.type === "file").length,
      });
      return body.stream ? stream(res, String(body.model), reply) : json(200, completion(String(body.model), reply));
    }
    json(404, { error: { message: `fake openrouter: no route ${req.method} ${path}` } });
  }
}

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: { type?: string; text?: string }) => (p?.type === "text" || typeof p?.text === "string" ? p.text || "" : "")).join("\n");
  return "";
}

function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return textOf(messages[i]!.content);
  return "";
}

export function script(messages: Msg[], hasTools: boolean): Reply {
  const last = messages.at(-1);
  if (!hasTools) return { text: "Scripted title" };
  if (last?.role === "tool") {
    const out = textOf(last.content).trim().split("\n")[0] || "(no output)";
    return { text: `TOOL RESULT: ${out}` };
  }
  const user = lastUserText(messages);
  // Paseo asks the agent's model for structured answers (e.g. a title + branch name) with a JSON
  // schema in the prompt: answer with the schema's required keys.
  const schema = /"required"\s*:\s*\[([^\]]*)\]/.exec(user);
  if (schema && /JSON/i.test(user)) {
    const keys = [...schema[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    return { text: JSON.stringify(Object.fromEntries(keys.map((k) => [k, k === "branch" ? "scripted-title" : "Scripted title"]))) };
  }
  if (/is not valid JSON|matches the schema/i.test(user)) return { text: JSON.stringify({ title: "Scripted title", branch: "scripted-title" }) };
  const remember = /remember:\s*(.+)/i.exec(user);
  if (remember) {
    const note = remember[1]!.trim().replace(/["\\$`]/g, "");
    return { tool: { name: "bash", args: { command: `jarvis-remember "${note}"`, description: "Save a note for the user" } } };
  }
  const callTool = /call:\s*([a-z_]+)\s+(\{.*\})\s*$/is.exec(user);
  if (callTool) return { tool: { name: callTool[1]!, args: JSON.parse(callTool[2]!) as Record<string, unknown> } };
  const run = /run:\s*(.+)/i.exec(user);
  if (run) return { tool: { name: "bash", args: { command: run[1]!.trim(), description: "Run a command" } } };
  return { text: `ECHO: ${user.trim().split("\n").at(-1)}` };
}

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 };

function completion(model: string, reply: Reply) {
  const message =
    "text" in reply
      ? { role: "assistant", content: reply.text }
      : { role: "assistant", content: null, tool_calls: [{ id: "call_" + randomBytes(4).toString("hex"), type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] };
  return {
    id: "gen-" + randomBytes(6).toString("hex"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: "text" in reply ? "stop" : "tool_calls" }],
    usage,
  };
}

function stream(res: ServerResponse, model: string, reply: Reply): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const id = "gen-" + randomBytes(6).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  const send = (delta: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  if ("text" in reply) {
    send({ role: "assistant", content: "" }, null);
    // two chunks, so streaming is exercised
    const half = Math.ceil(reply.text.length / 2);
    send({ content: reply.text.slice(0, half) }, null);
    send({ content: reply.text.slice(half) }, null);
    send({}, "stop", { usage });
  } else {
    const callId = "call_" + randomBytes(4).toString("hex");
    send({ role: "assistant", content: null, tool_calls: [{ index: 0, id: callId, type: "function", function: { name: reply.tool.name, arguments: "" } }] }, null);
    send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.tool.args) } }] }, null);
    send({}, "tool_calls", { usage });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}
