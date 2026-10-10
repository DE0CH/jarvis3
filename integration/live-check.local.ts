// Ad-hoc live check of a deployed instance (not committed): create a task as the signed-in admin
// (CF_Authorization cookie from a storage-state file), wait for the session, ask, check the answer,
// then delete the task. Usage: node live-check.local.ts <host> <state.json> <model>
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { createPaseoClient } from "@getpaseo/client";

const [host, statePath, model] = process.argv.slice(2);
const state = JSON.parse(readFileSync(statePath!, "utf8"));
const cookie = state.cookies.filter((c: any) => host!.endsWith(c.domain.replace(/^\./, ""))).map((c: any) => `${c.name}=${c.value}`).join("; ");
const base = `https://${host}`;
const WORD = "PERSIMMON" + Math.floor(Math.random() * 1000);
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = text.slice(0, 200); }
  return { status: r.status, body: j };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const me = await call("GET", "/api/me");
log(`/api/me ${me.status} ${JSON.stringify({ email: me.body?.email, role: me.body?.role, isAdmin: me.body?.isAdmin })}`);
const models = await call("GET", "/api/models");
log(`/api/models ${models.status} ${JSON.stringify(models.body).slice(0, 200)}`);
const c = await call("POST", "/api/tasks", { prompt: `Reply with only this word and nothing else: ${WORD}`, requestId: `live-${Date.now()}`, model });
log(`create ${c.status} ${JSON.stringify(c.body).slice(0, 300)}`);
if (c.status !== 201) process.exit(1);
const id = c.body.id;
let v: any;
for (;;) {
  v = (await call("GET", `/api/tasks/${id}`)).body;
  if (v.state === "failed" || (v.state === "paused" && !v.busy)) { log(`task ${v.state}: ${v.error}`); break; }
  if (v.connected && (v.state === "running" || v.state === "idle")) { log(`session connected, state ${v.state}`); break; }
  if (Date.now() - t0 > 8 * 60_000) { log(`timeout, last ${JSON.stringify(v).slice(0, 300)}`); break; }
  await sleep(3000);
}
let ok = false;
if (v.connected) {
  const client = createPaseoClient({
    url: `wss://${host}/api/tasks/${id}/daemon`,
    reconnect: { enabled: false },
    webSocketFactory: (url: string, o?: { headers?: Record<string, string>; protocols?: string[] }) =>
      new WebSocket(url, o?.protocols ?? [], { headers: { ...(o?.headers ?? {}), cookie, origin: base } }),
  } as any);
  await client.connect();
  let agents: any[] = [];
  for (let i = 0; i < 60 && !agents.length; i++) {
    agents = (await client.agents.list()).entries.map((e: any) => e.agent ?? e);
    if (!agents.length) await sleep(2000);
  }
  const r = await client.agents.ref(agents[0].id).waitForFinish(5 * 60_000);
  ok = String(r.lastMessage).includes(WORD);
  log(`answer (${r.status}): ${JSON.stringify(String(r.lastMessage).slice(0, 120))} -> ${ok ? "OK" : "WRONG"}`);
  await client.close();
}
if (process.env.KEEP !== "1") {
  const d = await call("DELETE", `/api/tasks/${id}`);
  log(`delete ${d.status}`);
  for (let i = 0; i < 100; i++) {
    v = (await call("GET", `/api/tasks/${id}`)).body;
    if (v.state === "archived" && !v.busy) break;
    await sleep(3000);
  }
  log(`final state ${v.state} ${v.error ?? ""}`);
}
process.exit(ok ? 0 : 1);
