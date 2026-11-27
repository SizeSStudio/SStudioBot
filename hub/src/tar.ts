// Minimal ustar for the backup (regular files only). Written here instead of shelling out to tar so the hub packs the
// same bytes on Linux, macOS and Windows, and so `age -d backup.tar.age | tar x` still works by hand on any machine.
const BLOCK = 512;

export interface TarEntry { name: string; data: Uint8Array; mode?: number; mtime?: number }

function octal(n: number, width: number): string { return n.toString(8).padStart(width - 1, "0") + "\0"; }

function header(e: TarEntry): Buffer {
  const h = Buffer.alloc(BLOCK);
  let name = e.name, prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${e.name}`);
    prefix = name.slice(0, cut); name = name.slice(cut + 1);
  }
  h.write(name, 0, 100, "utf8");
  h.write(octal(e.mode ?? 0o600, 8), 100, "ascii");
  h.write(octal(0, 8), 108, "ascii");
  h.write(octal(0, 8), 116, "ascii");
  h.write(octal(e.data.length, 12), 124, "ascii");
  h.write(octal(Math.floor((e.mtime ?? Date.now()) / 1000), 12), 136, "ascii");
  h.write("        ", 148, "ascii");
  h.write("0", 156, "ascii");
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, 155, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

export function pack(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(header(e), Buffer.from(e.data));
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** A path that stays inside the directory it is unpacked into. */
export function safeName(name: string): boolean {
  return !!name && !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && !name.split(/[\\/]/).some((p) => p === ".." || p === "");
}

export function unpack(buf: Uint8Array): TarEntry[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.length), out: TarEntry[] = [];
  let off = 0;
  while (off + BLOCK <= b.length) {
    const h = b.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) break;
    const str = (s: number, n: number) => h.subarray(s, s + n).toString("utf8").replace(/\0.*$/s, "");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    if (parseInt(str(148, 8).trim(), 8) !== sum) throw new Error("tar header checksum mismatch");
    const size = parseInt(str(124, 12).trim() || "0", 8), type = str(156, 1);
    const prefix = str(345, 155), name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const start = off + BLOCK;
    if (start + size > b.length) throw new Error("tar truncated");
    if (type === "0" || type === "") {
      if (!safeName(name)) throw new Error(`unsafe path in tar: ${name}`);
      out.push({ name, data: b.subarray(start, start + size), mode: parseInt(str(100, 8).trim() || "600", 8), mtime: parseInt(str(136, 12).trim() || "0", 8) * 1000 });
    }
    off = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
