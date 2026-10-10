// Apple Push Notification service, direct: HTTP/2 to api.push.apple.com (or the sandbox) with a
// token-based (.p8) key. No Expo push service and no library: one JWT (ES256, refreshed every
// 40 minutes; Apple refuses one older than an hour and throttles refreshes more often than every
// 20) and one HTTP/2 session per host, reused.
import { connect, constants, type ClientHttp2Session, type SecureClientSessionOptions } from "node:http2";
import { importPKCS8, SignJWT } from "jose";

export type ApnsEnvironment = "production" | "sandbox";

export const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

export interface ApnsAnswer {
  /** HTTP status: 200 = accepted. */
  status: number;
  /** Apple's reason on an error ("BadDeviceToken", "Unregistered", …), else null. */
  reason: string | null;
  /** The apns-id Apple assigned. */
  apnsId: string | null;
}

export interface ApnsOptions {
  teamId: string;
  keyId: string;
  /** The .p8 file's contents (PKCS#8 PEM). */
  keyP8: string;
  /** The app's bundle id: the apns-topic. */
  bundleId: string;
  /** Tests: other hosts and TLS options (a local HTTP/2 server). */
  hosts?: Record<ApnsEnvironment, string>;
  connectOptions?: SecureClientSessionOptions;
  /** Milliseconds; default Date.now. */
  now?: () => number;
  timeoutMs?: number;
}

const TOKEN_LIFETIME_MS = 40 * 60_000;

export class ApnsClient {
  readonly #o: ApnsOptions;
  readonly #sessions = new Map<string, ClientHttp2Session>();
  #token: { jwt: string; at: number } | null = null;
  #key: ReturnType<typeof importPKCS8> | null = null;

  constructor(o: ApnsOptions) {
    this.#o = o;
  }

  async #jwt(force = false): Promise<string> {
    const now = (this.#o.now ?? Date.now)();
    if (!force && this.#token && now - this.#token.at < TOKEN_LIFETIME_MS) return this.#token.jwt;
    this.#key ??= importPKCS8(this.#o.keyP8, "ES256");
    const jwt = await new SignJWT({ iss: this.#o.teamId, iat: Math.floor(now / 1000) })
      .setProtectedHeader({ alg: "ES256", kid: this.#o.keyId })
      .sign(await this.#key);
    this.#token = { jwt, at: now };
    return jwt;
  }

  #session(origin: string): ClientHttp2Session {
    const s = this.#sessions.get(origin);
    if (s && !s.closed && !s.destroyed) return s;
    const fresh = connect(origin, this.#o.connectOptions ?? {});
    fresh.on("error", () => this.#sessions.delete(origin));
    fresh.on("goaway", () => this.#sessions.delete(origin));
    fresh.on("close", () => this.#sessions.delete(origin));
    // an idle connection must not keep the process alive
    fresh.unref();
    this.#sessions.set(origin, fresh);
    return fresh;
  }

  /**
   * One push. `payload` is the JSON body (aps + custom keys). Retries once with a fresh JWT when
   * Apple says the token expired.
   */
  async send(token: string, environment: ApnsEnvironment, payload: unknown, headers: Record<string, string> = {}): Promise<ApnsAnswer> {
    const first = await this.#post(token, environment, payload, headers, false);
    if (first.status === 403 && (first.reason === "ExpiredProviderToken" || first.reason === "InvalidProviderToken") && this.#token) {
      return this.#post(token, environment, payload, headers, true);
    }
    return first;
  }

  async #post(token: string, environment: ApnsEnvironment, payload: unknown, headers: Record<string, string>, freshJwt: boolean): Promise<ApnsAnswer> {
    const origin = (this.#o.hosts ?? APNS_HOSTS)[environment];
    const jwt = await this.#jwt(freshJwt);
    const body = Buffer.from(JSON.stringify(payload));
    const session = this.#session(origin);
    return new Promise<ApnsAnswer>((resolve, reject) => {
      const req = session.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": this.#o.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "content-type": "application/json",
        "content-length": String(body.length),
        ...headers,
      });
      req.setTimeout(this.#o.timeoutMs ?? 15_000, () => req.close(constants.NGHTTP2_CANCEL));
      let status = 0;
      let apnsId: string | null = null;
      const chunks: Buffer[] = [];
      req.on("response", (h) => {
        status = Number(h[constants.HTTP2_HEADER_STATUS]);
        const id = h["apns-id"];
        apnsId = typeof id === "string" ? id : null;
      });
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (!status) return reject(new Error("APNs: no answer"));
        let reason: string | null = null;
        if (status !== 200) {
          try {
            reason = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { reason?: string }).reason ?? null;
          } catch {
            reason = null;
          }
        }
        resolve({ status, reason, apnsId });
      });
      req.on("error", reject);
      req.on("close", () => {
        if (!status) reject(new Error("APNs: request closed without an answer"));
      });
      req.end(body);
    });
  }

  close(): void {
    for (const s of this.#sessions.values()) s.close();
    this.#sessions.clear();
  }
}
