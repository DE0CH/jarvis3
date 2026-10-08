import type { BlobStore } from "../providers.ts";

/** In-memory BlobStore. Presigned URLs are fake-s3://<op>/<key>; acceptPut() plays the uploader. */
export class FakeBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array | string): Promise<void> {
    this.objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body);
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null;
  }
  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }
  async copy(fromKey: string, toKey: string): Promise<void> {
    const v = this.objects.get(fromKey);
    if (!v) throw new Error(`no object ${fromKey}`);
    this.objects.set(toKey, v);
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async presignPut(key: string, expiresSeconds: number): Promise<string> {
    return `fake-s3://put/${key}?expires=${expiresSeconds}`;
  }
  async presignGet(key: string, expiresSeconds: number): Promise<string> {
    return `fake-s3://get/${key}?expires=${expiresSeconds}`;
  }
  async acceptPut(url: string, body: string = "snapshot"): Promise<void> {
    const m = /^fake-s3:\/\/put\/([^?]+)/.exec(url);
    if (!m) throw new Error(`not a presigned PUT url: ${url}`);
    await this.put(m[1]!, body);
  }
}
