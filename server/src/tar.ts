// Minimal ustar writer/reader: regular files only (what an org-env tree needs). Paths up to
// 255 bytes (name + prefix split).

function header(path: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  let name = path;
  let prefix = "";
  if (enc.encode(name).length > 100) {
    const cut = path.lastIndexOf("/", 155);
    if (cut <= 0) throw new Error(`tar: path too long: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
    if (enc.encode(name).length > 100) throw new Error(`tar: path too long: ${path}`);
  }
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(0, 12), 136, 12);
  put("        ", 148, 8); // checksum placeholder
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

export function writeTar(files: Map<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [path, data] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    parts.push(header(path, data.length), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function readTar(buf: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  const str = (off: number, len: number) => {
    const s = buf.subarray(off, off + len);
    const z = s.indexOf(0);
    return dec.decode(z === -1 ? s : s.subarray(0, z));
  };
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (off + 512 <= buf.length) {
    if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
    const size = parseInt(str(off + 124, 12).trim() || "0", 8);
    const type = str(off + 156, 1) || "0";
    const prefix = str(off + 345, 155);
    let name = (prefix ? prefix + "/" : "") + str(off, 100);
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = dec.decode(body).replace(/\0+$/, ""); continue; }
    if (type === "x") {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(body));
      paxPath = m ? m[1]! : null;
      continue;
    }
    if (type === "g") continue; // git archive's global header (commit id)
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === "0" || type === "\0" || type === "7") out.set(name.replace(/^\.\//, ""), new Uint8Array(body));
  }
  return out;
}
