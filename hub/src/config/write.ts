// The one way a whole config file gets written (§触5.3; 03 「config」 唯一写路径): hash check → YAML → schema → check →
// widening → write → git commit → config_changes → admin notice. Clients' editors, forms, the main agent's self_profile
// and one-time upgrades all come through here, so none of them can skip a step. Ported from core/src/config-write.ts;
// the difference is that the whole read-check-write-commit runs inside the config repo's write queue (memory/repo.ts),
// so two saves can't interleave and the hash check sees what the previous save left.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db/db.ts";
import { git, repoQueue } from "../memory/repo.ts";
import { log } from "../log.ts";
import * as notify from "../notify.ts";
import { configDir, parseText, ConfigInvalid } from "./load.ts";
import { CONFIG_FILES } from "./schemas.ts";
import { widening } from "./widening.ts";

export const SEED_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "seed", "config");
export const configHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const MAX = 200_000;
export type Source = "console" | "chat" | "card" | "command" | "upgrade" | "proposal" | "manual";
const WHO: Record<string, string> = { console: "客户端", chat: "主对话", card: "卡片", command: "命令", upgrade: "升级", proposal: "改进提案", manual: "手动" };

/** a refused write; `status` is what the API answers with */
export class ConfigError extends Error {
  status: number;
  constructor(msg: string, status = 400) { super(msg); this.status = status; }
}

export interface History { sha: string; at: number; subject: string }
export interface ConfigFile { file: string; text: string; hash: string; exists: boolean }

/** The file as it is now. One I haven't made yet opens on its commented template (people and models need my data). */
export function readConfigFile(file: string): ConfigFile {
  if (!CONFIG_FILES.includes(file)) throw new ConfigError("unknown config file", 404);
  const f = join(configDir(), file), seed = join(SEED_CONFIG, file);
  const exists = existsSync(f);
  const text = exists ? readFileSync(f, "utf8") : file !== "people.yaml" && file !== "models.yaml" && existsSync(seed) ? readFileSync(seed, "utf8") : "";
  return { file, text, hash: configHash(text), exists };
}

export async function configHistory(file: string, n = 12): Promise<History[]> {
  try {
    const out = await git(configDir(), "log", "-n", String(n), "--format=%h\x1f%at\x1f%s", "--", file);
    return out.trim().split("\n").filter(Boolean).map((l) => {
      const [sha = "", at = "0", subject = ""] = l.split("\x1f");
      return { sha, at: Number(at) * 1000, subject };
    });
  } catch { return []; }
}

export interface SaveOpts {
  source: Source;
  /** device:<id> | <channel> | run:<id> (04 config_changes.actor) */
  actor?: string;
  /** commit subject; shown in history lists, so it never carries values */
  what?: string;
  /** an extra check of the parsed value (throw ConfigError to refuse) */
  check?: (parsed: unknown) => void;
}
export interface SaveResult extends ConfigFile { changed: boolean; widened: string[]; sha: string | null; diff: string }

export async function saveConfigText(db: Db, file: string, text: string, hash: string, o: SaveOpts): Promise<SaveResult> {
  if (!CONFIG_FILES.includes(file)) throw new ConfigError("unknown config file", 404);
  const dir = configDir();
  const { sha, result } = await repoQueue(dir).write((wt) => {
    const cur = readConfigFile(file);
    if (cur.hash !== hash) throw new ConfigError("这个文件在你打开之后被改过了（卡片、命令或别处）。刷新后再改。", 409);
    if (text === cur.text && cur.exists) return { changed: false, widened: [] as string[] };
    if (text.length > MAX) throw new ConfigError("too large");
    let parsed: unknown;
    try { parsed = parseText(file, text); } catch (e) {
      if (e instanceof ConfigInvalid) throw new ConfigError(e.message.slice(file.length + 2));
      throw e;
    }
    o.check?.(parsed);
    let before: unknown = {};
    if (cur.exists) { try { before = parseText(file, cur.text); } catch { before = {}; } }
    const widened = widening(file, before, parsed);
    writeFileSync(join(wt, file), text);
    return { changed: true, widened };
  }, (r) => (r.changed ? `${file}: ${o.what ?? "edit"} (via ${o.source})` : null));

  if (!result.changed) return { ...readConfigFile(file), changed: false, widened: [], sha: null, diff: "" };
  let diff = "";
  if (sha) {
    try {
      diff = (await git(dir, "show", "--format=", "--unified=0", "--no-color", sha, "--", file))
        .split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join("\n");
    } catch { /* first commit edge cases: leave the diff empty */ }
  }
  const n = diff ? diff.split("\n").length : 0;
  // self.yaml holds birth data, which lives only in self.yaml (底线); config_changes syncs to every device via change_log,
  // so its row only says that it changed (04 config_changes.diff)
  const stored = file === "self.yaml" ? `(${n} 行，私人内容不记)` : diff.slice(0, 4000);
  db.run("INSERT INTO config_changes(ts, file, diff, source, actor) VALUES (?, ?, ?, ?, ?)", Date.now(), file, stored, o.source, o.actor ?? null);
  log("config", "saved", { file, lines: n, source: o.source });
  const who = WHO[o.source] ?? o.source;
  // §读5.1: the admin outlet includes a group, so self.yaml's content stays out of it; it only hears that the file changed
  const lines = diff.split("\n").slice(0, 24).map((l) => l.slice(0, 140));
  await notify.admin(file === "self.yaml"
    ? `⚙️ **${who}改了 self.yaml**（${n} 行；私人内容，这里不显示，去客户端或私聊看）`
    : `⚙️ **${who}改了 ${file}**\n\`\`\`\n${lines.join("\n")}${n > 24 ? "\n…" : ""}\n\`\`\``);
  if (result.widened.length) await notify.admin(`⚠️ **放宽了限制**（${who}，${file}）\n${result.widened.map((w) => `- ${w}`).join("\n")}`);
  return { ...readConfigFile(file), changed: true, widened: result.widened, sha, diff };
}
