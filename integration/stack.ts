// The integration stack, without a browser: a real instance server (createJarvis) wired to
//   - the local-Docker MachineProvider, booting the real session image,
//   - MinIO for the bucket (snapshots, archives),
//   - the fake OpenRouter (key minting + scripted chat completions),
//   - a bare git repo as the org-env mirror,
//   - a fake Cloudflare Access: test-signed JWTs for people, and the session gate's service-token
//     headers turned into a gate JWT the way Access would.
// Everything that leaves the process runs in Docker on the default bridge; the containers reach
// the server, MinIO and the fake OpenRouter at the bridge gateway's address.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { IncomingMessage } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type JWK } from "jose";
import { AwsClient } from "aws4fetch";
import { createJarvis, type Jarvis } from "../server/src/app.ts";
import { validateConfig, type Config } from "../server/src/config.ts";
import { openDb } from "../server/src/db.ts";
import { DockerMachines } from "../server/src/docker.ts";
import { S3BlobStore } from "../server/src/s3.ts";
import { OpenRouterKeys } from "../server/src/openrouter.ts";
import { StaticDirectory } from "../server/src/directory-google.ts";
import { GitOrgEnv } from "../server/src/orgenv-git.ts";
import { FakeDeviceTokens } from "../server/src/fakes/devices.ts";
import { FakeOpenRouter } from "./fake-openrouter.ts";

export const INSTANCE = "itest";
export const TEAM = "itest.cloudflareaccess.example.org";
export const AUD = "itest-audience";
export const GATE_ID = "itest-session-gate.access";
export const MODEL = "anthropic/claude-itest";

export const ORG_FILES: Record<string, string> = {
  "AGENTS.md": "ORG-MARK: you work for Example Org.",
  "skills/report/SKILL.md": "---\nname: report\ndescription: Write the weekly report\n---\nOrg report skill.",
  "skills/search/SKILL.md": "---\nname: search\ndescription: Search the org wiki\n---\nOrg search skill.",
  "roles/staff/AGENTS.md": "ROLE-MARK: staff do customer work.",
  "roles/staff/skills/report/SKILL.md": "---\nname: report\ndescription: Staff report\n---\nStaff report skill (clashes with org).",
  "roles/admin/AGENTS.md": "ROLE-MARK: admins run the instance.",
  "policy/AGENTS.md": "POLICY-MARK: never send money.",
  "policy/deny.json": JSON.stringify([{ permission: "bash", pattern: "rm -rf /*" }]),
  "policy/guards.json": JSON.stringify([{ id: "own-mail", tool: "bash", match: "gmail-send", approval: "self", label: "Send an email from your own mailbox" }]),
  "scripts/hello.sh": "#!/bin/sh\necho hello from the org\n",
};

const sh = (cmd: string, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...o }).trim();

export function dockerGateway(): string {
  const out = sh("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"]);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(out)) throw new Error(`no bridge gateway: ${out}`);
  return out;
}

export function makeOrgRepo(dir: string): { mirror: string; commit: string } {
  const work = join(dir, "org-work");
  for (const [p, text] of Object.entries(ORG_FILES)) {
    mkdirSync(dirname(join(work, p)), { recursive: true });
    writeFileSync(join(work, p), text);
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.org", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.org" };
  sh("git", ["init", "-q", "-b", "main"], { cwd: work });
  sh("git", ["add", "-A"], { cwd: work });
  sh("git", ["commit", "-q", "-m", "org env"], { cwd: work, env });
  const mirror = join(dir, "org.git");
  sh("git", ["clone", "-q", "--bare", work, mirror]);
  return { mirror, commit: sh("git", ["-C", mirror, "rev-parse", "HEAD"]) };
}

async function startMinio(gw: string): Promise<{ endpoint: string; container: string; key: string; secret: string }> {
  const key = "itest" + randomBytes(4).toString("hex");
  const secret = randomBytes(16).toString("hex");
  const container = sh("docker", ["run", "-d", "--rm", "--label", `jarvis3.itest=${INSTANCE}`, "-p", "0:9000", "-e", `MINIO_ROOT_USER=${key}`, "-e", `MINIO_ROOT_PASSWORD=${secret}`, process.env.MINIO_IMAGE || "cgr.dev/chainguard/minio:latest", "server", "/tmp/minio-data"]);
  const port = sh("docker", ["port", container, "9000/tcp"]).split("\n")[0]!.split(":").at(-1)!;
  const endpoint = `http://${gw}:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${endpoint}/minio/health/ready`)).ok) return { endpoint, container, key, secret };
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("MinIO did not come up");
}

export interface Stack {
  jarvis: Jarvis;
  base: string;
  wsBase: string;
  openrouter: FakeOpenRouter;
  s3: AwsClient;
  bucketUrl: string;
  machines: DockerMachines;
  jwt(email: string): Promise<string>;
  close(): Promise<void>;
}

export interface StackOptions {
  image: string;
  log?: (m: string) => void;
  /** Extra config (e.g. `owner`, `actions`). */
  config?: Partial<Config>;
  /** The actions' credentials (what loadActionSecrets reads from the env in production). */
  actionSecrets?: Record<string, Record<string, string>>;
}

