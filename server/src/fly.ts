// Fly Machines implementation of MachineProvider. Ported from Jarvis 1's lib/fly.js; one Fly app
// per instance holds the session machines. Docs: https://fly.io/docs/machines/api/
// Not exercised against real Fly in this repo's tests (the fake provider stands in).
import type { ExecResult, MachineInfo, MachineProvider, MachineSpec, MachineState } from "./providers.ts";
import { httpError } from "./errors.ts";

const API = "https://api.machines.dev/v1";
const RETRIES_429 = 4;

interface FlyMachine {
  id: string;
  name?: string;
  state: string;
  config?: { metadata?: Record<string, string>; guest?: MachineSpec["guest"] };
}

export interface FlyOptions {
  token: string;
  app: string;
  region: string;
  rootfsGb?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class FlyMachines implements MachineProvider {
  readonly #o: Required<FlyOptions>;
  constructor(o: FlyOptions) {
    this.#o = {
      rootfsGb: 16,
      fetch: globalThis.fetch,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      ...o,
    };
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let r: Response;
    // Fly rate-limits (429 = not performed), so every call, POSTs too, is retried after Retry-After.
    for (let attempt = 0; ; attempt++) {
      r = await this.#o.fetch(API + path, {
        method,
        headers: { Authorization: `Bearer ${this.#o.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      if (r.status !== 429 || attempt >= RETRIES_429) break;
      await r.text().catch(() => "");
      const after = parseFloat(r.headers.get("retry-after") || "");
      await this.#o.sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
    }
    const text = await r.text();
    if (!r.ok) throw Object.assign(httpError("upstream", `Fly ${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`), { flyStatus: r.status });
    return (text ? JSON.parse(text) : {}) as T;
  }

  #view(m: FlyMachine): MachineInfo {
    return {
      id: m.id,
      name: m.name || "",
      state: m.state as MachineState,
      metadata: m.config?.metadata || {},
      guest: m.config?.guest || { cpu_kind: "shared", cpus: 1, memory_mb: 1024 },
    };
  }

  async create(spec: MachineSpec): Promise<MachineInfo> {
    const m = await this.#call<FlyMachine>("POST", `/apps/${this.#o.app}/machines`, {
      name: spec.name,
      skip_launch: true,
      region: this.#o.region,
      config: {
        image: spec.image,
        env: spec.env,
        metadata: spec.metadata,
        auto_destroy: false,
        restart: { policy: "on-failure", max_retries: 3 },
        guest: spec.guest,
        rootfs: { size_gb: this.#o.rootfsGb },
      },
    });
    return this.#view(m);
  }
  async start(id: string): Promise<void> {
    await this.#call("POST", `/apps/${this.#o.app}/machines/${id}/start`);
  }
  async destroy(id: string): Promise<void> {
    try {
      await this.#call("DELETE", `/apps/${this.#o.app}/machines/${id}?force=true`);
    } catch (e) {
      if ((e as { flyStatus?: number }).flyStatus === 404) return;
      throw e;
    }
  }
  async exec(id: string, command: string[], timeoutSeconds = 30): Promise<ExecResult> {
    const r = await this.#call<{ stdout?: string; stderr?: string; exit_code?: number }>("POST", `/apps/${this.#o.app}/machines/${id}/exec`, {
      command,
      timeout: timeoutSeconds,
    });
    return { stdout: r.stdout || "", stderr: r.stderr || "", exitCode: r.exit_code ?? 0 };
  }
  async list(): Promise<MachineInfo[]> {
    const ms = await this.#call<FlyMachine[]>("GET", `/apps/${this.#o.app}/machines`);
    return ms.map((m) => this.#view(m));
  }
}
