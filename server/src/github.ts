// "Suggest for everyone" on GitHub: open a pull request on the org-env repo through the REST API
// (git data API: ref -> commit -> tree, new tree on the base, commit, branch, pull request).
// The credential is a repo-scoped token or a GitHub App installation token, never anything a
// session sees.
import { createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import type { ForgeBase, OrgEnvForge, PullRequestSpec, PullRequestState } from "./providers.ts";

export type GitHubAuth = { kind: "token"; token: string } | { kind: "app"; appId: string; installationId: string; privateKeyPem: string };

export interface GitHubForgeOptions {
  /** "owner/name" */
  repo: string;
  baseBranch?: string;
  apiUrl?: string;
  auth: GitHubAuth;
  fetch?: typeof fetch;
  now?: () => number;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  mode: string;
}

export class GitHubForge implements OrgEnvForge {
  readonly #o: Required<Omit<GitHubForgeOptions, "fetch" | "now">>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #key: KeyObject | null = null;
  #installationToken: { token: string; expiresAt: number } | null = null;

  constructor(o: GitHubForgeOptions) {
    this.#o = { repo: o.repo, baseBranch: o.baseBranch ?? "main", apiUrl: o.apiUrl ?? "https://api.github.com", auth: o.auth };
    this.#fetch = o.fetch ?? fetch;
    this.#now = o.now ?? Date.now;
    if (o.auth.kind === "token" && !o.auth.token) throw new Error("GitHub token is empty");
    if (o.auth.kind === "app") this.#key = createPrivateKey(o.auth.privateKeyPem); // PKCS#1 (GitHub's format) or PKCS#8
  }

  async #authHeader(): Promise<string> {
    const a = this.#o.auth;
    if (a.kind === "token") return `Bearer ${a.token}`;
    const now = this.#now();
    if (this.#installationToken && this.#installationToken.expiresAt - 5 * 60_000 > now) return `Bearer ${this.#installationToken.token}`;
    const iat = Math.floor(now / 1000) - 60;
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(a.appId).setIssuedAt(iat).setExpirationTime(iat + 540).sign(this.#key!);
    const repoName = this.#o.repo.split("/")[1]!;
    const r = await this.#raw("POST", `/app/installations/${a.installationId}/access_tokens`, `Bearer ${jwt}`, {
      repositories: [repoName],
      permissions: { contents: "write", pull_requests: "write" },
    });
    const j = r as { token?: string; expires_at?: string };
    if (!j.token) throw new GitHubError(502, "GitHub App: no installation token in the answer");
    this.#installationToken = { token: j.token, expiresAt: j.expires_at ? Date.parse(j.expires_at) : now + 3_600_000 };
    return `Bearer ${j.token}`;
  }

  async #raw(method: string, path: string, auth: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(this.#o.apiUrl + path, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "jarvis3-server",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 200);
      try {
        msg = (JSON.parse(text) as { message?: string }).message || msg;
      } catch {
        /* not JSON */
      }
      throw new GitHubError(res.status, `GitHub ${method} ${path.split("?")[0]}: ${res.status} ${msg}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async #api<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#raw(method, path, await this.#authHeader(), body)) as T;
  }

  #repo(path: string): string {
    return `/repos/${this.#o.repo}${path}`;
  }

  async openPullRequest(spec: PullRequestSpec): Promise<{ number: number; url: string }> {
    const base = this.#o.baseBranch;
    const ref = await this.#api<{ object: { sha: string } }>("GET", this.#repo(`/git/ref/heads/${encodeURIComponent(base)}`));
    const baseCommit = ref.object.sha;
    const commit = await this.#api<{ tree: { sha: string } }>("GET", this.#repo(`/git/commits/${baseCommit}`));
    const tree = await this.#api<{ tree: TreeEntry[]; truncated?: boolean }>("GET", this.#repo(`/git/trees/${commit.tree.sha}?recursive=1`));
    if (tree.truncated) throw new GitHubError(502, "the org-env repo's tree is too large for one listing");
    const blobs = new Map(tree.tree.filter((e) => e.type === "blob").map((e) => [e.path, e]));
    const view: ForgeBase = {
      read: async (path) => {
        const e = blobs.get(path);
        if (!e) return null;
        const b = await this.#api<{ content: string; encoding: string }>("GET", this.#repo(`/git/blobs/${e.sha}`));
        return b.encoding === "base64" ? Buffer.from(b.content, "base64").toString("utf8") : b.content;
      },
      list: async (prefix) => [...blobs.keys()].filter((p) => p.startsWith(prefix)).sort(),
    };
    const edits = await spec.edit(view);
    const entries: { path: string; mode: string; type: "blob"; content?: string; sha?: null }[] = [];
    for (const [path, text] of Object.entries(edits)) {
      if (text === null) {
        if (blobs.has(path)) entries.push({ path, mode: blobs.get(path)!.mode, type: "blob", sha: null });
      } else if (!blobs.has(path) || (await view.read(path)) !== text) {
        entries.push({ path, mode: "100644", type: "blob", content: text });
      }
    }
    if (!entries.length) throw new GitHubError(409, "nothing to suggest: the org-env repo already has exactly this");
    const newTree = await this.#api<{ sha: string }>("POST", this.#repo("/git/trees"), { base_tree: commit.tree.sha, tree: entries });
    const newCommit = await this.#api<{ sha: string }>("POST", this.#repo("/git/commits"), { message: spec.message, tree: newTree.sha, parents: [baseCommit] });
    await this.#api("POST", this.#repo("/git/refs"), { ref: `refs/heads/${spec.branch}`, sha: newCommit.sha });
    const pr = await this.#api<{ number: number; html_url: string }>("POST", this.#repo("/pulls"), { title: spec.title, head: spec.branch, base, body: spec.body });
    return { number: pr.number, url: pr.html_url };
  }

  async pullRequestState(number: number): Promise<PullRequestState> {
    const pr = await this.#api<{ state: string; merged?: boolean; merged_at?: string | null }>("GET", this.#repo(`/pulls/${number}`));
    if (pr.merged || pr.merged_at) return "merged";
    return pr.state === "open" ? "open" : "closed";
  }
}
