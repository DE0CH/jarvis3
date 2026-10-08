import type { OrgEnvSource } from "../providers.ts";
import { writeTar } from "../tar.ts";

/** An org-env tree given as path -> text. */
export class FakeOrgEnv implements OrgEnvSource {
  readonly #commit: string;
  readonly #files: Map<string, Uint8Array>;
  constructor(files: Record<string, string>, commit = "0".repeat(40)) {
    this.#commit = commit;
    this.#files = new Map(Object.entries(files).map(([p, t]) => [p, new TextEncoder().encode(t)]));
  }
  commit(): string {
    return this.#commit;
  }
  async files(): Promise<Map<string, Uint8Array>> {
    return this.#files;
  }
  async archive(): Promise<Uint8Array> {
    return writeTar(this.#files);
  }
}
