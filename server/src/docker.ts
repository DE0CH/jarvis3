// Local-Docker implementation of MachineProvider, for CI integration runs and local development.
// Talks to the Docker Engine API over its unix socket (no CLI, no dependency). One container per
// session machine; every container carries labels naming the instance, so list() sees only this
// instance's machines. Docs: https://docs.docker.com/reference/api/engine/
//
// Not for production: a container is not the per-session microVM DESIGN.md assumes.
import { request } from "node:http";
import type { ExecResult, MachineInfo, MachineProvider, MachineSpec, MachineState } from "./providers.ts";
import { httpError } from "./errors.ts";
import { randomId } from "./crypto.ts";

const API = "/v1.41";
const L_INSTANCE = "jarvis3.instance";
const L_NAME = "jarvis3.name";
const L_GUEST = "jarvis3.guest";
const L_META = "jarvis3.meta.";

export interface DockerOptions {
  /** The instance name; scopes list() to this instance's containers. */
  instance: string;
  /** Docker Engine socket (default /var/run/docker.sock). */
  socketPath?: string;
  /** Docker network to attach containers to (default: the bridge network). */
  network?: string;
  /**
   * Env values set (or replaced) in every machine. Containers can't reach the instance at its public URL in
   * a local run, so e.g. JARVIS_URL becomes http://<docker gateway>:<port>, and a test points
   * OPENROUTER_BASE_URL at a stub.
   */
  envOverrides?: Record<string, string>;
  /** Extra /etc/hosts entries ("name:ip" or "name:host-gateway"). */
  extraHosts?: string[];
  /** Pull an image that isn't present locally (default true). */
  pull?: boolean;
}

interface DockerResponse {
  status: number;
  body: Buffer;
}

interface ContainerSummary {
  Id: string;
  Names?: string[];
  State: string;
  Labels?: Record<string, string>;
}

