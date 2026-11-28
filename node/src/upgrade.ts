// Self-upgrade to the hub's sha (05 「升级」, veto 8). Only for an installed node (SBOT_NODE_ROOT, deploy/node):
//   <root>/repo/            a clone of the public repo (fetch only)
//   <root>/releases/<sha>/  one exported tree per version, `npm ci --ignore-scripts` done, self-checked
//   <root>/current          → releases/<sha>, swapped atomically; the service runs current/node/src/main.ts
//   <root>/upgrade.json     the marker: {from, to, phase: trial | ok | failed, starts}
// Only a commit merged into main is taken (a hub that was impersonated still can't push other code). The new version
// is on trial for 30 s: it starts a second time inside the trial (it crashed) or hasn't reached the hub by then → back
// to `from`, and the old version says so in hello (upgrade.ok false) and never tries that sha again.
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { run as defaultRun, type Run } from "./git.ts";

export const TRIAL_MS = 30_000;
export const EXIT_RESTART = 75;
const KEEP = 3;

export type Layout = { root: string; repo: string; releases: string; current: string; marker: string };
export type Marker = { from: string; to: string; phase: "trial" | "ok" | "failed"; starts?: number; error?: string; reported?: boolean; failed?: string[]; at?: number };

export const layout = (root: string): Layout => ({ root, repo: join(root, "repo"), releases: join(root, "releases"), current: join(root, "current"), marker: join(root, "upgrade.json") });

export function readMarker(l: Layout): Marker | undefined {
  try { return JSON.parse(readFileSync(l.marker, "utf8")) as Marker; } catch { return undefined; }
}
export function writeMarker(l: Layout, m: Marker) {
  const tmp = `${l.marker}.tmp`;
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, l.marker);
}

export function currentSha(l: Layout): string | undefined {
  try { return basename(readlinkSync(l.current)); } catch { return undefined; }
}

/** current → releases/<sha>, atomically (a new link renamed over the old one). */
export function swap(l: Layout, sha: string) {
  const tmp = join(l.root, ".current-new");
  if (existsSync(tmp) || isLink(tmp)) unlinkSync(tmp);
  symlinkSync(join(l.releases, sha), tmp, process.platform === "win32" ? "junction" : "dir");
  renameSync(tmp, l.current);
}
const isLink = (p: string) => { try { readlinkSync(p); return true; } catch { return false; } };

/** Shas this node already failed on: never again. */
export const failedShas = (l: Layout) => readMarker(l)?.failed ?? [];

/**
 * fetch → the commit exists → it is on origin/main → export → npm ci --ignore-scripts → self-check. → the release
 * directory. Throws with the reason (the caller logs it and stays on its version).
 */
export async function prepare(l: Layout, sha: string, r: Run = defaultRun): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("target sha 不是一个完整的提交号");
  const dir = join(l.releases, sha);
  if (existsSync(join(dir, ".ok"))) return dir;
  const g = (args: string[], timeoutMs = 300_000) => r("git", ["-c", "core.hooksPath=/dev/null", "-C", l.repo, ...args], { cwd: l.root, timeoutMs });
  const must = async (what: string, p: Promise<{ code: number | null; err: string }>) => { const x = await p; if (x.code !== 0) throw new Error(`${what}：${x.err.trim().slice(0, 300)}`); };
  await must("git fetch 失败", g(["fetch", "--quiet", "origin"]));
  await must("没有这个提交", g(["cat-file", "-e", `${sha}^{commit}`]));
  await must("这个提交不在 main 上，不升", g(["merge-base", "--is-ancestor", sha, "origin/main"]));
  mkdirSync(l.releases, { recursive: true });
  const tmp = join(l.releases, `.tmp-${sha}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const tar = join(l.releases, `.tmp-${sha}.tar`);
  try {
    await must("git archive 失败", g(["archive", "--format=tar", "-o", tar, sha]));
    await must("解包失败", r("tar", ["-xf", tar, "-C", tmp], { cwd: l.root, timeoutMs: 300_000 }));
  } finally { rmSync(tar, { force: true }); }
  writeFileSync(join(tmp, "REVISION"), `${sha}\n`);
  await must("npm ci 失败", r("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "-w", "node", "-w", "protocol"], { cwd: tmp, timeoutMs: 900_000 }));
  const check = await r(process.execPath, [join(tmp, "node", "src", "cli.ts"), "selftest"], { cwd: tmp, timeoutMs: 60_000 });
  if (check.code !== 0 || !check.out.includes("selftest ok")) throw new Error(`新版本自检没过：${(check.err || check.out).trim().slice(0, 300)}`);
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  writeFileSync(join(dir, ".ok"), `${Date.now()}\n`);
  prune(l, sha);
  return dir;
}

/** Keep the newest few releases (and whatever current points at). */
function prune(l: Layout, keep: string) {
  const cur = currentSha(l);
  const all = readdirSync(l.releases).filter((n) => /^[0-9a-f]{40}$/.test(n)).map((n) => ({ n, t: statSync(join(l.releases, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { n } of all.slice(KEEP)) if (n !== cur && n !== keep) rmSync(join(l.releases, n), { recursive: true, force: true });
}

/** Swap to the new version and mark the trial; the caller exits with EXIT_RESTART. */
export function begin(l: Layout, from: string, to: string) {
  const prev = readMarker(l);
  swap(l, to);
  writeMarker(l, { from, to, phase: "trial", starts: 0, at: Date.now(), failed: prev?.failed ?? [] });
}

/**
 * At start: what the marker says about this version.
 *   trial   this is the new version on trial (start the 30 s clock)
 *   rollback  it started a second time inside the trial: back to `from` already done, exit and let the service start it
 *   report  an upgrade result for hello
 */
export function startup(l: Layout, mySha: string): { trial?: true; rollback?: true; report?: { from: string; to: string; ok: boolean; error?: string } } {
  const m = readMarker(l);
  if (!m) return {};
  if (m.phase === "trial" && m.to === mySha) {
    const starts = (m.starts ?? 0) + 1;
    if (starts >= 2) { fail(l, m, "新版本在试用的 30 秒里退出了"); return { rollback: true }; }
    writeMarker(l, { ...m, starts });
    return { trial: true };
  }
  if (m.reported) return {};
  if (m.phase === "failed" && m.from === mySha) return { report: { from: m.from, to: m.to, ok: false, ...(m.error ? { error: m.error } : {}) } };
  if (m.phase === "ok" && m.to === mySha) return { report: { from: m.from, to: m.to, ok: true } };
  return {};
}

function fail(l: Layout, m: Marker, error: string) {
  if (existsSync(join(l.releases, m.from))) swap(l, m.from);
  writeMarker(l, { ...m, phase: "failed", error, failed: [...new Set([...(m.failed ?? []), m.to])], reported: false });
}

/** The trial is over: it stayed up and reached the hub. */
export function passed(l: Layout) { const m = readMarker(l); if (m?.phase === "trial") writeMarker(l, { ...m, phase: "ok", reported: false }); }
/** The trial failed (no hub within 30 s): back to `from`; the caller exits with EXIT_RESTART. */
export function failed(l: Layout, error: string) { const m = readMarker(l); if (m?.phase === "trial") fail(l, m, error); }
/** hello carried the report. */
export function reported(l: Layout) { const m = readMarker(l); if (m && m.phase !== "trial") writeMarker(l, { ...m, reported: true }); }
