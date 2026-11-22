// The one way a whole config file gets written (DESIGN §触5.3): hash check → YAML → schema → write → git commit →
// config_changes → note in the admin group. The console's editor, the birth form and the main agent's self_profile all
// come through here, so none of them can skip a step.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { P, feishuConf, log } from "./config.ts";
import { run } from "./db.ts";
import { commitIfDirty, git, gitRead } from "./memory.ts";
import { sendText } from "./cards.ts";
import { CONFIG_FILES, SCHEMAS, widening } from "./schemas.ts";

const SEED = join(dirname(fileURLToPath(import.meta.url)), "..", "seed", "config");
const WHO: Record<string, string> = { console: "控制台", chat: "主对话" };
export const configHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** a refused write; `status` is what the console answers with */
export class ConfigError extends Error { status: number; constructor(msg: string, status = 400) { super(msg); this.status = status; } }

export async function notifyAdmin(text: string) {
  const admin = feishuConf().admin_chat;
  if (!admin) return;
  try { await sendText(admin, text); } catch (e: any) { log("console", "admin notice failed", { err: String(e?.message ?? e).slice(0, 200) }); }
}

export function configFile(file: string) {
  if (!CONFIG_FILES.includes(file)) throw new ConfigError("unknown config file", 404);
  const f = join(P.config, file);
  // a file he hasn't made yet opens on its commented template (e.g. sources.yaml), so he starts from the examples
  const seed = join(SEED, file);
  const text = existsSync(f) ? readFileSync(f, "utf8") : file !== "people.yaml" && file !== "models.yaml" && existsSync(seed) ? readFileSync(seed, "utf8") : "";
  let history: { sha: string; at: number; subject: string }[] = [];
  try {
    history = gitRead(P.config, "log", "-n", "12", "--format=%h\x1f%at\x1f%s", "--", file).trim().split("\n").filter(Boolean)
      .map((l) => { const [s, at, subject] = l.split("\x1f"); return { sha: s, at: Number(at) * 1000, subject }; });
  } catch { /* new file */ }
  return { file, text, hash: configHash(text), exists: existsSync(f), history };
}

export function saveConfigText(file: string, text: string, hash: string, o: { source: "console" | "chat"; what?: string; check?: (parsed: any) => void }) {
  const cur = configFile(file);
  if (cur.hash !== hash) throw new ConfigError("这个文件在你打开之后被改过了（卡片、命令或别处）。刷新后再改。", 409);
  if (text === cur.text) return { ...cur, changed: false, widened: [] as string[] };
  if (text.length > 200_000) throw new ConfigError("too large");
  let parsed: unknown;
  try { parsed = parseYaml(text); } catch (e: any) { throw new ConfigError(`YAML 写错了：${String(e?.message ?? e).split("\n")[0]}`); }
  const res = SCHEMAS[file].safeParse(parsed ?? (file === "jobs.yaml" || file === "repos.yaml" ? null : {}));
  if (!res.success) throw new ConfigError("不符合格式：\n" + res.error.issues.slice(0, 8).map((i: any) => `- ${i.path.join(".") || "(根)"}：${i.message}`).join("\n"));
  o.check?.(parsed);
  const wide = widening(file, cur.text ? parseYaml(cur.text) : {}, parsed);
  writeFileSync(join(P.config, file), text);
  // the subject is shown in history lists: it never carries values
  commitIfDirty(P.config, `${file}: ${o.what ?? "edit"} (via ${o.source})`);
  let diff = "";
  try { diff = git(P.config, "show", "--format=", "--unified=0", "--no-color", "HEAD", "--", file).split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join("\n"); } catch { /* */ }
  run("INSERT INTO config_changes(ts, file, diff, source) VALUES(?,?,?,?)", Date.now(), file, diff.slice(0, 4000), o.source);
  log("console", "config saved", { file, lines: diff.split("\n").length, source: o.source });
  const lines = diff.split("\n").slice(0, 24).map((l) => l.slice(0, 140)), who = WHO[o.source];
  // §读5.1: the admin group is a group, so self.yaml's content stays out of it; it only hears that the file changed
  void notifyAdmin(file === "self.yaml" ? `⚙️ **${who}改了 self.yaml**（${diff.split("\n").length} 行；私人内容，不在群里显示，去控制台或私聊看）`
    : `⚙️ **${who}改了 ${file}**\n\`\`\`\n${lines.join("\n")}${diff.split("\n").length > 24 ? "\n…" : ""}\n\`\`\``)
    .then(() => wide.length ? notifyAdmin(`⚠️ **放宽了限制**（${who}，${file}）\n${wide.map((w) => `- ${w}`).join("\n")}`) : undefined);
  return { ...configFile(file), changed: true, widened: wide };
}