/** Demultiplex Docker's attach/exec stream: frames of [stream(1), 0,0,0, size(u32 BE)] + payload. */
export function demux(buf: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const kind = buf[i]!;
    const size = buf.readUInt32BE(i + 4);
    const chunk = buf.subarray(i + 8, i + 8 + size);
    (kind === 2 ? err : out).push(chunk);
    i += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

export function dockerState(s: string): MachineState {
  switch (s) {
    case "created":
      return "created";
    case "running":
    case "restarting":
      return "started";
    case "paused":
    case "exited":
      return "stopped";
    case "removing":
      return "destroying";
    case "dead":
      return "failed";
    default:
      return "failed";
  }
}

export class DockerMachines implements MachineProvider {
  readonly #o: Required<Omit<DockerOptions, "network">> & { network: string | undefined };
  constructor(o: DockerOptions) {
    this.#o = { socketPath: "/var/run/docker.sock", envOverrides: {}, extraHosts: [], pull: true, network: undefined, ...o };
  }

  #req(method: string, path: string, body?: unknown, timeoutMs = 120_000): Promise<DockerResponse> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = request(
        {
          socketPath: this.#o.socketPath,
          method,
          path: API + path,
          headers: { Host: "docker", ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      r.on("timeout", () => r.destroy(new Error(`docker ${method} ${path} timed out`)));
      r.on("error", (e) => reject(httpError("upstream", `docker ${method} ${path}: ${e.message}`)));
      if (payload) r.write(payload);
      r.end();
    });
  }

  async #call<T>(method: string, path: string, body?: unknown, ok: number[] = [200, 201, 204], timeoutMs?: number): Promise<{ status: number; json: T }> {
    const r = await this.#req(method, path, body, timeoutMs);
    if (!ok.includes(r.status)) throw Object.assign(httpError("upstream", `docker ${method} ${path} -> ${r.status}: ${r.body.toString().slice(0, 300)}`), { dockerStatus: r.status });
    const text = r.body.toString().trim();
    return { status: r.status, json: (text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : {}) as T };
  }

  #view(c: { Id: string; State: string; Labels?: Record<string, string> }): MachineInfo {
    const labels = c.Labels || {};
    const metadata: Record<string, string> = {};
    for (const [k, v] of Object.entries(labels)) if (k.startsWith(L_META)) metadata[k.slice(L_META.length)] = v;
    let guest: MachineSpec["guest"] = { cpu_kind: "shared", cpus: 1, memory_mb: 1024 };
    try {
      if (labels[L_GUEST]) guest = JSON.parse(labels[L_GUEST]) as MachineSpec["guest"];
    } catch {
      /* default */
    }
    return { id: c.Id, name: labels[L_NAME] || "", state: dockerState(c.State), metadata, guest };
  }

  async create(spec: MachineSpec): Promise<MachineInfo> {
    const env = { ...spec.env, ...this.#o.envOverrides };
    const labels: Record<string, string> = { [L_INSTANCE]: this.#o.instance, [L_NAME]: spec.name, [L_GUEST]: JSON.stringify(spec.guest) };
    for (const [k, v] of Object.entries(spec.metadata)) labels[L_META + k] = v;
    const body = {
      Image: spec.image,
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: labels,
      HostConfig: {
        NanoCpus: Math.round(spec.guest.cpus * 1e9),
        Memory: spec.guest.memory_mb * 1024 * 1024,
        ExtraHosts: this.#o.extraHosts,
        Init: false,
        ...(this.#o.network ? { NetworkMode: this.#o.network } : {}),
      },
    };
    const name = `${spec.name}-${randomId(3)}`.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const path = `/containers/create?name=${encodeURIComponent(name)}`;
    let r = await this.#req("POST", path, body);
    if (r.status === 404 && this.#o.pull) {
      await this.#pull(spec.image);
      r = await this.#req("POST", path, body);
    }
    if (r.status !== 201) throw httpError("upstream", `docker create -> ${r.status}: ${r.body.toString().slice(0, 300)}`);
    const { Id } = JSON.parse(r.body.toString()) as { Id: string };
    return this.#view({ Id, State: "created", Labels: labels });
  }

  async #pull(image: string): Promise<void> {
    const at = image.lastIndexOf(":");
    const slash = image.lastIndexOf("/");
    const [from, tag] = at > slash ? [image.slice(0, at), image.slice(at + 1)] : [image, "latest"];
    // The answer is a stream of JSON progress lines; a failed pull is a 200 with an {"error"} line.
    const r = await this.#req("POST", `/images/create?fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`, undefined, 15 * 60_000);
    const failed = r.body
      .toString()
      .split("\n")
      .map((l) => {
        try {
          return (JSON.parse(l) as { error?: string }).error;
        } catch {
          return undefined;
        }
      })
      .find(Boolean);
    if (r.status !== 200 || failed) throw httpError("upstream", `docker pull ${image} -> ${r.status}: ${(failed || r.body.toString()).slice(0, 300)}`);
  }

  async start(id: string): Promise<void> {
    await this.#call("POST", `/containers/${encodeURIComponent(id)}/start`, undefined, [204, 304]);
  }

  async destroy(id: string): Promise<void> {
    await this.#call("DELETE", `/containers/${encodeURIComponent(id)}?force=true&v=true`, undefined, [204, 404]);
  }

  async exec(id: string, command: string[], timeoutSeconds = 30): Promise<ExecResult> {
    const c = await this.#call<{ Id: string }>("POST", `/containers/${encodeURIComponent(id)}/exec`, { Cmd: command, AttachStdout: true, AttachStderr: true, Tty: false }, [201]);
    const r = await this.#req("POST", `/exec/${c.json.Id}/start`, { Detach: false, Tty: false }, timeoutSeconds * 1000);
    if (r.status !== 200) throw httpError("upstream", `docker exec start -> ${r.status}: ${r.body.toString().slice(0, 300)}`);
    const { stdout, stderr } = demux(r.body);
    const info = await this.#call<{ ExitCode: number | null }>("GET", `/exec/${c.json.Id}/json`);
    return { stdout, stderr, exitCode: info.json.ExitCode ?? 0 };
  }

  async list(): Promise<MachineInfo[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${L_INSTANCE}=${this.#o.instance}`] }));
    const r = await this.#call<ContainerSummary[]>("GET", `/containers/json?all=true&filters=${filters}`);
    return (r.json as ContainerSummary[]).map((c) => this.#view(c));
  }
}