export async function startStack(o: StackOptions): Promise<Stack> {
  const log = o.log ?? ((m: string) => console.log(m));
  const dir = mkdtempSync(join(tmpdir(), "jarvis3-itest-"));
  const gw = dockerGateway();

  const openrouter = new FakeOpenRouter();
  const orPort = await openrouter.listen("0.0.0.0");

  const minio = await startMinio(gw);
  const s3 = new AwsClient({ accessKeyId: minio.key, secretAccessKey: minio.secret, region: "us-east-1", service: "s3" });
  const bucket = "itest";
  const bucketUrl = `${minio.endpoint}/${bucket}`;
  const mk = await s3.fetch(bucketUrl, { method: "PUT" });
  if (!mk.ok) throw new Error(`bucket create: ${mk.status} ${await mk.text()}`);

  const org = makeOrgRepo(dir);

  // fake Access: one RS256 key, JWTs for people, a pre-signed gate JWT for the sessions
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "itest", alg: "RS256" };
  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "itest" }).setIssuer(`https://${TEAM}`).setAudience(AUD).setIssuedAt().setExpirationTime("2h").sign(privateKey);
  const gateSecret = randomBytes(16).toString("hex");
  const gateJwt = await sign({ common_name: GATE_ID, type: "app", sub: "" });

  const envOverrides: Record<string, string> = { OPENROUTER_BASE_URL: `http://${gw}:${orPort}/api/v1` };
  const machines = new DockerMachines({ instance: INSTANCE, envOverrides });
  const config: Config = validateConfig({
    instanceName: INSTANCE,
    publicUrl: "https://jarvis.example.org",
    access: { teamDomain: TEAM, audience: AUD, sessionGateClientId: GATE_ID },
    directory: {
      kind: "static",
      users: [
        { email: "admin@example.org", name: "Admin", role: "admin" },
        { email: "alice@example.org", name: "Alice", role: "staff" },
        { email: "bob@example.org", name: "Bob", role: "staff" },
      ],
    },
    bootstrapAdmins: [],
    roles: {
      admin: { openrouterMonthlyUsd: 5, machineHoursPerMonth: null, admin: true },
      staff: { openrouterMonthlyUsd: 1, machineHoursPerMonth: 10 },
    },
    models: [{ id: MODEL, label: "Claude (integration)" }],
    defaultModel: MODEL,
    machines: { kind: "docker", image: o.image, guest: { cpu_kind: "shared", cpus: 2, memory_mb: 2048 } },
    storage: { kind: "s3", endpoint: minio.endpoint, region: "us-east-1", bucket },
    orgEnv: { mirrorPath: org.mirror, commit: org.commit },
    daemonPath: "/ws",
    idleMinutes: 0,
    budget: { monthlyUsd: null },
    devices: { appScheme: "jarvis3", cloudflareAccountId: "itest" },
    presignSeconds: 3600,
    ...o.config,
  });

  const jarvis = createJarvis({
    config,
    db: openDb(join(dir, "jarvis.db")),
    dbKey: randomBytes(32).toString("base64"),
    sessionGateClientSecret: gateSecret,
    accessJwks: { keys: [jwk] },
    snapshotPollMs: 1000,
    snapshotTimeoutMs: 5 * 60_000,
    log: (m, e) => log(`[jarvis] ${m} ${e ? JSON.stringify(e) : ""}`),
    actionSecrets: o.actionSecrets ?? {},
    providers: {
      machines,
      blobs: new S3BlobStore({ endpoint: minio.endpoint, region: "us-east-1", bucket, accessKeyId: minio.key, secretAccessKey: minio.secret }),
      keys: new OpenRouterKeys(openrouter.managementKey, { base: `http://127.0.0.1:${orPort}/api/v1/keys` }),
      directory: new StaticDirectory(config.directory.kind === "static" ? config.directory.users : []),
      deviceTokens: new FakeDeviceTokens(),
      orgEnv: new GitOrgEnv(org.mirror, org.commit),
    },
  });

  // Access in front: a request with the gate's service-token headers gets the gate JWT (as
  // Access would mint it); wrong secret = no JWT (the server answers 401). People bring their own.
  const access = (req: IncomingMessage) => {
    const id = req.headers["cf-access-client-id"];
    if (id === undefined) return;
    delete req.headers["cf-access-jwt-assertion"];
    if (id === GATE_ID && req.headers["cf-access-client-secret"] === gateSecret) req.headers["cf-access-jwt-assertion"] = gateJwt;
  };
  jarvis.server.prependListener("request", access);
  jarvis.server.prependListener("upgrade", access);

  await new Promise<void>((r) => jarvis.server.listen(0, "0.0.0.0", () => r()));
  const port = (jarvis.server.address() as AddressInfo).port;
  envOverrides.JARVIS_URL = `http://${gw}:${port}`;
  const sync = await jarvis.syncDirectory();
  if (!sync.ok) throw new Error(`directory sync: ${sync.error}`);
  log(`[stack] server :${port}, MinIO ${minio.endpoint}, fake OpenRouter :${orPort}, gateway ${gw}, org-env ${org.commit.slice(0, 8)}`);

  return {
    jarvis,
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    openrouter,
    s3,
    bucketUrl,
    machines,
    jwt: (email) => sign({ email, sub: `sub-${email}`, type: "app" }),
    async close() {
      await jarvis.settle().catch(() => {});
      for (const m of await machines.list().catch(() => [])) await machines.destroy(m.id).catch(() => {});
      await jarvis.close().catch(() => {});
      await openrouter.close().catch(() => {});
      try {
        sh("docker", ["rm", "-f", minio.container]);
      } catch {
        /* gone */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
