// The org-env repo from a local bare mirror (kept fetched by the deployment, with a read-only
// deploy key the session never sees), at the pinned commit from config.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { OrgEnvSource } from "./providers.ts";
import { readTar } from "./tar.ts";

const run = promisify(execFile);

export class GitOrgEnv implements OrgEnvSource {
  readonly #mirror: string;
  readonly #commit: string;
  #cache: { tar: Uint8Array; files: Map<string, Uint8Array> } | null = null;
  constructor(mirrorPath: string, commit: string) {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("orgEnv.commit must be a full 40-hex commit id");
    this.#mirror = mirrorPath;
    this.#commit = commit;
  }
  commit(): string {
    return this.#commit;
  }
  async #load() {
    if (!this.#cache) {
      const { stdout } = await run("git", ["-C", this.#mirror, "archive", "--format=tar", this.#commit], {
        encoding: "buffer",
        maxBuffer: 512 * 1024 * 1024,
      });
      const tar = new Uint8Array(stdout as Buffer);
      this.#cache = { tar, files: readTar(tar) };
    }
    return this.#cache;
  }
  async files(): Promise<Map<string, Uint8Array>> {
    return (await this.#load()).files;
  }
  async archive(): Promise<Uint8Array> {
    return (await this.#load()).tar;
  }
}
