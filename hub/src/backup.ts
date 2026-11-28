// Nightly backup and restore (§底1.3 R4, docs/tech/03 「backup」).
//
// One file a night: a `VACUUM INTO` snapshot, git bundles of config/ and agent-home/, keys/ and secrets.env, plus a
// manifest with each part's sha256 → tar → age, encrypted to backup.yaml's `recipient` → backup-staging/. The hub only
// has the public key, so the hub itself can't read its backups; `sbot restore <file> --identity <key file>` runs where
// I keep the private key.
//
// Secrets: keys/ and secrets.env go into the tar as bytes and are never logged, printed or put into an error. Logs carry
// file names, sizes and counts only. The manifest (sha256 per part) is inside the encrypted tar, not next to it.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Decrypter, Encrypter } from "age-encryption";
import type { Db } from "./db/db.ts";
import type { Home } from "./home.ts";
import { TZ } from "./home.ts";
import { git, ensureRepo } from "./memory/repo.ts";
import { log } from "./log.ts";
import * as notify from "./notify.ts";
import { pack, unpack, type TarEntry } from "./tar.ts";

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const day = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
export const BACKUP_RE = /^sbot-(\d{4}-\d{2}-\d{2})\.tar\.age$/;
export const backupName = (d: string) => `sbot-${d}.tar.age`;

export interface Manifest {
  format: 1;
  day: string;
  at: string;
  db_version: number;
  files: Record<string, { bytes: number; sha256: string }>;
}

export class BackupError extends Error {}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

export function integrityCheck(file: string): string {
  const s = new DatabaseSync(file, { readOnly: true });
  try { return String((s.prepare("PRAGMA integrity_check").get() as { integrity_check?: string })?.integrity_check ?? "?"); }
  finally { s.close(); }
}

async function bundle(repo: string, out: string): Promise<boolean> {
  if (!existsSync(join(repo, ".git"))) return false;
  try { await git(repo, "rev-parse", "--verify", "-q", "HEAD"); } catch { return false; }   // empty repo
  await git(repo, "bundle", "create", "-q", out, "--all");
  return true;
}

