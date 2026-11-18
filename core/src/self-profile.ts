// The owner's own material (DESIGN §15.9): birth data and lens settings in config/self.yaml, and the pages under self/.
// The console's form and the main agent's self_profile / self_page tools share these functions. Every change is one git
// commit plus a config_changes row, and can be put back. Commit subjects and the ledger never carry the values.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { P, jobsConf, selfLensConf } from "./config.ts";
import { run } from "./db.ts";
import { git } from "./memory.ts";
import { CITIES, birthIssues, birthReady, chartInput } from "./birth.ts";
import { ConfigError, configFile, saveConfigText } from "./config-write.ts";
import { CAST_METHODS, LENSES, profileVersion } from "./lens.ts";

const FILE = "self.yaml";
const BIRTH_KEYS = ["date", "time", "calendar", "leap_month", "gender", "place", "longitude", "timezone"] as const;

export interface ProfilePatch {
  /** null clears it. Inside, a field set to null is removed; fields left out keep their value. */
  birth?: Record<string, unknown> | null;
  lenses?: Record<string, { enabled?: boolean; cast?: string | null; notes?: string | null }>;
}
interface WriteOpts { hash?: string; source: "console" | "chat" }

function applyPatch(text: string, patch: ProfilePatch): string {
  const doc = parseDocument(text);   // keeps his comments
  if (!doc.contents) doc.contents = doc.createNode({}) as any;
  const cur: any = doc.toJS() ?? {};
  if (patch.birth === null) doc.deleteIn(["birth"]);
  else if (patch.birth) {
    const b: Record<string, unknown> = { ...(cur.birth ?? {}) };
    for (const k of BIRTH_KEYS) if (k in patch.birth) { const v = patch.birth[k]; if (v === null || v === "") delete b[k]; else b[k] = v; }
    // a known city fills in what true solar time needs, unless the caller gave its own numbers
    const city = "place" in patch.birth ? CITIES.find((c) => c.name === b.place) : undefined;
    if (city && !("longitude" in patch.birth)) b.longitude = city.lon;
    if (city && !("timezone" in patch.birth)) { if (city.tz === undefined) delete b.timezone; else b.timezone = city.tz; }
    if (b.calendar !== "lunar") delete b.leap_month;
    // an unchanged block stays as written, comments and order included
    const same = (x: object) => JSON.stringify(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)));
    if (same(b) !== same(cur.birth ?? {})) doc.setIn(["birth"], doc.createNode(b));
  }
  for (const [lens, p] of Object.entries(patch.lenses ?? {})) {
    if (!LENSES[lens]) throw new ConfigError(`没有这门镜头：${lens}`);
    if (p.enabled !== undefined) doc.setIn(["lenses", lens, "enabled"], p.enabled);
    for (const k of ["cast", "notes"] as const) {
      if (!(k in p)) continue;
      if (p[k]) doc.setIn(["lenses", lens, "profile", k], p[k]); else if (doc.hasIn(["lenses", lens, "profile", k])) doc.deleteIn(["lenses", lens, "profile", k]);
    }
  }
  return doc.toString();
}

const versions = () => Object.fromEntries(Object.entries(LENSES).flatMap(([lens, d]) => Object.keys(d.methods).map((m) => [`${lens}:${m}`, profileVersion(lens, m)])));
/** after a write: which ledger versions moved, so the form and the agent can say "new chart from here on" */
const moved = (before: Record<string, string>) => { const now = versions(); return Object.keys(now).filter((k) => now[k] !== before[k]); };

export function profileView() {
  const f = configFile(FILE), { birth, lenses } = selfLensConf(), jobs = Object.entries(jobsConf());
  const ready = birthReady(birth);
  return {
    file: f.file, exists: f.exists, hash: f.hash, history: f.history, birth: birth ?? null, ready,
    issues: birth ? birthIssues(birth) : [], chart_input: ready ? chartInput(birth) : null,
    lenses: Object.fromEntries(Object.entries(LENSES).map(([k, d]) => [k, {
      zh: d.zh, enabled: lenses[k]?.enabled !== false, cast: lenses[k]?.profile?.cast ?? null, notes: lenses[k]?.profile?.notes ?? "",
      methods: Object.entries(d.methods).map(([m, v]) => ({ method: m, zh: v.zh, birth: v.birth, horizon: v.horizon ?? null, runnable: !v.birth || ready, version: profileVersion(k, m) })),
    }])),
    jobs: Object.fromEntries((["day", "week", "month"] as const).map((h) => {
      const hit = jobs.find(([, j]) => j.do === `lens_${h}`);
      return [h, hit ? { name: hit[0], every: hit[1].every, at: hit[1].at, weekday: hit[1].weekday, day: hit[1].day } : null];
    })),
    cities: CITIES, cast_methods: CAST_METHODS,
  };
}

export function saveProfile(patch: ProfilePatch, o: WriteOpts) {
  const cur = configFile(FILE), before = versions();
  const r = saveConfigText(FILE, applyPatch(cur.text, patch), o.hash ?? cur.hash, { source: o.source, what: "profile" });
  return { ...profileView(), changed: r.changed, moved: moved(before) };
}

export function rollbackProfile(sha: string, o: WriteOpts) {
  if (!/^[0-9a-f]{6,40}$/.test(sha)) throw new ConfigError("版本号不对");
  let text: string;
  try { text = git(P.config, "show", `${sha}:${FILE}`); } catch { throw new ConfigError(`版本 ${sha} 里没有 ${FILE}`, 404); }
  parseYaml(text);
  const cur = configFile(FILE), before = versions();
  const r = saveConfigText(FILE, text, o.hash ?? cur.hash, { source: o.source, what: `rollback to ${sha}` });
  return { ...profileView(), changed: r.changed, moved: moved(before) };
}

