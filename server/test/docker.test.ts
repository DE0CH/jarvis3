// DockerMachines against a fake Docker Engine API on a unix socket: request shapes, labels,
// env overrides, the exec stream demux, image pull on a missing image, state mapping.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerMachines, demux, dockerState } from "../src/docker.ts";

interface Container {
  Id: string;
  name: string;
  State: string;
  Labels: Record<string, string>;
  Env: string[];
  HostConfig: Record<string, unknown>;
  Image: string;
}

class FakeEngine {
  containers = new Map<string, Container>();
  images = new Set<string>(["example/session:test"]);
  pulls: string[] = [];
  execs = new Map<string, { container: string; cmd: string[]; exit: number }>();
  log: string[] = [];
  server: Server;
  socket: string;
  #dir: string;
  #n = 0;
  constructor() {
    this.#dir = mkdtempSync(join(tmpdir(), "fake-docker-"));
    this.socket = join(this.#dir, "docker.sock");
    this.server = createServer((req, res) => void this.#handle(req, res));
  }
  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(this.socket, () => r()));
  }
  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
    rmSync(this.#dir, { recursive: true, force: true });
  }
  async #body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString();
    return t ? JSON.parse(t) : undefined;
  }
  async #handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const url = new URL(req.url!, "http://docker");
    const path = url.pathname.replace(/^\/v1\.\d+/, "");
    this.log.push(`${req.method} ${path}`);
    const json = (status: number, body?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    const body = await this.#body(req);
    let m: RegExpExecArray | null;
    if (req.method === "POST" && path === "/containers/create") {
      if (!this.images.has(body.Image)) return json(404, { message: `No such image: ${body.Image}` });
      const id = `c${++this.#n}`.padEnd(12, "0");
      this.containers.set(id, { Id: id, name: url.searchParams.get("name")!, State: "created", Labels: body.Labels, Env: body.Env, HostConfig: body.HostConfig, Image: body.Image });
      return json(201, { Id: id, Warnings: [] });
    }
    if (req.method === "POST" && path === "/images/create") {
      const ref = `${url.searchParams.get("fromImage")}:${url.searchParams.get("tag")}`;
      this.pulls.push(ref);
      this.images.add(ref);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(`{"status":"Pulling"}\n{"status":"Done"}\n`);
    }
    if ((m = /^\/containers\/([^/]+)\/start$/.exec(path)) && req.method === "POST") {
      const c = this.containers.get(m[1]!);
      if (!c) return json(404, { message: "no such container" });
      c.State = "running";
      return json(204);
    }
    if ((m = /^\/containers\/([^/]+)$/.exec(path)) && req.method === "DELETE") {
      if (!this.containers.delete(m[1]!)) return json(404, { message: "no such container" });
      assert.equal(url.searchParams.get("force"), "true");
      return json(204);
    }
    if ((m = /^\/containers\/([^/]+)\/exec$/.exec(path)) && req.method === "POST") {
      const c = this.containers.get(m[1]!);
      if (!c || c.State !== "running") return json(409, { message: "container is not running" });
      const id = `e${++this.#n}`;
      this.execs.set(id, { container: c.Id, cmd: body.Cmd, exit: body.Cmd[0] === "false" ? 1 : 0 });
      return json(201, { Id: id });
    }
    if ((m = /^\/exec\/([^/]+)\/start$/.exec(path)) && req.method === "POST") {
      const e = this.execs.get(m[1]!)!;
      const frame = (kind: number, s: string) => {
        const p = Buffer.from(s);
        const h = Buffer.alloc(8);
        h[0] = kind;
        h.writeUInt32BE(p.length, 4);
        return Buffer.concat([h, p]);
      };
      res.writeHead(200, { "content-type": "application/vnd.docker.raw-stream" });
      res.write(frame(1, `out:${e.cmd.join(" ")}\n`));
      res.write(frame(2, "warn\n"));
      return res.end(frame(1, "more\n"));
    }
    if ((m = /^\/exec\/([^/]+)\/json$/.exec(path)) && req.method === "GET") {
      return json(200, { ExitCode: this.execs.get(m[1]!)!.exit, Running: false });
    }
    if (path === "/containers/json" && req.method === "GET") {
      assert.equal(url.searchParams.get("all"), "true");
      const f = JSON.parse(url.searchParams.get("filters")!) as { label: string[] };
      const [k, v] = f.label[0]!.split("=");
      return json(
        200,
        [...this.containers.values()].filter((c) => c.Labels[k!] === v).map((c) => ({ Id: c.Id, Names: [`/${c.name}`], State: c.State, Labels: c.Labels })),
      );
    }
    json(404, { message: `unhandled ${req.method} ${path}` });
  }
}

const spec = (over: Partial<Parameters<DockerMachines["create"]>[0]> = {}) => ({
  name: "task-abc",
  image: "example/session:test",
  env: { JARVIS_URL: "https://jarvis.example.org", JARVIS_TASK_ID: "abc" },
  metadata: { jarvisTask: "abc", jarvisUser: "u1" },
  guest: { cpu_kind: "shared" as const, cpus: 2, memory_mb: 2048 },
  ...over,
});

