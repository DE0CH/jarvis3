// The HTTP checks of condition wakeups (docs/API.md section 12). The server runs them itself, so
// they are deliberately narrow: HTTPS GET only, to a PUBLIC address (the connection's own DNS answer
// is checked, so a name can't rebind to the cluster), no credentials or custom headers, no
// redirects followed, 10 s, the first 256 KiB. Anything a check would need a secret for is for the
// task itself (a timed wakeup that looks, then arms the next one).
import { request } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, BlockList } from "node:net";
import type { CheckResponse, HttpChecker } from "./providers.ts";

const MAX_BODY = 256 * 1024;
const TIMEOUT_MS = 10_000;

// two lists: an IPv6 rule for ::ffff:0:0/96 would also match every IPv4 address checked as IPv4
const blocked = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96], // IPv4-mapped: refused outright (an attacker's way round the v4 list)
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked6.addSubnet(net, bits, "ipv6");

/** Whether an address is on the public internet (not loopback, private, link-local, reserved …). */
export function isPublicAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) return !blocked.check(addr, "ipv4");
  if (v === 6) return !blocked6.check(addr, "ipv6");
  return false;
}

export function checkUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 2000) throw new Error("check.url must be an https URL (≤ 2000 characters)");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("check.url must be an https URL");
  }
  if (u.protocol !== "https:") throw new Error("check.url must be https");
  if (u.username || u.password) throw new Error("check.url can't carry credentials");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new Error("check.url must be a public address");
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.svc$|\.cluster\.local$/i.test(host)) throw new Error("check.url must be a public address");
  return u;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function publicLookup(hostname: string, options: { all?: boolean }, cb: LookupCb): void {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const ok = addrs.filter((a) => isPublicAddress(a.address));
    if (!ok.length) return cb(Object.assign(new Error(`${hostname} is not a public address`), { code: "ENOTPUBLIC" }), "");
    if (options.all) cb(null, ok);
    else cb(null, ok[0]!.address, ok[0]!.family);
  });
}

export class PublicHttpChecker implements HttpChecker {
  get(raw: string): Promise<CheckResponse> {
    const u = checkUrl(raw);
    return new Promise((resolve, reject) => {
      const req = request(
        u,
        {
          method: "GET",
          lookup: publicLookup as never,
          headers: { "user-agent": "jarvis3-wakeup-check/1", accept: "*/*" },
          timeout: TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const done = () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
          res.on("data", (c: Buffer) => {
            if (size >= MAX_BODY) return;
            chunks.push(c.subarray(0, MAX_BODY - size));
            size += c.length;
            if (size >= MAX_BODY) {
              res.destroy();
              done();
            }
          });
          res.on("end", done);
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("the check timed out (10 s)")));
      req.on("error", reject);
      req.end();
    });
  }
}
