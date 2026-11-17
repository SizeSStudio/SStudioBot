// 生活 (owner-only, §15): the timeline with a quick note, matters, outlooks and how they turned out, habits and rhythms
// (only he endorses or drops them), readings, reviews, and his birth info (self.yaml, edited here and nowhere else).

import { $, $$, esc, api, toast, pill, row, rel, hm, mdhm, isoDay, dayLabel, empty, loading, tabs, chips, mdText, busy, busyTyping, ACTS, openDrawer } from "/lib/core.js";
import { mountEditor } from "/lib/editor.js";
import "/lib/items.js";   // ACTS.task / ACTS.approval for links inside drawers

const TABS = { timeline: "时间线", matters: "事", outlooks: "前瞻", self: "习气与节律", readings: "解读", reviews: "复盘", birth: "出生信息" };
const KIND_ZH = { said: "他说", said_group: "群里说", note: "随手记", sent: "代发", approval: "审批", task: "任务", matter: "事", outlook: "前瞻", revisit: "回看", review: "复盘" };
const HORIZON = { day: "当天", week: "本周", month: "本月", matter: "这件事" };
const REVIEW_KIND = { day: "日复盘", week: "周复盘", month: "月复盘", matter: "事后复盘" };
const st = { tab: "", meta: null, tl: { days: 7, kind: "", domain: "", q: "" }, editor: null };

export async function render(main, args) {
  st.meta ??= await api("/life/meta");
  main.innerHTML = `<div class="page" id="life"><div class="page-head"><h1>生活</h1><span class="sub">只有你看得到；飞书里只说一两句</span></div><div id="lifetabs"></div><div id="lifebody"></div></div>`;
  st.tab = "";
  await update(args);
}

export async function update(args) {
  const tab = TABS[args[0]] ? args[0] : "timeline";
  if (tab === st.tab) return;
  if (st.editor?.dirty() && !confirm("出生信息有没保存的改动，离开就丢了。离开？")) { history.back(); return; }
  st.tab = tab; st.editor = null;
  $("#lifetabs").innerHTML = tabs(TABS, tab, "#/life");
  const body = $("#lifebody");
  body.innerHTML = loading();
  await PAGES[tab](body);
}

export function onFlow() {
  if (st.tab === "timeline" && !busyTyping($("#lifebody"))) drawTimeline();
}

const domainTag = (d) => d ? `<span class="tag">${esc(st.meta.domains[d] ?? d)}</span>` : "";
const domainOptions = (cur, none) => `<option value="">${esc(none)}</option>${Object.entries(st.meta.domains).map(([key, v]) => `<option value="${key}"${cur === key ? " selected" : ""}>${esc(v)}</option>`).join("")}`;

// ───────── 时间线 + 随手记 ─────────
const PAGES = {};
PAGES.timeline = async (body) => {
  const f = st.tl;
  body.innerHTML = `
    <form class="card note-form" id="noteform">
      <label for="notetext" class="lbl">随手记</label>
      <textarea id="notetext" rows="2" placeholder="想到什么记什么：一句话、一件小事、一个感觉。只进时间线和夜间整理，不会回你消息。"></textarea>
      <div class="inline wrap"><label class="sr" for="notedomain">归到</label><select id="notedomain">${domainOptions("", "不归类")}</select>
        <span class="grow"></span><button type="submit" class="btn primary">记下</button></div>
    </form>
    <div class="filters">
      ${chips({ 1: "今天", 7: "7 天", 30: "30 天", 90: "90 天" }, String(f.days), "tldays")}
      <div class="inline wrap">
        <label class="sr" for="tlkind">类型</label><select id="tlkind"><option value="">全部类型</option>${Object.entries(KIND_ZH).map(([key, v]) => `<option value="${key}"${f.kind === key ? " selected" : ""}>${v}</option>`).join("")}</select>
        <label class="sr" for="tldomain">领域</label><select id="tldomain">${domainOptions(f.domain, "全部领域")}</select>
        <label class="sr" for="tlq">搜索</label><input type="search" id="tlq" placeholder="搜文字" value="${esc(f.q)}" data-keep="0">
      </div>
    </div>
    <div id="tllist">${loading()}</div>`;
  $("#noteform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ta = $("#notetext"), btn = e.submitter ?? $("#noteform button[type=submit]");
    if (!ta.value.trim()) return ta.focus();
    await busy(btn, "在记…", async () => {
      await api("/life/note", { method: "POST", body: { text: ta.value, domain: $("#notedomain").value || undefined } });
      ta.value = ""; toast("记下了"); drawTimeline();
    });
  });
  $("#notetext").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("#noteform").requestSubmit(); });
  $("#tlkind").addEventListener("change", (e) => { f.kind = e.target.value; drawTimeline(); });
  $("#tldomain").addEventListener("change", (e) => { f.domain = e.target.value; drawTimeline(); });
  let t; $("#tlq").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); drawTimeline(); }, 300); });
  await drawTimeline();
};
ACTS.tldays = (el) => { st.tl.days = Number(el.dataset.f); for (const b of $$("[data-act=tldays]")) b.setAttribute("aria-pressed", String(b === el)); drawTimeline(); };

