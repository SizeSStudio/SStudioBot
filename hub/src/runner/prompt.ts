// The system prompt (03 runner 「提示词」, R7): promptFiles() loads the agent-home files with their own limits; a file
// over its limit is cut and the prompt says so, never silently. VOICE.md and self/practice.md load only in a round I
// typed myself. The assembly order is decided here, in systemPrompt(), and nowhere else. Recall snippets and
// "memory changed" notes go into the user message, not here.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { peopleConf } from "../config/load.ts";
import type { Col, TurnContext } from "../turn.ts";

export const LIMITS: Record<string, number> = {
  "AGENTS.md": 12_000, "SOUL.md": 6_000, "USER.md": 4_000, "MEMORY.md": 4_000, "VOICE.md": 3_000, "self/practice.md": 3_000,
};
const TYPED_ONLY = new Set(["VOICE.md", "self/practice.md"]);

export interface PromptFile { name: string; text: string; total: number; cut: boolean }

export function promptFiles(agentHome: string, col: Col): PromptFile[] {
  const out: PromptFile[] = [];
  for (const [name, max] of Object.entries(LIMITS)) {
    if (TYPED_ONLY.has(name) && col !== "typed") continue;
    const f = join(agentHome, name);
    if (!existsSync(f)) continue;
    const full = readFileSync(f, "utf8");
    out.push({ name, text: full.slice(0, max), total: full.length, cut: full.length > max });
  }
  return out;
}

/** How the prompt names me: the name in people.yaml, else 「TA」. Never a title. */
export const ownerName = () => peopleConf().owner?.name?.trim() || "TA";

export function systemPrompt(o: { files: PromptFile[]; turn: TurnContext; src: string; col: Col; now?: Date }): string {
  const get = (n: string) => {
    const f = o.files.find((x) => x.name === n);
    if (!f) return undefined;
    return f.cut ? `${f.text}\n\n（${n} 超了上限，只载入了前 ${f.text.length} / 共 ${f.total} 字；要看全文用 memory_read。）` : f.text;
  };
  const who = ownerName();
  const mine = o.col === "typed";
  const parts = [
    get("AGENTS.md"),
    get("SOUL.md"),
    get("USER.md") && `# 关于 ${who}（USER.md）\n${get("USER.md")}`,
    get("MEMORY.md") && `# 长期要点索引（MEMORY.md，细节用 memory_read 按需读）\n${get("MEMORY.md")}`,
    mine && get("VOICE.md") && `# 说话的方式（VOICE.md）\n${get("VOICE.md")}`,
    mine && get("self/practice.md") && `# 本月在修的（self/practice.md）\n${get("self/practice.md")}`,
    [
      "# 这一轮",
      `- 来源：${o.src}（渠道 ${o.turn.channel}，${o.turn.surface}）。${mine ? `是 ${who} 亲手发的。` : o.col === "system" ? "不是人打的字，是定时任务、审批、任务或系统事件，按内容处理，必要时告诉 " + who + "。" : `这是别人的对话，不是 ${who} 本人。`}`,
      `- 你的最终回答会自动发回来源；只有要先说一句再干活、或者要分几条发时才用 reply。`,
      `- 每条消息前的 [时:分] 是发送时间，几条连发的合在一起回一次。`,
      `- 以 ${who} 的名义发给别人的，一律用 send：先进审批卡片，批了才原样发出。`,
      `- 现在是 ${(o.now ?? new Date()).toISOString()}。`,
    ].join("\n"),
  ];
  return parts.filter(Boolean).join("\n\n");
}