/** The parts of one backup, before encryption. */
export async function collect(db: Db, h: Home, now = Date.now()): Promise<{ entries: TarEntry[]; manifest: Manifest }> {
  const tmp = join(h.staging, `.collect-${process.pid}-${now}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  try {
    const entries: TarEntry[] = [];
    // consistent snapshot while the hub keeps writing (WAL)
    const snap = join(tmp, "sbot.db");
    db.raw.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    const ok = integrityCheck(snap);
    if (ok !== "ok") throw new BackupError(`snapshot integrity_check: ${ok.slice(0, 200)}`);
    entries.push({ name: "sbot.db", data: readFileSync(snap) });
    for (const [name, dir] of [["config", h.config], ["agent-home", h.agentHome]] as const) {
      const out = join(tmp, `${name}.bundle`);
      if (await bundle(dir, out)) entries.push({ name: `${name}.bundle`, data: readFileSync(out) });
    }
    for (const f of walk(h.keys)) entries.push({ name: `keys/${relative(h.keys, f).split(sep).join("/")}`, data: readFileSync(f) });
    if (existsSync(h.secrets)) entries.push({ name: "secrets.env", data: readFileSync(h.secrets) });
    const manifest: Manifest = { format: 1, day: day(now), at: new Date(now).toISOString(), db_version: db.userVersion(), files: {} };
    for (const e of entries) manifest.files[e.name] = { bytes: e.data.length, sha256: sha256(e.data) };
    return { entries: [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries], manifest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** ※ Retention (03): the newest backup of each of the last 14 days, 8 ISO weeks and 12 months. */
export function keep(days: string[]): Set<string> {
  const sorted = [...new Set(days)].sort().reverse(), out = new Set<string>();
  const isoWeek = (d: string) => {
    const t = new Date(`${d}T00:00:00Z`), wd = (t.getUTCDay() + 6) % 7;
    t.setUTCDate(t.getUTCDate() - wd + 3);   // Thursday of this week decides the ISO year
    const y = t.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
    return `${y}-W${1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)}`;
  };
  const take = (key: (d: string) => string, n: number) => {
    const seen = new Set<string>();
    for (const d of sorted) {
      const k = key(d);
      if (seen.has(k)) continue;
      if (seen.size >= n) break;
      seen.add(k); out.add(d);
    }
  };
  take((d) => d, 14);
  take(isoWeek, 8);
  take((d) => d.slice(0, 7), 12);
  return out;
}

export function prune(staging: string): string[] {
  if (!existsSync(staging)) return [];
  const files = readdirSync(staging).filter((f) => BACKUP_RE.test(f));
  const k = keep(files.map((f) => BACKUP_RE.exec(f)![1]!));
  const gone: string[] = [];
  for (const f of files) if (!k.has(BACKUP_RE.exec(f)![1]!)) {
    unlinkSync(join(staging, f));
    rmSync(join(staging, `${f}.sha256`), { force: true });
    gone.push(f);
  }
  return gone;
}

/**
 * W2 SEAM — `/node/v1/backup/put`. W2 brings nodes and that route; until then the encrypted file stays in
 * backup-staging/ only and this reports every node as still waiting. raw/ CAS sync to nodes (03) lands with it.
 */
export async function pushToNodes(_file: string, nodes: string[]): Promise<{ pushed: string[]; waiting: string[] }> {
  if (nodes.length) log("backup", "push to nodes not built yet (W2)", { nodes: nodes.length });
  return { pushed: [], waiting: nodes };
}

export interface BackupResult { file?: string; bytes?: number; parts?: number; pruned?: string[]; skipped?: "no_recipient"; waiting?: string[] }

/** One backup. No recipient = no backup and one admin notice (the nightly job calls this once a night). */
export async function runBackup(db: Db, h: Home, conf: { recipient?: string; to_nodes: string[] }, now = Date.now()): Promise<BackupResult> {
  if (!conf.recipient) {
    log("backup", "skipped: no recipient in backup.yaml");
    await notify.admin("⚠️ **今晚没备份**：backup.yaml 还没填 recipient（age 公钥）。填了之后下一晚开始备份。");
    return { skipped: "no_recipient" };
  }
  const { entries, manifest } = await collect(db, h, now);
  const enc = new Encrypter();
  enc.addRecipient(conf.recipient);
  // ※ in memory for now; a stream when the DB outgrows that (04 §13 量级: well under a GB)
  const sealed = await enc.encrypt(pack(entries));
  mkdirSync(h.staging, { recursive: true, mode: 0o700 });
  const name = backupName(manifest.day), out = join(h.staging, name), tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, sealed, { mode: 0o600 });
  renameSync(tmp, out);
  writeFileSync(`${out}.sha256`, `${sha256(sealed)}  ${name}\n`);
  const pruned = prune(h.staging);
  const { waiting } = await pushToNodes(out, conf.to_nodes);
  log("backup", "done", { file: name, bytes: sealed.length, parts: entries.length - 1, pruned: pruned.length });
  return { file: out, bytes: sealed.length, parts: entries.length - 1, pruned, waiting };
}

// ───────── restore ─────────

/** The age identities in a key file (AGE-SECRET-KEY-…). Its content never goes into an error or a log. */
export function readIdentities(file: string): string[] {
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { throw new BackupError(`读不了私钥文件 ${file}`); }
  const ids = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^AGE-SECRET-KEY-/.test(l));
  if (!ids.length) throw new BackupError(`${file} 里没有 AGE-SECRET-KEY- 开头的行`);
  return ids;
}

/** Decrypt and check a backup without writing anything: every part present with its sha256, the snapshot intact. */
export async function openBackup(file: string, identities: string[]): Promise<{ manifest: Manifest; entries: Map<string, Uint8Array> }> {
  const sealed = readFileSync(file);
  const side = `${file}.sha256`;
  if (existsSync(side) && readFileSync(side, "utf8").split(/\s+/)[0] !== sha256(sealed)) throw new BackupError("备份文件和旁边的 .sha256 对不上：文件坏了或被换了");
  const dec = new Decrypter();
  for (const i of identities) dec.addIdentity(i);
  let plain: Uint8Array;
  try { plain = await dec.decrypt(sealed); } catch { throw new BackupError("解不开：私钥不对，或文件坏了"); }
  const entries = new Map(unpack(plain).map((e) => [e.name, e.data]));
  const m = entries.get("manifest.json");
  if (!m) throw new BackupError("备份里没有 manifest.json");
  const manifest = JSON.parse(Buffer.from(m).toString("utf8")) as Manifest;
  if (manifest.format !== 1) throw new BackupError(`不认识的备份格式 ${manifest.format}`);
  for (const [name, want] of Object.entries(manifest.files)) {
    const got = entries.get(name);
    if (!got) throw new BackupError(`备份里缺 ${name}`);
    if (got.length !== want.bytes || sha256(got) !== want.sha256) throw new BackupError(`${name} 的 sha256 对不上`);
  }
  for (const name of entries.keys()) if (name !== "manifest.json" && !manifest.files[name]) throw new BackupError(`备份里多了 manifest 没列的 ${name}`);
  if (!entries.has("sbot.db")) throw new BackupError("备份里没有数据库");
  return { manifest, entries };
}

const RESTORED = ["db", "config", "agent-home", "keys", "secrets.env"];

export interface RestoreResult { day: string; parts: number; movedAside?: string }

/**
 * Restore into `h`. Refuses a home that has anything in it unless `force`; with `force` the things a restore would
 * replace are moved into .pre-restore-<stamp>/ (nothing is deleted).
 */
export async function restore(file: string, identityFile: string, h: Home, o: { force?: boolean; now?: number } = {}): Promise<RestoreResult> {
  const now = o.now ?? Date.now();
  // the live layout keeps secrets.env outside the home (SBOT_SECRETS); an existing one there counts as "not empty" too,
  // or a restore into a fresh home would silently replace the live secrets
  const secretsOutside = isAbsolute(relative(h.root, h.secrets)) || relative(h.root, h.secrets).startsWith("..");
  const busy = (existsSync(h.root) && readdirSync(h.root).filter((f) => !f.startsWith(".pre-restore-")).length > 0)
    || (secretsOutside && existsSync(h.secrets));
  if (busy && !o.force) throw new BackupError(`${secretsOutside && existsSync(h.secrets) ? h.secrets + " 已存在或 " : ""}${h.root} 不是空的。确定要覆盖就加 --force（原来的东西会挪到 .pre-restore-…/，不删）`);
  const { manifest, entries } = await openBackup(file, readIdentities(identityFile));
  mkdirSync(h.root, { recursive: true, mode: 0o700 });
  const work = join(h.root, `.restore-${now}`);
  mkdirSync(work, { recursive: true, mode: 0o700 });
  try {
    // check everything in a scratch dir first, so a bad part leaves the home as it was
    const snap = join(work, "sbot.db");
    writeFileSync(snap, entries.get("sbot.db")!, { mode: 0o600 });
    const ok = integrityCheck(snap);
    if (ok !== "ok") throw new BackupError(`数据库快照 integrity_check 没过：${ok.slice(0, 200)}`);
    for (const name of ["config", "agent-home"]) {
      const b = entries.get(`${name}.bundle`);
      if (!b) continue;
      const f = join(work, `${name}.bundle`);
      writeFileSync(f, b);
      try { await git(work, "bundle", "list-heads", f); } catch { throw new BackupError(`${name}.bundle 不是有效的 git bundle`); }
    }
    let movedAside: string | undefined;
    if (busy) {
      movedAside = join(h.root, `.pre-restore-${now}`);
      mkdirSync(movedAside, { recursive: true, mode: 0o700 });
      for (const n of RESTORED) {
        if (n === "secrets.env" && secretsOutside) {
          // copy, not rename: it may sit on another filesystem, and it is overwritten below anyway
          if (existsSync(h.secrets)) copyFileSync(h.secrets, join(movedAside, n));
          continue;
        }
        const p = join(h.root, n === "secrets.env" ? relative(h.root, h.secrets) : n);
        if (existsSync(p)) renameSync(p, join(movedAside, n));
      }
      if (existsSync(join(movedAside, "secrets.env"))) chmodSync(join(movedAside, "secrets.env"), 0o600);
    }
    mkdirSync(dirname(h.db), { recursive: true });
    for (const s of ["", "-wal", "-shm"]) rmSync(h.db + s, { force: true });
    renameSync(snap, h.db);
    for (const [name, dir] of [["config", h.config], ["agent-home", h.agentHome]] as const) {
      const f = join(work, `${name}.bundle`);
      if (existsSync(f)) {
        await git(dirname(dir), "clone", "-q", f, dir);
        await git(dir, "remote", "remove", "origin");
      } else await ensureRepo(dir);
    }
    for (const [name, data] of entries) {
      if (!name.startsWith("keys/")) continue;
      const dest = join(h.keys, ...name.slice(5).split("/"));
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeFileSync(dest, data, { mode: 0o600 });
    }
    if (existsSync(h.keys)) chmodSync(h.keys, 0o700);
    const sec = entries.get("secrets.env");
    if (sec) { mkdirSync(dirname(h.secrets), { recursive: true }); writeFileSync(h.secrets, sec, { mode: 0o600 }); chmodSync(h.secrets, 0o600); }
    log("backup", "restored", { day: manifest.day, parts: Object.keys(manifest.files).length, moved_aside: !!movedAside });
    return { day: manifest.day, parts: Object.keys(manifest.files).length, ...(movedAside ? { movedAside } : {}) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** For tests and `sbot status` later: newest backup in staging and its age. */
export function latestBackup(staging: string): { file: string; mtime: number } | undefined {
  if (!existsSync(staging)) return undefined;
  const f = readdirSync(staging).filter((n) => BACKUP_RE.test(n)).sort().pop();
  return f ? { file: join(staging, f), mtime: statSync(join(staging, f)).mtimeMs } : undefined;
}
