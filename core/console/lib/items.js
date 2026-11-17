// Things that show up on several pages: an approval (decide / revise / edit in place), a task (answer / cancel), the
// steps of one run. Console decisions use the card's own rules on the server: owner, version lock, first click wins.

import { $, esc, api, toast, pill, tierDot, mdhm, hm, rel, money, KIND, TIER, ROLE, INPUT, ACTS, openDrawer, busy, pj, mdText, row } from "/lib/core.js";

const changed = () => document.dispatchEvent(new CustomEvent("sbot:changed"));
const who = (a) => a.as === "user" ? "以你的身份" : "bot";
const target = (a) => { const t = a.target ?? {}; return t.chat_name ?? t.name ?? t.user_name ?? ""; };

function expertText(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (x.skipped) return `没经专家把关（${x.skipped}）`;
  return [x.verdict, x.why ?? x.reason, x.suggest ? `建议：${x.suggest}` : ""].filter(Boolean).join("：") || JSON.stringify(x, null, 1);
}

/** one approval; `a` is the server's approvalView */
export function approvalCard(a, o = {}) {
  const open = a.status === "pending";
  const md = a.kind === "proposal" || a.kind === "rollback";
  const editable = open && (a.kind === "send" || a.kind === "plan");
  const revisable = open && (a.kind === "send" || a.kind === "proposal");
  return `<article class="appr${open ? " open" : ""}" id="appr-${a.id}" data-id="${a.id}" data-v="${a.v}">
    <header><div class="inline wrap">${pill(a.status)}<b>${esc(a.title ?? KIND[a.kind] ?? a.kind)}</b></div>
      <div class="sub">#${a.id} · ${esc(KIND[a.kind] ?? a.kind)}${a.kind === "send" ? ` · ${who(a)}发${target(a) ? `到「${esc(target(a))}」` : ""}` : ""} · ${esc(a.requester ?? "")} · ${rel(a.ts)}提交${open && a.expires_at ? ` · ${mdhm(a.expires_at)} 过期` : ""}${a.v > 1 ? ` · 第 ${a.v} 版` : ""}${a.hold ? " · 专家还在看" : ""}</div></header>
    ${a.context && !o.compact ? `<details><summary>当时的上下文</summary><div class="quote text">${esc(a.context)}</div></details>` : ""}
    <div class="draft${md ? "" : " text"}" data-role="draft">${md ? mdText(a.final_text ?? a.draft) : esc(a.final_text ?? a.draft ?? "")}</div>
    ${a.expert ? `<div class="expert"><span class="lbl">专家</span>${esc(expertText(a.expert))}</div>` : ""}
    ${a.checks ? `<details><summary>代码检查</summary><pre class="code">${esc(JSON.stringify(a.checks, null, 1))}</pre></details>` : ""}
    ${a.revise?.length ? `<details${open ? " open" : ""}><summary>改过 ${a.revise.length} 次</summary><ul class="notes">${a.revise.map((n) => `<li><span class="sub">v${n.v} · ${mdhm(n.ts)}</span> ${esc(n.note)}</li>`).join("")}</ul></details>` : ""}
    ${a.kind === "proposal" ? `<div class="sub"><a href="#/self/proposals">在「它自己 › 提案」看完整 diff 和回放</a></div>` : ""}
    ${open ? `
      <label class="sr" for="note-${a.id}">意见</label>
      <textarea id="note-${a.id}" class="note" rows="2" placeholder="${revisable ? "改稿：说怎么改。拒绝：写理由（可不填）" : "拒绝理由（可不填）"}"></textarea>
      <div class="actions">
        <button type="button" class="btn primary" data-act="apprdecide" data-d="approve" data-id="${a.id}">${a.kind === "send" ? `批准，${who(a)}发出` : a.kind === "rollback" ? "回滚" : "批准"}</button>
        ${revisable ? `<button type="button" class="btn" data-act="apprrevise" data-id="${a.id}">按意见改稿</button>` : ""}
        ${editable ? `<button type="button" class="btn" data-act="appredit" data-id="${a.id}">直接改</button>` : ""}
        <button type="button" class="btn danger" data-act="apprdecide" data-d="reject" data-id="${a.id}">${a.kind === "rollback" ? "保留" : "拒绝"}</button>
      </div>
      <div class="sub">${a.card ? "飞书管理群里也有这张卡片，哪边先点算哪边。" : "卡片还没发到飞书。"}</div>`
    : `<div class="sub">${a.decided_at ? `${mdhm(a.decided_at)} 决定` : ""}${a.decide_note ? ` · ${esc(a.decide_note)}` : ""}</div>${a.result ? `<div class="result">${esc(a.result)}</div>` : ""}`}
  </article>`;
}

