// Matters, "事" (DESIGN §15.3, §15.4). State in the `matters` table; content (发心, 方向, 盘点, 过程, 复盘) in
// agent-home/matters/<id>.md, which is memory. 起局 runs in the matter's own lane as a protocol the main agent follows
// (the playbook below is returned by matter_open), not as a separate process. Lenses (M6) are optional step 4.6; 复盘 comes at 收 (M3c).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, one, run } from "./db.ts";
import { P } from "./config.ts";
import { localStamp } from "./memory.ts";

export const SECTIONS = ["发心", "方向", "事实盘点", "关键人", "检查点", "过程", "收"] as const;
export type Section = (typeof SECTIONS)[number];

export const PLAYBOOK = `起局按这个顺序，一步一步来，不要一口气全倒出来：
1. 事实盘点：用 memory_search / session 记录 / 任务 / 审批里已有的东西，列出已知、未知、关键人、关键时间点，写进「事实盘点」「关键人」。盘点完先问一句：还有什么是记录里看不到的？
2. 问发心：问他这件事真正想要的是什么。只问，不代填；他说了原话再写进「发心」（用他的原话）。
3. 方向：在他的发心之下，给 1～3 条方向性的建议（不是安排），写进「方向」。
4. 习气提醒：self_list(status=["endorsed"]) 里有他认可过、跟这类事相关的条目，挑 1～2 条提一句；没有就跳过。送一程的不提。
4.5 放进当下的节律：本月、本周前瞻里跟这件事相关的留意点提一句；也可以给这件事写 1～3 条前瞻（outlook_submit horizon=matter, period=matter:<id>），收的时候拿出来回看。
4.6 镜头（可选）：问一句要不要为这件事起一卦或看一眼（他说要才做）：lens_reading(lens=liuyao, method=cast, matter_id=<id>) 或 lens=ziwei, method=zhanbu。结果回来后挑留意点说一两句，写进事的页面「方向」一节时标明「镜头的看法」。
5. 检查点：和他商量 1～2 个检查点，用 followup_set（带 matter_id）设好；定下「收」的条件（某个日期或某个事件），写进「检查点」。
镜头（起卦、流月）要他开口才起（见 4.6）。`;

const file = (id: number) => join(P.agentHome, "matters", `${id}.md`);

export function openMatter(o: { title: string; domain: "work" | "personal"; lane: string; close_condition?: string }) {
  const r = run("INSERT INTO matters(title, domain, lane, status, close_condition, opened_at) VALUES(?,?,?,?,?,?)",
    o.title, o.domain, o.lane, "open", o.close_condition ?? null, Date.now());
  const id = Number(r.lastInsertRowid);
  const rel = `matters/${id}.md`;
  writeFileSync(file(id), `# ${o.title}\n\n- 事 #${id} · ${o.domain === "work" ? "工作" : "私事"} · ${localStamp().slice(0, 10)} 起${o.close_condition ? ` · 收：${o.close_condition}` : ""}\n\n` +
    SECTIONS.map((s) => `## ${s}\n`).join("\n"));
  run("UPDATE matters SET file_path=? WHERE id=?", rel, id);
  return { id, rel };
}

/** Append a line under one section of the matter file; the source tag is set by code (§8.3). */
export function noteMatter(id: number, section: Section, text: string, src: string): string {
  const m = one("SELECT * FROM matters WHERE id=?", id);
  if (!m) throw new Error(`no matter #${id}`);
  if (!SECTIONS.includes(section)) throw new Error(`section must be one of ${SECTIONS.join(" / ")}`);
  const f = file(id);
  const body = existsSync(f) ? readFileSync(f, "utf8") : `# ${m.title}\n\n## ${section}\n`;
  const line = `- [${localStamp().slice(5)}][src=${src}] ${text.replace(/\s*\n\s*/g, " / ").trim()}`;
  const head = `## ${section}\n`;
  const at = body.indexOf(head);
  let next: string;
  if (at < 0) next = `${body.trimEnd()}\n\n${head}${line}\n`;
  else {
    const end = body.indexOf("\n## ", at + head.length);
    const cut = end < 0 ? body.length : end + 1;
    next = `${body.slice(0, cut).trimEnd()}\n${line}\n${end < 0 ? "" : "\n" + body.slice(cut)}`;
  }
  writeFileSync(f, next);
  if (m.status === "open" && section !== "事实盘点" && section !== "关键人") run("UPDATE matters SET status='active' WHERE id=? AND status='open'", id);
  return m.file_path;
}

export function setMatterStatus(id: number, status: "closing" | "dropped", note?: string) {
  if (!run("UPDATE matters SET status=?, closed_at=? WHERE id=?", status, Date.now(), id).changes) throw new Error(`no matter #${id}`);
  if (note) noteMatter(id, "收", note, "owner");
}

export function listMatters(open = true) {
  const rows = all(`SELECT * FROM matters ${open ? "WHERE status IN ('open','active','closing')" : ""} ORDER BY id DESC LIMIT 30`);
  if (!rows.length) return "（没有）";
  return rows.map((m) => {
    const tasks = one("SELECT COUNT(*) n FROM tasks WHERE matter_id=?", m.id)!.n, fu = one("SELECT COUNT(*) n FROM timers WHERE matter_id=? AND status='pending'", m.id)!.n;
    const ev = one("SELECT COUNT(*) n, SUM(CASE WHEN state='open' AND level IN ('reply','decide') THEN 1 ELSE 0 END) open FROM events WHERE matter_id=?", m.id)!;
    const keys = JSON.parse(m.keys ?? "[]") as string[];
    return `#${m.id} ${m.title}（${m.status}，${localStamp(m.opened_at).slice(5, 10)} 起；${m.file_path}；任务 ${tasks}、待提醒 ${fu}、事件 ${ev.n}${ev.open ? `（等他 ${ev.open}）` : ""}${keys.length ? `；又叫：${keys.join("、")}` : ""}${m.close_condition ? `；收：${m.close_condition}` : ""}）`;
  }).join("\n");
}
