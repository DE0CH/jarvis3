// The app's web build (DE0CH/jarvis3-app, variant jarvis3), served at the instance's root so the
// page shares its origin with /api: the browser's Access cookie then authenticates the API and
// the daemon WebSocket, and the app takes the instance URL from location.origin.
//
// Like every other request (except /api/health), a page or asset is only served with a valid
// Access JWT. Membership is not checked here: the code is public, and a non-member who gets the
// page sees the API's 403 in the app.
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { accessToken, type AccessVerifier } from "./auth.ts";
import { httpError } from "./errors.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
};

export class WebApp {
  readonly #root: string;
  constructor(dir: string) {
    this.#root = resolve(dir);
    if (!existsSync(join(this.#root, "index.html"))) throw new Error(`JARVIS_WEB_DIR has no index.html: ${this.#root}`);
  }

  /** The file for a URL path: the file itself, or index.html for an app route (no extension). Null = 404. */
  resolveFile(pathname: string): string | null {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (rel.includes("\0")) return null;
    const file = normalize(join(this.#root, rel));
    if (file !== this.#root && !file.startsWith(this.#root + sep)) return null;
    if (existsSync(file) && statSync(file).isFile()) return file;
    if (existsSync(file) && statSync(file).isDirectory() && existsSync(join(file, "index.html"))) return join(file, "index.html");
    // a client-side route like /tasks/abc: the single-page app handles it
    if (!extname(rel)) return join(this.#root, "index.html");
    return null;
  }

  async serve(req: IncomingMessage, res: ServerResponse, url: URL, verifier: AccessVerifier): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw httpError("not_found", "no such route");
    const jwt = accessToken(req);
    if (!jwt) throw httpError("unauthenticated", "Cloudflare Access login required");
    try {
      await verifier.verify(jwt);
    } catch {
      throw httpError("unauthenticated", "invalid Cloudflare Access token");
    }
    const file = this.resolveFile(url.pathname);
    if (!file) throw httpError("not_found", "no such file");
    const st = statSync(file);
    const isHtml = file.endsWith(".html");
    // Expo's export names bundles by content hash under /_expo/static: those never change
    const immutable = url.pathname.startsWith("/_expo/static/");
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": st.size,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : isHtml ? "no-cache" : "public, max-age=300",
    });
    if (req.method === "HEAD") return void res.end();
    await new Promise<void>((done) => {
      const s = createReadStream(file);
      s.on("error", () => (res.destroy(), done()));
      s.on("end", done);
      s.pipe(res);
    });
  }
}