function replaceCard(a) {
  const el = document.getElementById(`appr-${a.id}`);
  if (el) el.outerHTML = approvalCard(a, { compact: el.closest(".turn") != null });
  changed();
}

ACTS.apprdecide = async (el) => {
  const card = el.closest(".appr"), id = card.dataset.id, v = Number(card.dataset.v), d = el.dataset.d;
  const note = card.querySelector(".note")?.value.trim();
  if (d === "approve" && el.textContent.includes("以你的身份") && !confirm("以你的身份发出这条消息？发出后对方看到的就是你本人。")) return;
  await busy(el, d === "approve" ? "在批…" : "在拒…", async () => {
    const a = await api(`/approval/${id}/decide`, { method: "POST", body: { d, v, note: d === "reject" ? note : undefined } });
    replaceCard(a);
    toast(d === "approve" ? (a.kind === "send" ? "已批准，在发送" : "已批准") : "已拒绝");
  });
};
ACTS.apprrevise = async (el) => {
  const card = el.closest(".appr"), note = card.querySelector(".note")?.value.trim();
  if (!note) { card.querySelector(".note")?.focus(); return toast("先在意见里写怎么改"); }
  await busy(el, "改稿中…", async () => {
    const r = await api(`/approval/${card.dataset.id}/revise`, { method: "POST", body: { note } });
    replaceCard(r.approval);
    if (r.said) toast(r.said, 4000);
  });
};
ACTS.appredit = (el) => {
  const card = el.closest(".appr"), box = card.querySelector("[data-role=draft]");
  if (card.querySelector(".editdraft")) return;
  const text = box.textContent;
  box.hidden = true;
  box.insertAdjacentHTML("afterend", `<div class="editdraft"><label class="sr" for="ed-${card.dataset.id}">草稿</label><textarea id="ed-${card.dataset.id}" rows="${Math.min(16, text.split("\n").length + 2)}">${esc(text)}</textarea>
    <div class="actions"><button type="button" class="btn primary" data-act="apprsave">存为新版本</button><button type="button" class="btn" data-act="apprcancel">不改了</button></div></div>`);
  card.querySelector(".editdraft textarea").focus();
};
ACTS.apprcancel = (el) => { const card = el.closest(".appr"); card.querySelector(".editdraft").remove(); card.querySelector("[data-role=draft]").hidden = false; };
ACTS.apprsave = async (el) => {
  const card = el.closest(".appr"), text = card.querySelector(".editdraft textarea").value;
  await busy(el, "在存…", async () => {
    const a = await api(`/approval/${card.dataset.id}/edit`, { method: "POST", body: { v: Number(card.dataset.v), text } });
    replaceCard(a);
    toast(`存好了，现在是第 ${a.v} 版，还没批`);
  });
};

export async function openApproval(id) {
  const body = openDrawer(`审批 #${id}`);
  body.innerHTML = approvalCard(await api(`/approval/${id}/full`));
}
ACTS.approval = (el) => openApproval(el.dataset.id);

