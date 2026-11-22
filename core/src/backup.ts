// Nightly backup (DESIGN §底1.3): SQLite snapshot + git bundles of config and agent-home → rustfs `sbot-backup`.
//
//   SBOT_HOME=/srv/sbot node src/backup.ts        (sbot-backup.timer, as sbot)
//
// Objects: sbot-backup/<YYYY-MM-DD>/{sbot.db.gz, config.bundle, agent-home.bundle, manifest.json}
// The same files also land in <home>/backup-out/<day>/ (kept 7 days) for the off-site copy: Size's Mac pulls them
// over ssh (deploy/backup-mac/pull.sh) and leaves the day it got in backup-out/pulled; Sentinel watches both.
// The rustfs key (sbot-core) can put/get/list but not delete, so a compromised core can't wipe old backups;
// pruning is done with the admin key.

import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { P, secret, log } from "./config.ts";
import { localStamp } from "./memory.ts";

const BUCKET = "sbot-backup";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();

/** Minimal SigV4 PUT (path-style, single part; backups are small). */
async function put(key: string, body: Buffer, contentType = "application/octet-stream") {
  const endpoint = secret("RUSTFS_ENDPOINT"), ak = secret("RUSTFS_ACCESS_KEY"), sk = secret("RUSTFS_SECRET_KEY");
  if (!endpoint || !ak || !sk) throw new Error("RUSTFS_* missing in secrets.env");
  const url = new URL(`/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`, endpoint);
  const region = "us-east-1", now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8), hash = sha256(body);
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": hash, "x-amz-date": amzDate, "content-type": contentType };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const canonical = ["PUT", url.pathname, "", canonicalHeaders, names.join(";"), hash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const kSign = hmac(hmac(hmac(hmac(`AWS4${sk}`, day), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", kSign).update(toSign).digest("hex");
  const { host: _h, ...send } = headers;
  const r = await fetch(url, { method: "PUT", body, headers: { ...send, authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` } });
  if (!r.ok) throw new Error(`PUT ${key} → ${r.status} ${(await r.text()).slice(0, 200)}`);
}

const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function main() {
  const day = localStamp().slice(0, 10);
  const stage = join(P.home, "backup-staging", day);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const manifest: Record<string, unknown> = { day, at: new Date().toISOString(), files: {} as Record<string, unknown> };
  try {
    // consistent snapshot while the core keeps writing (WAL)
    const snap = join(stage, "sbot.db");
    const db = new DatabaseSync(P.db, { readOnly: true });
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    db.close();
    const files: [string, Buffer][] = [["sbot.db.gz", gzipSync(readFileSync(snap), { level: 9 })]];
    for (const [name, dir] of [["config", P.config], ["agent-home", P.agentHome]] as const) {
      if (!existsSync(join(dir, ".git"))) continue;
      try { git(dir, "rev-parse", "HEAD"); } catch { continue; }   // empty repo
      const out = join(stage, `${name}.bundle`);
      git(dir, "bundle", "create", out, "--all");
      files.push([`${name}.bundle`, readFileSync(out)]);
    }
    for (const [name, body] of files) (manifest.files as any)[name] = { bytes: body.length, sha256: sha256(body) };
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2));
    // local export first, so the off-site pull still gets a copy if rustfs is down
    const out = join(P.home, "backup-out"), tmp = join(out, `.${day}.tmp`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const [name, body] of files) writeFileSync(join(tmp, name), body);
    writeFileSync(join(tmp, "manifest.json"), manifestBuf);
    rmSync(join(out, day), { recursive: true, force: true });
    renameSync(tmp, join(out, day));
    for (const d of readdirSync(out).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().slice(0, -7)) rmSync(join(out, d), { recursive: true, force: true });
    for (const [name, body] of files) await put(`${day}/${name}`, body);
    await put(`${day}/manifest.json`, manifestBuf, "application/json");
    log("backup", "done", manifest.files as any);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((e) => { log("backup", "FAILED", { err: String(e?.message ?? e) }); process.exit(1); });
