// Content-addressed blobs (04 「大载荷不进表」): blobs/<sha256>, referenced from `_ref` columns as `blob:<sha>`.
// Written to a temp name and renamed, so blobGc (db/cleanup.ts) never sees half a file.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function putBlob(dir: string, data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const sha = createHash("sha256").update(buf).digest("hex");
  const f = join(dir, sha);
  if (!existsSync(f)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.tmp-${sha.slice(0, 8)}-${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, f);
  }
  return `blob:${sha}`;
}

export function getBlob(dir: string, ref: string): Buffer | undefined {
  const m = /^blob:([0-9a-f]{64})$/.exec(ref);
  if (!m) return undefined;
  const f = join(dir, m[1]!);
  return existsSync(f) ? readFileSync(f) : undefined;
}