// ───────── tasks ─────────
const OPEN_TASK = ["queued", "running", "waiting_approval", "needs_input", "interrupted"];
export function taskReplyBox(t) {
  if (t.status === "cancelled" || t.status === "waiting_approval") return "";
  return `<div class="reply" data-task="${esc(t.id)}"><label class="sr" for="tr-${esc(t.id)}">回答</label>
    <textarea id="tr-${esc(t.id)}" rows="2" placeholder="${t.status === "needs_input" ? "回答它的问题" : t.status === "running" || t.status === "queued" ? "补一句，这轮结束后带上" : "接着说，它会在同一个会话里继续"}"></textarea>
    <div class="actions"><button type="button" class="btn primary" data-act="taskreply">发给任务</button>${OPEN_TASK.includes(t.status) ? `<button type="button" class="btn danger" data-act="taskcancel">取消任务</button>` : ""}</div></div>`;
}
ACTS.taskreply = async (el) => {
  const box = el.closest(".reply"), ta = box.querySelector("textarea");
  if (!ta.value.trim()) return ta.focus();
  await busy(el, "在发…", async () => {
    const r = await api(`/task/${encodeURIComponent(box.dataset.task)}/reply`, { method: "POST", body: { text: ta.value } });
    ta.value = ""; toast(r.result, 4000); changed();
  });
};
ACTS.taskcancel = async (el) => {
  const id = el.closest(".reply").dataset.task;
  if (!confirm(`取消任务 #${id}？`)) return;
  const r = await api(`/task/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  toast(r.result, 4000); changed();
};

export async function openTask(id) {
  const body = openDrawer(`任务 #${id}`);
  const d = await api(`/task/${encodeURIComponent(id)}`);
  const t = d.task, res = pj(t.result_json);
  body.innerHTML = `
    <div class="card"><div class="inline wrap">${tierDot(t.tier)}${pill(t.status)}<span class="sub">${esc(TIER[t.tier] ?? t.tier ?? "")}${t.repo ? ` · 仓库 ${esc(t.repo)}` : ""} · ${mdhm(t.ts)} · ${d.usage.calls} 次调用 · ${money(d.usage.cost)}</span></div>
      <div class="text" style="margin-top:6px">${esc(t.goal)}</div>
      ${t.question ? `<div class="ask"><span class="lbl">在问你</span>${esc(t.question)}</div>` : ""}${t.error ? `<div class="err">${esc(t.error)}</div>` : ""}
      ${taskReplyBox(t)}</div>
    ${res ? `<section><h3>报告</h3><div class="card text">${esc(res.conclusion ?? res.summary ?? JSON.stringify(res, null, 1))}</div></section>` : ""}
    <section><h3>运行</h3><div class="list">${d.runs.map((r) => row(r.id, `${mdhm(r.started)} → ${r.ended ? hm(r.ended) : "…"}${r.error ? ` · ${r.error}` : ""}`, pill(r.status), `data-href="#/sessions/${encodeURIComponent(`task:${t.id}`)}"`)).join("") || `<div class="empty">（还没跑）</div>`}</div></section>
    ${d.approvals.length ? `<section><h3>审批</h3><div class="list">${d.approvals.map((a) => row(`#${a.id} ${a.title ?? a.kind}`, mdhm(a.ts), pill(a.status), `data-act="approval" data-id="${a.id}"`)).join("")}</div></section>` : ""}`;
}
ACTS.task = (el) => openTask(el.dataset.id);

// ───────── one run's steps (from the pi session file) ─────────
export function stepsHtml(steps, role) {
  if (!steps.length) return `<div class="empty">${role === "worker" ? "任务的过程在飞书工作台的话题里。" : "没找到会话记录（起草和夜间整理不走会话文件）。"}</div>`;
  return steps.map((s) => {
    if (s.kind === "usage") return `<div class="sub usage">${esc(s.text)}</div>`;
    const label = s.kind === "thinking" ? "思考" : s.kind === "call" ? `调用 ${s.tool}` : s.kind === "result" ? `${s.tool ?? "工具"} 返回${s.error ? "（出错）" : ""}` : s.role === "user" ? "给模型的输入" : "模型回复";
    const body = `<div class="body">${esc(s.text)}</div>`;
    if (s.kind === "thinking" || s.kind === "call" || s.kind === "result" || (s.role === "user" && s.text.length > 400))
      return `<details class="step ${s.kind} ${s.role}${s.error ? " bad" : ""}"><summary>${esc(label)} <span class="sub">${hm(s.ts)} · ${s.text.length} 字</span></summary>${body}</details>`;
    return `<div class="step ${s.kind} ${s.role}"><div class="lbl">${esc(label)} · ${hm(s.ts)}</div>${body}</div>`;
  }).join("");
}

export const inputLabel = (x) => `${INPUT[x.kind] ?? x.kind}${x.source && x.source !== x.kind && x.kind !== "user" ? ` · ${x.source}` : ""}`;
export const runLabel = (r) => `${ROLE[r.role] ?? r.role}`;