async function withEngine(fn: (e: FakeEngine, d: DockerMachines) => Promise<void>, opts: Partial<ConstructorParameters<typeof DockerMachines>[0]> = {}) {
  const e = new FakeEngine();
  await e.listen();
  try {
    await fn(e, new DockerMachines({ instance: "example", socketPath: e.socket, ...opts }));
  } finally {
    await e.close();
  }
}

test("demux splits stdout and stderr frames", () => {
  const f = (k: number, s: string) => {
    const h = Buffer.alloc(8);
    h[0] = k;
    h.writeUInt32BE(Buffer.byteLength(s), 4);
    return Buffer.concat([h, Buffer.from(s)]);
  };
  assert.deepEqual(demux(Buffer.concat([f(1, "a"), f(2, "b"), f(1, "c")])), { stdout: "ac", stderr: "b" });
  assert.deepEqual(demux(Buffer.alloc(0)), { stdout: "", stderr: "" });
});

test("docker states map onto machine states", () => {
  assert.equal(dockerState("running"), "started");
  assert.equal(dockerState("created"), "created");
  assert.equal(dockerState("exited"), "stopped");
  assert.equal(dockerState("removing"), "destroying");
  assert.equal(dockerState("dead"), "failed");
});

test("create: env with overrides, labels carry instance + metadata + guest, limits from the guest", async () => {
  await withEngine(
    async (e, d) => {
      const m = await d.create(spec());
      assert.equal(m.state, "created");
      assert.equal(m.name, "task-abc");
      assert.deepEqual(m.metadata, { jarvisTask: "abc", jarvisUser: "u1" });
      const c = e.containers.get(m.id)!;
      assert.match(c.name, /^task-abc-[0-9a-f]{6}$/);
      assert.ok(c.Env.includes("JARVIS_URL=http://172.17.0.1:8080"), "override replaces the public URL");
      assert.ok(c.Env.includes("JARVIS_TASK_ID=abc"));
      assert.ok(c.Env.includes("OPENROUTER_BASE_URL=http://172.17.0.1:9999/api/v1"), "override adds a variable");
      assert.equal(c.Labels["jarvis3.instance"], "example");
      assert.equal(c.HostConfig.NanoCpus, 2e9);
      assert.equal(c.HostConfig.Memory, 2048 * 1024 * 1024);
      assert.deepEqual(c.HostConfig.ExtraHosts, ["host.docker.internal:host-gateway"]);
      assert.equal(c.HostConfig.NetworkMode, "jarvis-net");
    },
    {
      envOverrides: { JARVIS_URL: "http://172.17.0.1:8080", OPENROUTER_BASE_URL: "http://172.17.0.1:9999/api/v1" },
      extraHosts: ["host.docker.internal:host-gateway"],
      network: "jarvis-net",
    },
  );
});

test("create pulls a missing image once, then creates", async () => {
  await withEngine(async (e, d) => {
    const m = await d.create(spec({ image: "ghcr.io/example/session:v2" }));
    assert.deepEqual(e.pulls, ["ghcr.io/example/session:v2"]);
    assert.ok(e.containers.has(m.id));
  });
});

test("create without pulling fails as upstream", async () => {
  await withEngine(
    async (_e, d) => {
      await assert.rejects(d.create(spec({ image: "ghcr.io/example/missing:1" })), (err: any) => err.code === "upstream");
    },
    { pull: false },
  );
});

test("start, exec (stdout/stderr/exit code), list scoped to the instance, destroy (idempotent)", async () => {
  await withEngine(async (e, d) => {
    const m = await d.create(spec());
    await d.start(m.id);
    const r = await d.exec(m.id, ["/usr/local/bin/jarvis-snapshot", "status", "r1"]);
    assert.equal(r.stdout, "out:/usr/local/bin/jarvis-snapshot status r1\nmore\n");
    assert.equal(r.stderr, "warn\n");
    assert.equal(r.exitCode, 0);
    assert.equal((await d.exec(m.id, ["false"])).exitCode, 1);

    // another instance's container is not listed
    e.containers.set("other", { Id: "other", name: "x", State: "running", Labels: { "jarvis3.instance": "someone-else" }, Env: [], HostConfig: {}, Image: "x" });
    const list = await d.list();
    assert.deepEqual(
      list.map((x) => [x.id, x.state, x.name, x.guest.memory_mb]),
      [[m.id, "started", "task-abc", 2048]],
    );

    await d.destroy(m.id);
    await d.destroy(m.id); // already gone: fine
    assert.equal(e.containers.has(m.id), false);
    assert.deepEqual((await d.list()).length, 0);
  });
});

test("exec on a stopped container is an upstream error", async () => {
  await withEngine(async (_e, d) => {
    const m = await d.create(spec());
    await assert.rejects(d.exec(m.id, ["true"]), (err: any) => err.code === "upstream");
  });
});

test("an unreachable engine is an upstream error", async () => {
  const d = new DockerMachines({ instance: "example", socketPath: "/nonexistent/docker.sock" });
  await assert.rejects(d.list(), (err: any) => err.code === "upstream");
});
