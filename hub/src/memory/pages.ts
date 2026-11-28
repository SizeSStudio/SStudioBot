// agent-home reads and appends (§读1), ported from core/src/memory.ts: path checks, page reads that say how much
// they returned (R7), journal lines with run and source tags the model can't set (§读1.3), the files every run of
// mine loads, and the raw-material store (content-addressed, add-only).
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import { run } from "../db/ambient.ts";
import { home } from "../home.ts";
import { localStamp } from "../time.ts";
import { repoQueue } from "./repo.ts";

export type Principal = "owner" | "known" | "other";
const OWNER_ONLY = ["self/"];
const NEVER = [".git/"];

/** the path as the filesystem will see it, so a check on it can't be dodged with ./ or a/../ */
export const cleanRel = (rel: string) => normalize(rel.replace(/^\/+/, "")).split(sep).join("/");

/** a model-supplied relative path → absolute; throws on anything outside agent-home or not visible to the principal */
export function safePath(rel: string, who: Principal): string {
  const n = cleanRel(rel);
  if (n.startsWith("..") || n.includes("/../") || n === ".") throw new Error(`bad path: ${rel}`);
  if (!n.endsWith(".md")) throw new Error("only .md files");
  if (NEVER.some((p) => n.startsWith(p))) throw new Error(`not allowed: ${rel}`);
  if (who !== "owner" && OWNER_ONLY.some((p) => n.startsWith(p))) throw new Error(`not allowed: ${rel}`);
  if (who !== "owner" && !n.startsWith("shared/")) throw new Error(`not allowed: ${rel}`);   // §办1.2: others see shared/ only
  return join(home().agentHome, n);
}

export const READ_CHARS = 12_000;

/** a page, from `offset` chars; when cut, the last line says how far it got (R7: 「读到 12000 / 共 N 字」) */
export function readPage(rel: string, who: Principal, o: { offset?: number; max?: number } = {}): string {
  const f = safePath(rel, who);
  if (!existsSync(f)) return `（没有这一页：${rel}）`;
  const s = readFileSync(f, "utf8");
  const from = Math.max(0, Math.floor(o.offset ?? 0)), max = o.max ?? READ_CHARS;
  const part = s.slice(from, from + max), to = from + part.length;
  return to < s.length || from > 0
    ? `${part}\n…（读到 ${to} / 共 ${s.length} 字${to < s.length ? `；接着读用 offset=${to}` : ""}）`
    : part;
}

/** one journal line: `- [HH:MM][run=<id>][src=<tag>] …` (03 「memory」); the tool layer fills run and src */
export function journalLine(text: string, o: { run?: string; src: string; ms?: number }): { rel: string; line: string } {
  const [day, hm] = localStamp(o.ms).split(" ");
  const tags = `[${hm}]${o.run ? `[run=${o.run}]` : ""}[src=${o.src}]`;
  return { rel: `journal/${day}.md`, line: `- ${tags} ${text.replace(/\s*\n\s*/g, " / ").trim()}\n` };
}

/** append to today's journal through the agent-home queue; resolves to the commit sha */
export async function appendJournal(text: string, o: { run?: string; src: string; ms?: number }): Promise<string | null> {
  const { rel, line } = journalLine(text, o);
  const { sha } = await repoQueue(home().agentHome).write((d) => {
    const f = join(d, rel);
    mkdirSync(dirname(f), { recursive: true });
    if (!existsSync(f)) appendFileSync(f, `# ${rel.slice(8, 18)}\n\n`);
    appendFileSync(f, line);
  }, `journal: ${o.src}`);
  return sha;
}

/** files loaded into every run of mine (§读1.2), each with a cap so a runaway file can't eat the context */
export const PROMPT_CAPS: Record<string, number> = {
  "AGENTS.md": 12_000, "SOUL.md": 6_000, "VOICE.md": 4_000, "USER.md": 4_000, "MEMORY.md": 4_000, "self/practice.md": 4_000,
};
export function promptFiles(): { name: string; text: string }[] {
  return Object.entries(PROMPT_CAPS).map(([name, cap]) => {
    const f = join(home().agentHome, name);
    let text = existsSync(f) ? readFileSync(f, "utf8").trim() : "";
    if (text.length > cap) text = text.slice(0, cap) + `\n…（${name} 超过 ${cap} 字被截断了，告诉我它超长了）`;
    return { name, text };
  });
}

// ---- raw materials (§读1.4): raw/sha256/<two>/<sha>, add-only ----

export const rawPath = (sha: string) => {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("bad sha256");
  return join(home().raw, "sha256", sha.slice(0, 2), sha);
};

/** store bytes once; returns `raw:<sha>`. Metadata goes in raw_sources (first writer wins). */
export function putRaw(bytes: Buffer, meta: { mime?: string; title?: string; origin_url?: string; src: string; visibility?: "owner" | "work" | "shared"; inbox_id?: number }): string {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const f = rawPath(sha);
  if (!existsSync(f)) {
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, f);
  }
  run(`INSERT OR IGNORE INTO raw_sources(sha256, mime, bytes, title, origin_url, src, visibility, received_at, inbox_id) VALUES(?,?,?,?,?,?,?,?,?)`,
    sha, meta.mime ?? null, bytes.length, meta.title ?? null, meta.origin_url ?? null, meta.src, meta.visibility ?? "owner", Date.now(), meta.inbox_id ?? null);
  return `raw:${sha}`;
}

export function readRaw(ref: string): Buffer | undefined {
  const sha = ref.replace(/^raw:/, "");
  try { return readFileSync(rawPath(sha)); } catch { return undefined; }
}
