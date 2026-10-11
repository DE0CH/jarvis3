// In-memory MachineProvider (in the spirit of Jarvis 2's fakefly). It also plays the session
// image's side of the snapshot contract (docs/API.md "Session machine contract"): exec of
// `jarvis-snapshot start <run> <url>` "uploads" through `upload`, `status` reports the result.
import type { ExecResult, MachineInfo, MachineProvider, MachineSpec } from "../providers.ts";
import { randomId } from "../crypto.ts";

export interface FakeMachine extends MachineInfo {
  env: Record<string, string>;
  image: string;
}

export class FakeMachines implements MachineProvider {
  readonly machines = new Map<string, FakeMachine>();
  readonly destroyed: string[] = [];
  readonly execLog: { id: string; command: string[] }[] = [];
  failCreate: string | null = null;
  /** The provider makes the machine but the create call still fails (Fly's 408 on a slow create). */
  failCreateAfterMaking: string | null = null;
  failSnapshot: string | null = null;
  /** While set, snapshot status stays "running" (to observe a task mid-operation). */
  hold: Promise<void> | null = null;
  /** Called with the presigned URL when a snapshot "uploads" (wired to FakeBlobStore.acceptPut). */
  upload: (url: string) => Promise<void> = async () => {};
  #runs = new Map<string, string>();

  async create(spec: MachineSpec): Promise<MachineInfo> {
    if (this.failCreate) throw new Error(this.failCreate);
    const id = randomId(7);
    const m: FakeMachine = { id, name: spec.name, state: "created", metadata: { ...spec.metadata }, guest: spec.guest, env: { ...spec.env }, image: spec.image };
    this.machines.set(id, m);
    if (this.failCreateAfterMaking) throw new Error(this.failCreateAfterMaking);
    return { ...m };
  }
  async start(id: string): Promise<void> {
    const m = this.machines.get(id);
    if (!m) throw new Error(`no machine ${id}`);
    m.state = "started";
  }
  async destroy(id: string): Promise<void> {
    if (this.machines.delete(id)) this.destroyed.push(id);
  }
  async exec(id: string, command: string[]): Promise<ExecResult> {
    this.execLog.push({ id, command });
    const m = this.machines.get(id);
    if (!m || m.state !== "started") throw new Error(`machine ${id} is not started`);
    if (command[0] === "/usr/local/bin/jarvis-snapshot") {
      const [, op, run, url] = command;
      if (op === "start") {
        if (this.failSnapshot) this.#runs.set(run!, `failed ${this.failSnapshot}`);
        else {
          await this.upload(url!);
          this.#runs.set(run!, "ok 1234");
        }
        return { stdout: "started\n", stderr: "", exitCode: 0 };
      }
      if (op === "status" && this.hold) await this.hold;
      if (op === "status") return { stdout: (this.#runs.get(run!) || "running") + "\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "unknown command", exitCode: 127 };
  }
  async list(): Promise<MachineInfo[]> {
    return [...this.machines.values()].map((m) => ({ id: m.id, name: m.name, state: m.state, metadata: m.metadata, guest: m.guest }));
  }
}
