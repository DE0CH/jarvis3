// A fake GitHub REST API on a local HTTP port: one repo with refs, commits, flat trees, blobs and
// pull requests, enough for GitHubForge (server/src/github.ts). It checks credentials the way
// GitHub does for our two modes: a fixed token, or an App JWT (verified against the App's public
// key) exchanged for an installation token narrowed to the repo.
import { createHash, randomBytes, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { jwtVerify } from "jose";

interface Commit {
  tree: Map<string, string>; // path -> blob sha
  parents: string[];
  message: string;
}
export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed";
  merged: boolean;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");

export class FakeGitHub {
  readonly repo: string;
  readonly blobs = new Map<string, string>();
  readonly commits = new Map<string, Commit>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly refs = new Map<string, string>(); // branch -> commit sha
  readonly pulls: FakePull[] = [];
  readonly requests: string[] = [];
  /** Accepted bearer tokens: a fixed token, plus installation tokens it minted. */
  readonly tokens = new Set<string>();
  /** The installation-token requests the App made (to check what it asked for). */
  readonly installationRequests: { installationId: string; body: unknown }[] = [];
  app: { appId: string; installationId: string; publicKey: KeyObject } | null = null;
  fail: string | null = null;
  #server: Server | null = null;
  url = "";

  constructor(repo = "example-org/example-env", files: Record<string, string> = {}, token?: string) {
    this.repo = repo;
    if (token) this.tokens.add(token);
    const tree = new Map(Object.entries(files).map(([p, t]) => [p, this.#blob(t)]));
    this.refs.set("main", this.#commit({ tree, parents: [], message: "initial" }));
  }

  #blob(text: string): string {
    const s = sha(`blob ${text}`);
    this.blobs.set(s, text);
    return s;
  }
  #tree(t: Map<string, string>): string {
    const s = sha(`tree ${JSON.stringify([...t.entries()].sort())}`);
    this.trees.set(s, new Map(t));
    return s;
  }
  #commit(c: Commit): string {
    const s = sha(`commit ${randomBytes(8).toString("hex")} ${c.message}`);
    this.#tree(c.tree);
    this.commits.set(s, c);
    return s;
  }
  #treeShaOf(c: Commit): string {
    return sha(`tree ${JSON.stringify([...c.tree.entries()].sort())}`);
  }

  /** The files on a branch, path -> text. */
  filesAt(branch: string): Record<string, string> {
    const c = this.commits.get(this.refs.get(branch)!)!;
    return Object.fromEntries([...c.tree.entries()].map(([p, b]) => [p, this.blobs.get(b)!]));
  }
  merge(number: number): void {
    const pr = this.pulls.find((p) => p.number === number)!;
    this.refs.set(pr.base, this.refs.get(pr.head)!);
    pr.state = "closed";
    pr.merged = true;
  }
  close(number: number): void {
    this.pulls.find((p) => p.number === number)!.state = "closed";
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server!.listen(0, "127.0.0.1", () => r()));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this.url;
  }
  async stop(): Promise<void> {
    if (this.#server) await new Promise<void>((r) => this.#server!.close(() => r()));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      const url = new URL(req.url || "/", "http://x");
      const path = url.pathname;
      this.requests.push(`${req.method} ${path}`);
      if (this.fail) return send(500, { message: this.fail });
      const auth = String(req.headers.authorization || "");
      if (!auth.startsWith("Bearer ")) return send(401, { message: "Requires authentication" });
      const bearer = auth.slice(7);

      const inst = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (inst && req.method === "POST") {
        if (!this.app) return send(404, { message: "Not Found" });
        try {
          const { payload } = await jwtVerify(bearer, this.app.publicKey, { issuer: this.app.appId, algorithms: ["RS256"] });
          if (!payload.exp || payload.exp - (payload.iat ?? 0) > 600) return send(401, { message: "JWT lifetime too long" });
        } catch {
          return send(401, { message: "A JSON web token could not be decoded" });
        }
        if (inst[1] !== this.app.installationId) return send(404, { message: "Not Found" });
        this.installationRequests.push({ installationId: inst[1]!, body });
        const token = `ghs_${randomBytes(12).toString("hex")}`;
        this.tokens.add(token);
        return send(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (!this.tokens.has(bearer)) return send(401, { message: "Bad credentials" });

      const prefix = `/repos/${this.repo}`;
      if (!path.startsWith(prefix + "/")) return send(404, { message: "Not Found" });
      const p = path.slice(prefix.length);
      let m: RegExpExecArray | null;
      if (req.method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(p))) {
        const s = this.refs.get(decodeURIComponent(m[1]!));
        return s ? send(200, { ref: `refs/heads/${m[1]}`, object: { sha: s, type: "commit" } }) : send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && (m = /^\/git\/commits\/([0-9a-f]+)$/.exec(p))) {
        const c = this.commits.get(m[1]!);
        return c ? send(200, { sha: m[1], tree: { sha: this.#treeShaOf(c) }, parents: c.parents.map((s) => ({ sha: s })), message: c.message }) : send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && (m = /^\/git\/trees\/([0-9a-f]+)$/.exec(p))) {
        const t = this.trees.get(m[1]!);
        if (!t) return send(404, { message: "Not Found" });
        return send(200, { sha: m[1], truncated: false, tree: [...t.entries()].map(([path, s]) => ({ path, mode: "100644", type: "blob", sha: s })) });
      }
      if (req.method === "GET" && (m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(p))) {
        const b = this.blobs.get(m[1]!);
        return b === undefined ? send(404, { message: "Not Found" }) : send(200, { sha: m[1], encoding: "base64", content: Buffer.from(b).toString("base64") });
      }
      if (req.method === "POST" && p === "/git/trees") {
        const base = this.trees.get(String(body.base_tree));
        if (!base) return send(422, { message: "base_tree not found" });
        const t = new Map(base);
        for (const e of body.tree as { path: string; content?: string; sha?: string | null }[]) {
          if (e.sha === null) t.delete(e.path);
          else if (typeof e.content === "string") t.set(e.path, this.#blob(e.content));
        }
        return send(201, { sha: this.#tree(t) });
      }
      if (req.method === "POST" && p === "/git/commits") {
        const t = this.trees.get(String(body.tree));
        if (!t) return send(422, { message: "tree not found" });
        const s = this.#commit({ tree: new Map(t), parents: body.parents as string[], message: String(body.message) });
        return send(201, { sha: s });
      }
      if (req.method === "POST" && p === "/git/refs") {
        const name = String(body.ref).replace(/^refs\/heads\//, "");
        if (this.refs.has(name)) return send(422, { message: "Reference already exists" });
        this.refs.set(name, String(body.sha));
        return send(201, { ref: body.ref, object: { sha: body.sha } });
      }
      if (req.method === "POST" && p === "/pulls") {
        if (!this.refs.has(String(body.head))) return send(422, { message: "head not found" });
        const pr: FakePull = { number: this.pulls.length + 1, title: String(body.title), body: String(body.body), head: String(body.head), base: String(body.base), state: "open", merged: false };
        this.pulls.push(pr);
        return send(201, { number: pr.number, html_url: `https://github.example/${this.repo}/pull/${pr.number}`, state: "open" });
      }
      if (req.method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(p))) {
        const pr = this.pulls.find((x) => x.number === Number(m![1]));
        return pr ? send(200, { number: pr.number, state: pr.state, merged: pr.merged, merged_at: pr.merged ? new Date().toISOString() : null }) : send(404, { message: "Not Found" });
      }
      return send(404, { message: "Not Found" });
    } catch (e) {
      send(500, { message: (e as Error).message });
    }
  }
}