// ───────────── pages under self/ ─────────────

const READ_CHUNK = 20_000;
/** not privacy: these are generated from tables, or frozen so a later hand can't rewrite what was seen at the time */
const WRITE_REFUSED: [RegExp, string][] = [
  [/^self\/(habits|rhythms)\.md$/, "这个文件由习气 / 节律条目生成，手改会被覆盖；用 self_mark 改状态"],
  [/^self\/charts\//, "事实盘按 profile_version 冻结；改出生信息或镜头设置会生成新版本"],
  [/^self\/outlooks\//, "前瞻写下后不改；回看用 outlook_revisit"],
  [/^self\/reviews\//, "复盘由 review_submit 落档，不手改"],
];

function selfPath(rel: string): { rel: string; abs: string } {
  const n = normalize(rel.replace(/^\/+/, "")).split(sep).join("/").replace(/\/$/, "");
  if (n !== "self" && !n.startsWith("self/")) throw new ConfigError(`只能是 self/ 下的路径：${rel}`);
  if (n.split("/").includes("..")) throw new ConfigError(`路径不对：${rel}`);
  const abs = join(P.agentHome, n), root = join(P.agentHome, "self");
  // nothing should put a link here; if something did, it must not lead out of self/
  if (existsSync(abs) && !`${realpathSync(abs)}/`.startsWith(`${realpathSync(root)}/`)) throw new ConfigError(`路径不对：${rel}`);
  return { rel: n, abs };
}

export function listSelf(dir = "self"): string {
  const { rel, abs } = selfPath(dir);
  if (!existsSync(abs)) return `（没有这个目录：${rel}）`;
  return readdirSync(abs, { withFileTypes: true }).filter((e) => e.name !== ".git").sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => e.isDirectory() ? `${rel}/${e.name}/` : `${rel}/${e.name}（${lstatSync(join(abs, e.name)).size} 字节）`).join("\n") || "（空）";
}

/** the whole file, in chunks: charts are not all .md and can run past one tool result */
export function readSelf(path: string, offset = 0): string {
  const { rel, abs } = selfPath(path);
  if (!existsSync(abs)) return `（没有这个页面：${rel}）`;
  if (!lstatSync(abs).isFile()) return listSelf(rel);
  const s = readFileSync(abs, "utf8");
  if (s.includes("\0")) throw new ConfigError(`${rel} 不是文本文件`);
  const part = s.slice(offset, offset + READ_CHUNK), next = offset + part.length;
  return next < s.length ? `${part}\n…（共 ${s.length} 字，后面的用 offset=${next} 接着读）` : part;
}

function commitSelf(rel: string, what: string, source: string, note: string): string {
  git(P.agentHome, "add", "--", rel);
  git(P.agentHome, "commit", "-q", "-m", `${rel}: ${what} (via ${source})`, "--", rel);   // this file only, so it can be undone alone
  const sha = git(P.agentHome, "rev-parse", "--short", "HEAD").trim();
  run("INSERT INTO config_changes(ts, file, diff, source) VALUES(?,?,?,?)", Date.now(), rel, `${sha} ${note}`, source);
  return sha;
}

export function writeSelf(path: string, text: string, mode: "replace" | "append", source: "console" | "chat" = "chat"): string {
  const { rel, abs } = selfPath(path);
  if (!rel.endsWith(".md")) throw new ConfigError("只能写 .md 页面");
  const refused = WRITE_REFUSED.find(([re]) => re.test(rel));
  if (refused) throw new ConfigError(refused[1]);
  const had = existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
  const next = mode === "append" && had ? `${had.replace(/\n*$/, "\n")}${text}\n` : text.endsWith("\n") ? text : `${text}\n`;
  if (next === had) return `${rel} 没有变化`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next);
  const sha = commitSelf(rel, mode === "append" ? "append" : had === undefined ? "create" : "edit", source, `${mode} ${[...next].length} 字`);
  return `写好了 ${rel}（版本 ${sha}，可以回滚）`;
}

export function selfHistory(path: string): string {
  const { rel } = selfPath(path);
  try {
    return git(P.agentHome, "log", "-n", "15", "--format=%h %ad %s", "--date=format-local:%Y-%m-%d %H:%M", "--", rel).trim() || "（还没有历史）";
  } catch { return "（还没有历史）"; }
}

/** put the page back as it was at `sha`; a new commit, so this too can be undone */
export function restoreSelf(path: string, sha: string, source: "console" | "chat" = "chat"): string {
  const { rel, abs } = selfPath(path);
  if (!/^[0-9a-f]{6,40}$/.test(sha)) throw new ConfigError("版本号不对");
  const refused = WRITE_REFUSED.find(([re]) => re.test(rel));
  if (refused) throw new ConfigError(refused[1]);
  let text: string;
  try { text = git(P.agentHome, "show", `${sha}:${rel}`); } catch { throw new ConfigError(`版本 ${sha} 里没有 ${rel}`, 404); }
  if (existsSync(abs) && readFileSync(abs, "utf8") === text) return `${rel} 已经是这个版本`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return `${rel} 回到了版本 ${sha}（新版本 ${commitSelf(rel, `rollback to ${sha}`, source, `rollback to ${sha}`)}）`;
}
