// The session side of actions and approvals (docs/API.md section 11), shared by the OpenCode plugin
// (lib/opencode-plugin.mjs) and its tests. Everything goes through jarvis-agent's local socket,
// which holds the session token; the agent's own processes never do.
//
//   matchGuard   does a tool call hit a locked-policy guard (policy/guards.json)?
//   LocalClient  GET/POST on the agent socket
//   waitSettled  wait for a request's decision (long polls of ≤ 50 s, for as long as it takes)
//   outcome      what the agent is told once it is decided
import http from "node:http";

/** jarvis-agent's local socket (read when a client is made, so tests can point it elsewhere). */
export const socketPath = () => process.env.JARVIS_AGENT_SOCKET || "/run/jarvis/agent.sock";

/** The text a guard rule's regex is matched against: the bash command, or the tool's JSON arguments. */
export function guardInput(tool, args) {
  if (tool === "bash" && typeof args?.command === "string") return args.command;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return String(args);
  }
}

/** The first guard rule a tool call matches, or null. */
export function matchGuard(rules, tool, args) {
  const input = guardInput(tool, args);
  for (const r of rules || []) {
    if (r.tool !== "*" && r.tool !== tool) continue;
    let re;
    try {
      re = new RegExp(r.match, "i");
    } catch {
      continue; // the server validated it; never crash a tool call on a bad rule
    }
    if (re.test(input)) return { rule: r, input };
  }
  return null;
}

/** HTTP over the agent's unix socket. Resolves {status, body} (body parsed when JSON). */
export class LocalClient {
  constructor(path = socketPath()) {
    this.socketPath = path;
  }
  request(method, path, body, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
          signal,
        },
        (res) => {
          let out = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (out += c));
          res.on("end", () => {
            let parsed = out;
            try {
              parsed = out ? JSON.parse(out) : null;
            } catch {
              /* text */
            }
            resolve({ status: res.statusCode, body: parsed });
          });
        },
      );
      req.on("error", reject);
      req.end(data);
    });
  }
  get(path, o) {
    return this.request("GET", path, undefined, o);
  }
  post(path, body, o) {
    return this.request("POST", path, body, o);
  }
}

/** The server's error message from a forwarded error body. */
export function errorText(r) {
  const b = r.body;
  if (b && typeof b === "object") return b.error?.message || b.error || JSON.stringify(b);
  return String(b || `HTTP ${r.status}`);
}

/** Whether the session has its answer: an action once it ran (or won't); anything else once decided. */
export function settled(a) {
  if (a.kind === "action") return ["done", "failed", "denied", "cancelled"].includes(a.state);
  return a.state !== "pending";
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    });
  });

/**
 * Wait until a request is decided (and, for an action, has run). People take their time, so this
 * waits as long as it takes (or until `signal` aborts), with long polls of `pollSeconds`.
 */
export async function waitSettled(client, id, { signal, pollSeconds = 50, onPending } = {}) {
  let notified = false;
  for (let failures = 0; ; ) {
    signal?.throwIfAborted();
    let r;
    try {
      r = await client.get(`/approvals/${encodeURIComponent(id)}?wait=${pollSeconds}`, { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      r = { status: 0, body: String(e.message || e) };
    }
    if (r.status === 200 && r.body) {
      failures = 0;
      if (settled(r.body)) return r.body;
      if (!notified && onPending) onPending(r.body);
      notified = true;
      continue;
    }
    if (r.status === 404) throw new Error(`the request ${id} is gone`);
    // the agent or the server is briefly unreachable: back off and keep waiting
    failures++;
    await sleep(Math.min(1000 * 2 ** failures, 30_000), signal);
  }
}

const WHO = { self: "you (the task's owner)", admin: "an admin", owner: "the instance's owner (with a passkey)", auto: "the policy" };

/** One line for the agent while it waits. */
export const waitingText = (a) => `Waiting for ${WHO[a.approver] || a.approver} to decide: ${a.preview?.summary ?? a.id}`;

/** What the agent is told once a request is settled. */
export function outcome(a) {
  const note = a.decision?.note ? ` Note: ${a.decision.note.trim().replace(/[.\s]+$/, "")}.` : "";
  const by = a.decision?.by ? ` by ${a.decision.by.name || a.decision.by.email}` : "";
  switch (a.state) {
    case "done":
      return `Done: ${a.preview.summary}.${by && a.approver !== "auto" ? ` Approved${by}.` : ""} Result: ${JSON.stringify(a.result ?? {})}`;
    case "failed":
      return `Approved but it failed: ${a.error || "unknown error"}. Nothing else was done.`;
    case "denied":
      return `Denied${by}: ${a.preview.summary}.${note} Do not do this another way; tell the user.`;
    case "cancelled":
      return `Cancelled: ${a.error || "the task stopped before a decision"}.`;
    case "approved":
      if (a.kind === "question") return `Answer${by}: ${a.decision?.note ?? ""}`;
      if (a.kind === "access") return `Access granted${by} (${a.decision?.grantScope === "role" ? "for your role" : "for this task"}). You can now use ${a.action}.${note}`;
      return `Approved${by}.${note}`;
    default:
      return `State: ${a.state}`;
  }
}