async function drawTimeline() {
  const f = st.tl, qs = new URLSearchParams({ days: f.days, ...(f.kind && { kinds: f.kind }), ...(f.domain && { domain: f.domain }), ...(f.q && { q: f.q }) });
  const d = await api(`/life/timeline?${qs}`);
  const list = $("#tllist");
  if (!list) return;
  const rows = d.rows.slice().reverse();   // newest first
  let html = "", day = "";
  for (const r of rows) {
    const dd = isoDay(r.ts);
    if (dd !== day) { if (day) html += "</ol>"; day = dd; html += `<h2 class="day">${esc(dayLabel(r.ts))}</h2><ol class="tl">`; }
    html += `<li class="tl-item k-${esc(r.kind)}"><time class="sub tabular" datetime="${new Date(r.ts).toISOString()}">${hm(r.ts)}</time>
      <div class="main"><div class="inline wrap"><span class="tag">${esc(KIND_ZH[r.kind] ?? r.kind)}</span>${domainTag(r.domain)}${r.matter_id ? `<button type="button" class="tag link" data-act="matter" data-id="${r.matter_id}">事 #${r.matter_id}</button>` : ""}</div>
      <div class="text">${esc(r.text)}</div></div></li>`;
  }
  if (day) html += "</ol>";
  list.innerHTML = (html || empty("这段时间没有记录。")) + (d.truncated ? `<div class="sub center">只显示最近 500 条，缩短时间或加筛选看更早的。</div>` : "");
}

// ───────── 事 ─────────
const OPEN_M = ["open", "active", "closing"];
PAGES.matters = async (body) => {
  const ms = await api("/life/matters");
  const card = (m) => row(`#${m.id} ${m.title ?? "（没标题）"}`, [st.meta.domains[m.domain] ?? m.domain, m.opened_at && `${mdhm(m.opened_at)} 开始`, m.closed_at && `${mdhm(m.closed_at)} 收`, m.close_condition && `收的条件：${m.close_condition}`,
    m.tasks && `${m.tasks} 个任务`, m.followups && `${m.followups} 个待跟进`, m.readings && `${m.readings} 次解读`].filter(Boolean).join(" · "), pill(m.status), `data-act="matter" data-id="${m.id}"`);
  const open = ms.filter((m) => OPEN_M.includes(m.status)), closed = ms.filter((m) => !OPEN_M.includes(m.status));
  body.innerHTML = (open.length ? `<section><h2>在办 <span class="sub">${open.length}</span></h2><div class="list">${open.map(card).join("")}</div></section>` : "") +
    (closed.length ? `<section><h2>收了的</h2><div class="list">${closed.map(card).join("")}</div></section>` : "") || empty("还没有「事」。对话里说「开一件事」，或它觉得一件事要跟一阵时会提议。");
};
ACTS.matter = async (el) => {
  const box = openDrawer(`事 #${el.dataset.id}`);
  const m = await api(`/life/matter/${el.dataset.id}`);
  box.innerHTML = `
    <div class="card"><div class="inline wrap">${pill(m.status)}<b>${esc(m.title ?? "")}</b>${domainTag(m.domain)}</div>
      <div class="sub">${m.opened_at ? `${mdhm(m.opened_at)} 开始` : ""}${m.closed_at ? ` · ${mdhm(m.closed_at)} 收` : ""}${m.close_condition ? ` · 收的条件：${esc(m.close_condition)}` : ""}</div></div>
    ${m.text ? `<section><h3>这件事的页面</h3><div class="card">${mdText(m.text)}</div></section>` : ""}
    ${m.tasks.length ? `<section><h3>任务</h3><div class="list">${m.tasks.map((t) => row(`#${t.id} ${t.goal}`, mdhm(t.ts), pill(t.status), `data-act="task" data-id="${esc(t.id)}"`)).join("")}</div></section>` : ""}
    ${m.followups.length ? `<section><h3>跟进</h3><div class="list">${m.followups.map((t) => row(t.note ?? "（跟进）", mdhm(t.due_at), pill(t.status))).join("")}</div></section>` : ""}
    <section><h3>时间线</h3>${m.timeline.length ? `<ol class="tl">${m.timeline.slice().reverse().map((r) => `<li class="tl-item"><time class="sub tabular">${mdhm(r.ts)}</time><div class="main"><span class="tag">${esc(KIND_ZH[r.kind] ?? r.kind)}</span><div class="text">${esc(r.text)}</div></div></li>`).join("")}</ol>` : empty("（还没有）")}</section>`;
};

