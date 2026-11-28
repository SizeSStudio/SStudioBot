// Feishu card JSON 2.0 (update_multi) for the channel-neutral Card model (03 「approvals」), plus the builders the
// Feishu-only cards (group switches, review) use. Builders copied from core/src/cards.ts. Message and mail text that
// ends up in a card is untrusted: it is quoted and cut, never used as card structure.
import type { Card } from "../types.ts";

export type FeishuCard = Record<string, unknown>;
export type Color = "blue" | "green" | "red" | "grey" | "orange" | "yellow" | "wathet" | "turquoise";

export function card(o: { title: string; subtitle?: string; color: Color; tag?: [string, Color]; summary?: string; elements: unknown[] }): FeishuCard {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: o.summary ?? o.title } },
    header: {
      title: { tag: "plain_text", content: o.title },
      ...(o.subtitle ? { subtitle: { tag: "plain_text", content: o.subtitle } } : {}),
      template: o.color,
      ...(o.tag ? { text_tag_list: [{ tag: "text_tag", text: { tag: "plain_text", content: o.tag[0] }, color: o.tag[1] }] } : {}),
    },
    body: { direction: "vertical", vertical_spacing: "10px", elements: o.elements },
  };
}

export const md = (content: string, grey = false) => ({ tag: "markdown", content: grey ? `<font color='grey'>${content}</font>` : content });
export const button = (text: string, value: Record<string, unknown>, type: "primary_filled" | "danger" | "default" = "default") =>
  ({ tag: "button", text: { tag: "plain_text", content: text }, type, width: "fill", behaviors: [{ type: "callback", value }] });
export const buttons = (...bs: unknown[]) => ({
  tag: "column_set", flex_mode: "none", horizontal_spacing: "8px",
  columns: bs.map((b) => ({ tag: "column", width: "weighted", weight: 1, elements: [b] })),
});
export const quote = (s: string, max = 600) => (s.length > max ? s.slice(0, max) + "…" : s).split("\n").map((l) => `> ${l}`).join("\n");

const fence = (kind: string, text: string) => "```" + (kind === "diff" ? "diff" : "") + "\n" + text.replace(/```/g, "ˋˋˋ") + "\n```";

/** Card → Feishu JSON. Each option is a button carrying {...card.value, o: option.id}. */
export function renderCard(c: Card): FeishuCard {
  const els: unknown[] = c.lines.map((l) => md(l));
  if (c.detail) {
    const body = md(fence(c.detail.kind, c.detail.text.length > 4000 ? c.detail.text.slice(0, 4000) + "\n…" : c.detail.text));
    els.push(c.detail.folded
      ? { tag: "collapsible_panel", expanded: false, header: { title: { tag: "plain_text", content: "详情" } }, elements: [body] }
      : body);
  }
  if (c.question) els.push(md(`**${c.question}**`));
  if (c.options.length) {
    els.push(buttons(...c.options.map((o) => button(o.cost ? `${o.label}（${o.cost}）` : o.label, { ...(c.value ?? {}), o: o.id },
      o.recommended ? "primary_filled" : "default"))));
  }
  return card({ title: c.title, color: c.tone ?? "blue", elements: els });
}

/** the post body for a markdown text message */
export const postContent = (text: string) => JSON.stringify({ zh_cn: { content: [[{ tag: "md", text }]] } });

/** `content` of an incoming message → plain text (text and post; other types become a [type] marker) */
export function contentText(type: string | undefined, content: string | undefined): string {
  if (!content) return "";
  let j: any;
  try { j = JSON.parse(content); } catch { return content; }
  if (type === "text" || (j && typeof j.text === "string")) return String(j.text ?? "").trim();
  if (type === "post") {
    const body = j.content ? j : j.zh_cn ?? j.en_us ?? Object.values(j)[0];
    const rows: any[][] = Array.isArray(body?.content) ? body.content : [];
    const text = rows.map((r) => (Array.isArray(r) ? r : []).map((n) => n?.text ?? (n?.tag === "at" ? `@${n.user_name ?? ""}` : "")).join("")).join("\n");
    return [body?.title, text].filter(Boolean).join("\n").trim();
  }
  return `[${type ?? "message"}]`;
}
