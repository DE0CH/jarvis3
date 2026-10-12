// Google Workspace directory (Admin SDK Directory API), read-only: a service account with
// domain-wide delegation impersonates `subject` with only the user-read and group-member-read
// scopes. Lists the domain's users and the members of each mapped group.
import { SignJWT, importPKCS8 } from "jose";
import type { DirectoryProvider, DirectoryUser } from "./providers.ts";
import { httpError } from "./errors.ts";

const SCOPES = [
  "https://www.googleapis.com/auth/admin.directory.user.readonly",
  "https://www.googleapis.com/auth/admin.directory.group.member.readonly",
];
const API = "https://admin.googleapis.com/admin/directory/v1";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface GoogleDirectoryOptions {
  serviceAccountJson: string;
  domain: string;
  subject: string;
  groups: string[]; // the mapped group emails
  fetch?: typeof fetch;
}

export class GoogleDirectory implements DirectoryProvider {
  readonly #o: GoogleDirectoryOptions;
  readonly #sa: ServiceAccount;
  readonly #fetch: typeof fetch;
  #token: { value: string; exp: number } | null = null;
  constructor(o: GoogleDirectoryOptions) {
    this.#o = o;
    this.#sa = JSON.parse(o.serviceAccountJson) as ServiceAccount;
    this.#fetch = o.fetch || globalThis.fetch;
  }

  async #accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.#token && this.#token.exp - 60 > now) return this.#token.value;
    const aud = this.#sa.token_uri || "https://oauth2.googleapis.com/token";
    const key = await importPKCS8(this.#sa.private_key, "RS256");
    const assertion = await new SignJWT({ scope: SCOPES.join(" ") })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.#sa.client_email)
      .setSubject(this.#o.subject)
      .setAudience(aud)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const r = await this.#fetch(aud, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!r.ok || !j.access_token) throw httpError("upstream", `Google token: ${r.status} ${j.error || ""}`);
    this.#token = { value: j.access_token, exp: now + (j.expires_in || 3600) };
    return j.access_token;
  }

  async #pages<T>(url: string, field: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken = "";
    for (let i = 0; i < 200; i++) {
      const u = new URL(url);
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const r = await this.#fetch(u, { headers: { Authorization: `Bearer ${await this.#accessToken()}` }, signal: AbortSignal.timeout(30_000) });
      const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw httpError("upstream", `Google directory ${u.pathname}: ${r.status}`);
      out.push(...((j[field] as T[] | undefined) || []));
      pageToken = (j.nextPageToken as string) || "";
      if (!pageToken) break;
    }
    return out;
  }

  async listUsers(): Promise<DirectoryUser[]> {
    const users = await this.#pages<{ primaryEmail: string; name?: { fullName?: string }; suspended?: boolean; archived?: boolean }>(
      `${API}/users?domain=${encodeURIComponent(this.#o.domain)}&maxResults=500&projection=basic`,
      "users",
    );
    const groupsOf = new Map<string, string[]>();
    for (const g of this.#o.groups) {
      const members = await this.#pages<{ email?: string; type?: string }>(
        `${API}/groups/${encodeURIComponent(g)}/members?includeDerivedMembership=true&maxResults=200`,
        "members",
      );
      for (const m of members) {
        if (!m.email || (m.type && m.type !== "USER")) continue;
        const e = m.email.toLowerCase();
        groupsOf.set(e, [...(groupsOf.get(e) || []), g.toLowerCase()]);
      }
    }
    return users.map((u) => {
      const email = u.primaryEmail.toLowerCase();
      return { email, name: u.name?.fullName || "", suspended: !!(u.suspended || u.archived), groups: groupsOf.get(email) || [] };
    });
  }
}

/** A directory that is the config's own member list (one-person instances, bootstrap). */
export class StaticDirectory implements DirectoryProvider {
  readonly #users: DirectoryUser[];
  constructor(users: { email: string; name?: string; role: string; suspended?: boolean }[]) {
    this.#users = users.map((u) => ({ email: u.email.toLowerCase(), name: u.name || "", suspended: !!u.suspended, groups: [], role: u.role }));
  }
  async listUsers(): Promise<DirectoryUser[]> {
    return this.#users.map((u) => ({ ...u }));
  }
}

/**
 * A Workspace directory plus members outside it (`directory.users` with kind google), each with its role.
 * An empty answer from the Workspace stays empty, so the sync's "refusing to offboard everyone" guard
 * still fires when Google returns nobody.
 */
export class WithExternalMembers implements DirectoryProvider {
  readonly #inner: DirectoryProvider;
  readonly #external: StaticDirectory;
  constructor(inner: DirectoryProvider, users: { email: string; name?: string; role: string; suspended?: boolean }[]) {
    this.#inner = inner;
    this.#external = new StaticDirectory(users);
  }
  async listUsers(): Promise<DirectoryUser[]> {
    const users = await this.#inner.listUsers();
    if (!users.length) return users;
    const seen = new Set(users.map((u) => u.email.toLowerCase()));
    return [...users, ...(await this.#external.listUsers()).filter((u) => !seen.has(u.email))];
  }
}
