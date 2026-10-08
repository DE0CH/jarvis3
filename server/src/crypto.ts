// Key material at rest, ids, and bearer-token hashing.
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const randomId = (bytes = 8): string => randomBytes(bytes).toString("hex");
export const mintToken = (): string => randomBytes(32).toString("hex");
export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Constant-time check of a presented token against a stored sha256 hex hash. */
export function verifyToken(presented: string | undefined | null, storedHash: string | undefined | null): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(sha256hex(presented), "utf8");
  const b = Buffer.from(storedHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * AES-256-GCM with the server key from config (JARVIS_DB_KEY, 32 bytes base64).
 * Output: "v1:" + base64(iv(12) | tag(16) | ciphertext). The associated data binds a value to
 * its row (e.g. "openrouter:<userId>") so a ciphertext copied into another row won't decrypt.
 */
export class Sealer {
  readonly #key: Buffer;
  constructor(keyB64: string) {
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) throw new Error("server key must be 32 bytes, base64-encoded");
    this.#key = key;
  }
  seal(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return "v1:" + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
  }
  open(sealed: string, aad: string): string {
    if (!sealed.startsWith("v1:")) throw new Error("unknown sealed format");
    const raw = Buffer.from(sealed.slice(3), "base64");
    const d = createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  }
}
