// 待办: everything that is waiting on Size, workable in place. Approvals (approve / revise / edit / reject), events
// that ask him to answer or decide, tasks waiting for an answer, Sentinel alerts, failed jobs and failed sends; what
// was decided lately at the bottom.

import { $, esc, api, toast, pill, row, rel, mdhm, loading, busyTyping, ACTS, busy, KIND } from "/lib/core.js";
import { approvalCard, taskReplyBox, eventCard } from "/lib/items.js";

export async function render(main) {
  main.innerHTML = `<div class="page narrow" id="inbox"><div class="page-head"><h1>待办</h1><span class="sub" id="ibcount"></span>
    <button type="button" class="btn small" id="ibstale" data-act="ibrefresh" hidden>有新变化 · 刷新</button></div><div id="ibbody">${loading()}</div></div>`;
  await draw(true);
}
export const onFlow = () => draw(false);
ACTS.ibrefresh = () => draw(true);

async function draw(force) {
  const body = $("#ibbody");
  if (!body) return;
  if (!force && busyTyping(body)) { $("#ibstale").hidden = false; return; }   // he's writing a note: don't pull the card away
  const d = await api("/inbox");
  if (!$("#ibbody")) return;
  $("#ibstale").hidden = true;
  const n = d.approvals.length + d.asks.length + d.tasks.length + d.alerts.length + d.jobs.length + d.outbox.length;
  $("#ibcount").textContent = n ? `${n} 件等你` : "都清了";
  const sec = (title, html, note = "") => html ? `<section><h2>${esc(title)}${note ? ` <span class="sub">${esc(note)}</span>` : ""}</h2>${html}</section>` : "";
  body.innerHTML = [
    sec("等你批", d.approvals.map((a) => approvalCard(a)).join(""), d.approvals.length > 1 ? `${d.approvals.length} 条` : ""),
    // §读2.5: asks from groups, DMs and sources; your next word in that place closes them on its own
    sec("要你回 / 拍板", d.asks.map((e) => eventCard(e)).join(""), "你在原处说过话就自动算处理了"),
    sec("任务在等你", d.tasks.map((t) => `<article class="card taskask">
      <div class="inline wrap">${pill(t.status)}<b class="clip" data-act="task" data-id="${esc(t.id)}" role="button" tabindex="0">任务 #${esc(t.id)}</b><span class="sub">${rel(t.ts)}</span></div>
      <div class="sub clip">${esc(t.goal)}</div>
      ${t.question ? `<div class="ask"><span class="lbl">它问</span>${esc(t.question)}</div>` : t.status === "interrupted" ? `<div class="ask"><span class="lbl">中断</span>${esc(t.error ?? "跑到一半停了（重启或出错），说一句它就接着跑")}</div>` : ""}
      ${taskReplyBox(t)}</article>`).join("")),
    sec("巡检在报", d.alerts.length ? `<div class="list">${d.alerts.map((f) => row(f.text, `${rel(f.since)}开始`, pill("serious", "在报"))).join("")}</div>` : "", d.sentinelAt ? `上次巡检 ${rel(d.sentinelAt)}` : ""),
    sec("定时任务出了问题", d.jobs.length ? `<div class="list">${d.jobs.map((j) => row(j.name, `${mdhm(j.last.at)} · ${j.last.err ?? j.last.outcome}`, `${pill(String(j.last.outcome).split(" ")[0])} <button type="button" class="btn small" data-act="ibrunjob" data-name="${esc(j.name)}">重跑</button>`)).join("")}</div>` : ""),
    sec("没发出去的", d.outbox.length ? `<div class="list">${d.outbox.map((o) => row(o.text, `${mdhm(o.ts)} · ${o.channel}${o.error ? ` · ${o.error}` : ""}`, pill(o.status), o.approval_id ? `data-act="approval" data-id="${o.approval_id}"` : "")).join("")}</div>` : ""),
  ].join("") || `<div class="clear"><b>都清了</b><div class="sub">没有要批的、没有任务在等你，巡检也没在报。</div></div>`;
  if (d.recent.length) body.insertAdjacentHTML("beforeend", `<section><h2>最近两天处理过的</h2><div class="list">${d.recent.map((a) =>
    row(`#${a.id} ${a.title ?? KIND[a.kind] ?? a.kind}`, `${mdhm(a.decided_at)}${a.decide_note ? ` · ${a.decide_note}` : ""}${a.result ? ` · ${a.result}` : ""}`, pill(a.status), `data-act="approval" data-id="${a.id}"`)).join("")}</div></section>`);
}

ACTS.ibrunjob = (el) => busy(el, "在跑…", async () => { const r = await api(`/jobs/${el.dataset.name}/run`, { method: "POST" }); toast(r.result, 4000); draw(true); });
