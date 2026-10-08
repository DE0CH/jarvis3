// S3-compatible BlobStore (Hetzner Object Storage in production), signed with aws4fetch.
// Path-style URLs: <endpoint>/<bucket>/<key>.
import { AwsClient } from "aws4fetch";
import type { BlobStore } from "./providers.ts";
import { httpError } from "./errors.ts";

export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const encKey = (key: string): string => key.split("/").map(encodeURIComponent).join("/");

export class S3BlobStore implements BlobStore {
  readonly #aws: AwsClient;
  readonly #base: string;
  readonly #bucket: string;
  constructor(o: S3Options) {
    this.#aws = new AwsClient({ accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey, region: o.region, service: "s3" });
    this.#base = `${o.endpoint.replace(/\/$/, "")}/${o.bucket}`;
    this.#bucket = o.bucket;
  }
  #url(key: string): string {
    return `${this.#base}/${encKey(key)}`;
  }
  async #req(method: string, key: string, init: { body?: Uint8Array | string; headers?: Record<string, string> } = {}): Promise<Response> {
    const r = await this.#aws.fetch(this.#url(key), { method, body: init.body as RequestInit["body"], headers: init.headers });
    if (!r.ok && r.status !== 404) throw httpError("upstream", `S3 ${method} ${key} -> ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }
  async put(key: string, body: Uint8Array | string, contentType = "application/octet-stream"): Promise<void> {
    const r = await this.#req("PUT", key, { body, headers: { "content-type": contentType } });
    if (!r.ok) throw httpError("upstream", `S3 PUT ${key} -> ${r.status}`);
  }
  async get(key: string): Promise<Uint8Array | null> {
    const r = await this.#req("GET", key);
    return r.status === 404 ? null : new Uint8Array(await r.arrayBuffer());
  }
  async exists(key: string): Promise<boolean> {
    const r = await this.#req("HEAD", key);
    return r.ok;
  }
  async copy(fromKey: string, toKey: string): Promise<void> {
    const r = await this.#req("PUT", toKey, { headers: { "x-amz-copy-source": `/${this.#bucket}/${encKey(fromKey)}` } });
    if (!r.ok) throw httpError("upstream", `S3 copy ${fromKey} -> ${toKey}: ${r.status}`);
  }
  async delete(key: string): Promise<void> {
    await this.#req("DELETE", key);
  }
  async #presign(method: string, key: string, expires: number): Promise<string> {
    const u = new URL(this.#url(key));
    u.searchParams.set("X-Amz-Expires", String(expires));
    const signed = await this.#aws.sign(u.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  }
  presignPut(key: string, expiresSeconds: number): Promise<string> {
    return this.#presign("PUT", key, expiresSeconds);
  }
  presignGet(key: string, expiresSeconds: number): Promise<string> {
    return this.#presign("GET", key, expiresSeconds);
  }
}