// ───────── 前瞻 ─────────
PAGES.outlooks = async (body) => {
  const os = await api("/life/outlooks");
  const by = new Map();
  for (const o of os) { const key = `${o.horizon}|${o.period}`; if (!by.has(key)) by.set(key, []); by.get(key).push(o); }
  body.innerHTML = by.size ? `<div class="sub">前瞻写下后不改；回看是后来追加的，记的是你当时的感受。</div>` + [...by].map(([key, list]) => {
    const [h, p] = key.split("|");
    return `<section><h2>${esc(HORIZON[h] ?? h)} <span class="sub">${esc(p)}</span></h2>${list.map((o) => `<article class="card outlook">
      <div class="text">${esc(o.text)}</div>
      <div class="sub">${mdhm(o.ts)} 写下${o.look_for ? ` · 到时留意：${esc(o.look_for)}` : ""}${o.revisit_at ? ` · ${esc(o.revisit_at)} 回看` : ""}${o.why_refs?.length ? ` · 依据 ${esc(o.why_refs.join("、"))}` : ""}</div>
      ${o.revisits.length ? `<ul class="notes">${o.revisits.map((r) => `<li><span class="sub">${mdhm(r.ts)} 回看</span> ${esc(r.text)}</li>`).join("")}</ul>` : `<div class="sub">还没回看</div>`}
    </article>`).join("")}</section>`;
  }).join("") : empty("还没有前瞻。早报和周初会写；写下后不改。");
};

// ───────── 习气与节律 ─────────
PAGES.self = async (body) => {
  const d = await api("/life/self");
  const n = d.noticings30, o = n.owner ?? 0, a = n.agent ?? 0;
  const groups = { habit: "习气", rhythm: "节律" };
  const order = { candidate: 0, endorsed: 1, seeing_off: 2, dropped: 3 };
  body.innerHTML = `
    <div class="card"><b>谁先看见</b> <span class="sub">近 30 天</span>
      <div class="sub">你自己先说出来 ${o} 次，它先指出来 ${a} 次。${o + a ? (o >= a ? "多数是你自己先看见的。" : "它先指出来的多一些。") : "还没有记录。"}</div></div>
    ${Object.entries(groups).map(([kind, label]) => {
      const items = d.items.filter((x) => x.kind === kind).sort((x, y) => order[x.status] - order[y.status] || y.id - x.id);
      return `<section><h2>${label} <span class="sub">${items.length}</span></h2>${items.map(selfCard).join("") || empty(kind === "habit" ? "还没有候选。夜间整理看到有证据的模式会提出来，只有你能认可或放下。" : "还没有节律候选。")}</section>`;
    }).join("")}`;
};
function selfCard(x) {
  const btn = (status, label, cls = "") => x.status === status ? "" : `<button type="button" class="btn small ${cls}" data-act="selfmark" data-id="${x.id}" data-s="${status}">${label}</button>`;
  return `<article class="card selfitem" id="self-${x.id}">
    <div class="inline wrap">${pill(x.status)}<span class="text grow">${esc(x.text)}</span></div>
    <div class="sub">${x.first_seen ? `${mdhm(x.first_seen)} 第一次看到` : ""}${x.last_seen ? ` · 最近 ${rel(x.last_seen)}` : ""}${x.owner_said ? " · 你说过" : ""}${x.noticed.owner || x.noticed.agent ? ` · 你先看见 ${x.noticed.owner ?? 0} 次、它先 ${x.noticed.agent ?? 0} 次` : ""}${x.note ? ` · ${esc(x.note)}` : ""}</div>
    ${x.evidence.length ? `<details><summary>证据 ${x.evidence.length} 条</summary><ul class="notes">${x.evidence.map((e) => `<li>${esc(typeof e === "string" ? e : JSON.stringify(e))}</li>`).join("")}</ul></details>` : ""}
    <div class="actions">${btn("endorsed", "认可", "primary")}${btn("seeing_off", "送一程")}${btn("dropped", "放下", "danger")}${x.status !== "candidate" ? btn("candidate", "回到候选") : ""}</div>
  </article>`;
}
ACTS.selfmark = async (el) => {
  const s = el.dataset.s;
  const note = s === "dropped" ? prompt("放下的原因（可不填）") : "";
  if (note === null) return;
  await busy(el, "…", async () => {
    const r = await api(`/life/self/${el.dataset.id}`, { method: "POST", body: { status: s, note: note || undefined } });
    toast(r.result, 3000);
    await PAGES.self($("#lifebody"));
  });
};

