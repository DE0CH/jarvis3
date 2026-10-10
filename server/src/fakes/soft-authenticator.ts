// A software WebAuthn authenticator for tests: a platform passkey (ES256, P-256) that answers
// navigator.credentials.create()/get() options in the JSON form browsers send to servers
// (RegistrationResponseJSON / AuthenticationResponseJSON). It reports user verification (as Face
// ID would) unless `uv` is false, and can sign for a different origin to test refusals.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// ---- minimal CBOR (only what attestation objects and COSE keys need) --------------------------------

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

export function cbor(v: Cbor): Buffer {
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const parts: Buffer[] = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export interface SoftAuthenticatorOptions {
  /** Report user verification (Face ID) — default true. */
  uv?: boolean;
  /** Sign as if the page were on this origin (default: the options' RP as https://<rpId>). */
  origin?: string;
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  readonly #priv: KeyObject;
  readonly #pub: KeyObject;
  #counter = 0;
  rpId = "";
  readonly o: SoftAuthenticatorOptions;
  constructor(o: SoftAuthenticatorOptions = {}) {
    this.o = o;
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#priv = privateKey;
    this.#pub = publicKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  #flags(at: boolean): number {
    return 0x01 | (this.o.uv === false ? 0 : 0x04) | (at ? 0x40 : 0);
  }
  #origin(rpId: string): string {
    return this.o.origin ?? `https://${rpId}`;
  }

  /** Answer navigator.credentials.create({publicKey: options}). */
  create(options: { challenge: string; rp: { id?: string } }): Record<string, unknown> {
    const rpId = options.rp.id!;
    this.rpId = rpId;
    const jwk = this.#pub.export({ format: "jwk" }) as { x: string; y: string };
    const cose = cbor(
      new Map<Cbor, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    const counter = Buffer.alloc(4);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.#flags(true)]), counter, Buffer.alloc(16), idLen, this.credentialId, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.#origin(rpId), crossOrigin: false }));
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ["internal"] },
    };
  }

  /** Answer navigator.credentials.get({publicKey: options}). */
  get(options: { challenge: string; rpId?: string }): Record<string, unknown> {
    const rpId = options.rpId ?? this.rpId;
    this.#counter++;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([this.#flags(false)]), counter]);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.#origin(rpId), crossOrigin: false }));
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientData)]), this.#priv);
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}
