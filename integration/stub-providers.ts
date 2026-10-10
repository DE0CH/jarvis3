// Stand-ins for the Tier 0 providers, for the integration test: the server's real adapters
// (exa, scrapingbee, the http relay proxy) talk to these instead of the internet.
//
//   Exa-like     POST /search            {results, costDollars}   (checks x-api-key)
//   ScrapingBee  GET  /api/v1/?api_key&url (Spb-cost header)      (checks api_key)
//   proxy        CONNECT host:port with Basic auth = the org login; every tunnel reaches `site`
//   site         a plain HTTP "web site": "STUB-PAGE <host> <path>"
// Every call is recorded with the key it carried, so the test can prove the machine never had it.
import { createServer, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

export class StubProviders {
  readonly searchKey = "itest-exa-" + randomBytes(8).toString("hex");
  readonly fetchKey = "itest-sb-" + randomBytes(8).toString("hex");
  readonly proxyLogin = { username: "itest-org", password: "org-" + randomBytes(8).toString("hex") };
  readonly searches: { key: string; body: any }[] = [];
  readonly fetches: { key: string; url: string; render: string | null }[] = [];
  readonly tunnels: { target: string; auth: string }[] = [];
  readonly pages: string[] = [];
  #servers: Server[] = [];
  #site = 0;
  apiPort = 0;
  proxyPort = 0;

  async start(): Promise<void> {
    const site = createServer((req, res) => {
      this.pages.push(`${req.headers.host} ${req.url}`);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`STUB-PAGE ${req.headers.host} ${req.url}\n`);
    });
    this.#site = await this.#listen(site, "127.0.0.1");

    const api = createServer((req, res) => void this.#api(req, res));
    this.apiPort = await this.#listen(api, "127.0.0.1");

    const proxy = createServer((_q, s) => s.writeHead(405).end());
    proxy.on("connect", (req, sock: net.Socket, head) => {
      const auth = Buffer.from(String(req.headers["proxy-authorization"] || "").replace(/^Basic /, ""), "base64").toString();
      this.tunnels.push({ target: req.url || "", auth });
      if (!auth.startsWith(`${this.proxyLogin.username}:${this.proxyLogin.password}`)) return void sock.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      const up = net.connect(this.#site, "127.0.0.1", () => {
        sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) up.write(head);
        up.pipe(sock);
        sock.pipe(up);
      });
      up.on("error", () => sock.destroy());
      sock.on("error", () => up.destroy());
    });
    this.proxyPort = await this.#listen(proxy, "127.0.0.1");
  }

  async #api(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url || "/", "http://x");
    if (req.method === "POST" && url.pathname === "/search") {
      const key = String(req.headers["x-api-key"] || "");
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      this.searches.push({ key, body });
      if (key !== this.searchKey) return void res.writeHead(401).end('{"error":"bad key"}');
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { title: `ITEST-RESULT for ${body.query}`, url: "https://news.example/one", publishedDate: "2026-10-09T00:00:00.000Z", highlights: ["first stub highlight"] },
            { title: "Second", url: "https://news.example/two", highlights: ["second"] },
          ],
          costDollars: { total: 0.007 },
        }),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/v1/") {
      const key = url.searchParams.get("api_key") || "";
      this.fetches.push({ key, url: url.searchParams.get("url") || "", render: url.searchParams.get("render_js") });
      if (key !== this.fetchKey) return void res.writeHead(401).end('{"message":"Invalid api key"}');
      res.writeHead(200, { "content-type": "text/html", "spb-cost": url.searchParams.get("render_js") === "true" ? "5" : "1", "spb-initial-status-code": "200" });
      res.end(`<html><body><h1>ITEST-PAGE</h1><p>${url.searchParams.get("url")}</p></body></html>`);
      return;
    }
    res.writeHead(404).end();
  }

  #listen(s: Server, host: string): Promise<number> {
    this.#servers.push(s);
    return new Promise((r) => s.listen(0, host, () => r((s.address() as AddressInfo).port)));
  }

  async close(): Promise<void> {
    for (const s of this.#servers) {
      s.closeAllConnections();
      await new Promise((r) => s.close(r));
    }
  }
}