// ───────── 解读 ─────────
PAGES.readings = async (body) => {
  const rs = await api("/life/readings");
  body.innerHTML = rs.length ? `<div class="sub">镜头是一种看法，写下后不改；回看追加你的感受。</div><div class="list">${rs.map((r) =>
    row(`${r.lensZh}${r.method ? ` · ${r.method}` : ""}${r.question ? `：${r.question}` : r.period ? ` · ${r.period}` : ""}`,
      `${mdhm(r.ts)}${r.matter_id ? ` · 事 #${r.matter_id}` : ""}${r.claims ? ` · ${r.claims} 条留意点` : ""}${r.revisits ? ` · 回看 ${r.revisits} 次` : ""}${r.error ? ` · ${r.error}` : ""}`,
      pill(r.status), r.status === "done" ? `data-act="reading" data-id="${r.id}"` : "")).join("")}</div>` : empty("还没有解读。对话里说「起一卦」或「看看这个月」。");
};
ACTS.reading = async (el) => {
  const box = openDrawer(`解读 #${el.dataset.id}`);
  const r = await api(`/life/reading/${el.dataset.id}`);
  box.innerHTML = `<div class="sub">${esc(st.meta.lenses[r.lens] ?? r.lens)}${r.profile_version ? ` · 档案版本 ${esc(r.profile_version)}` : ""}${r.chart_ref ? ` · ${esc(r.chart_ref)}` : ""}</div><div class="card">${mdText(r.text)}</div>`;
};

// ───────── 复盘 ─────────
PAGES.reviews = async (body) => {
  const rs = await api("/life/reviews");
  body.innerHTML = rs.length ? `<div class="list">${rs.map((r) => row(`${REVIEW_KIND[r.kind] ?? r.kind} · ${r.period}`, `${mdhm(r.ts)}${r.matter_id ? ` · 事 #${r.matter_id}` : ""}`, pill(r.status), `data-act="review" data-id="${r.id}"`)).join("")}</div>`
    : empty("还没有复盘。");
};
ACTS.review = async (el) => {
  const box = openDrawer(`复盘 #${el.dataset.id}`);
  const r = await api(`/life/review/${el.dataset.id}`);
  box.innerHTML = `<div class="inline wrap">${pill(r.status)}<span class="sub">${esc(REVIEW_KIND[r.kind] ?? r.kind)} · ${esc(r.period)} · ${mdhm(r.ts)}</span></div>
    ${r.text ? `<div class="card">${mdText(r.text)}</div>` : `
      ${r.facts ? `<section><h3>事实</h3><div class="card text">${esc(r.facts)}</div></section>` : ""}
      ${r.owner_words ? `<section><h3>你说的</h3><div class="card text">${esc(r.owner_words)}</div></section>` : ""}
      ${r.agent_notes ? `<section><h3>它的笔记</h3><div class="card text">${esc(r.agent_notes)}</div></section>` : ""}`}`;
};

// ───────── 出生信息 (self.yaml) ─────────
PAGES.birth = async (body) => {
  body.innerHTML = `<div class="card note"><b>只在这里填。</b><div class="sub">出生时间、地点这些只存在 VPS 的 config/self.yaml，不进飞书、不进对话上下文；只有解读时交给离线的镜头任务。改了以后管理群只会收到「self.yaml 改了」，不显示内容。</div></div><div id="birthed"></div>`;
  st.editor = await mountEditor($("#birthed"), "self.yaml", { private: true, note: "格式见 DESIGN §15.9：birth（日期、时间、地点、性别）、lens、month_rhythm、送一程阈值。" });
};
