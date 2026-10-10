// S3-compatible BlobStore (Hetzner Object Storage in production), signed with aws4fetch.
// Path-style URLs: <endpoint>/<bucket>/<key>.
import { AwsClient } from "aws4fetch";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
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
  /** Through a presigned PUT, so the body is never hashed or buffered (S3 needs the length up front). */
  async putStream(key: string, body: NodeJS.ReadableStream, length: number, contentType: string): Promise<void> {
    const url = new URL(await this.presignPut(key, 3600));
    await new Promise<void>((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, { method: "PUT", headers: { "content-length": String(length), "content-type": contentType } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.length < 8 && chunks.push(c));
        res.on("end", () =>
          (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300
            ? resolve()
            : reject(httpError("upstream", `S3 PUT ${key} -> ${res.statusCode}: ${Buffer.concat(chunks).toString().slice(0, 200)}`)),
        );
        res.on("error", reject);
      });
      req.on("error", (e) => reject(httpError("upstream", `S3 PUT ${key}: ${e.message}`)));
      body.on("error", (e: Error) => {
        req.destroy(e);
        reject(e);
      });
      body.pipe(req);
    });
  }
  async #presign(method: string, key: string, expires: number, query: Record<string, string> = {}): Promise<string> {
    const u = new URL(this.#url(key));
    u.searchParams.set("X-Amz-Expires", String(expires));
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    const signed = await this.#aws.sign(u.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  }
  presignPut(key: string, expiresSeconds: number): Promise<string> {
    return this.#presign("PUT", key, expiresSeconds);
  }
  presignGet(key: string, expiresSeconds: number, o: { downloadName?: string } = {}): Promise<string> {
    return this.#presign("GET", key, expiresSeconds, o.downloadName ? { "response-content-disposition": attachmentDisposition(o.downloadName) } : {});
  }
}

/** `attachment` with an ASCII fallback name and the exact name in RFC 5987 form. */
export function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
