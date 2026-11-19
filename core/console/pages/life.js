// 生活 (owner-only, §15): the timeline with a quick note, matters with their events (§17.2) and the topics that may
// become one, the people around him and how they connect (§18), imports from another harness (§17.4), outlooks and how they turned out, habits and rhythms (only he
// endorses or drops them), readings, reviews, and his birth info and lens settings (self.yaml: a form here; he can also tell the main agent in his DM).

import { $, $$, esc, api, toast, pill, row, rel, hm, mdhm, isoDay, dayLabel, empty, loading, tabs, chips, mdText, busy, busyTyping, jobWhen, ACTS, openDrawer } from "/lib/core.js";
import { mountEditor } from "/lib/editor.js";
import { eventCard } from "/lib/items.js";   // also ACTS.task / ACTS.approval for links inside drawers
import { peopleTab, yinyuanTab } from "/lib/people.js";   // also ACTS.person for links inside drawers

const TABS = { timeline: "时间线", matters: "事", people: "人", yinyuan: "因缘", imports: "导入", outlooks: "前瞻", self: "习气与节律", readings: "解读", reviews: "复盘", birth: "出生信息" };
const KIND_ZH = { said: "他说", said_group: "群里说", note: "随手记", sent: "代发", approval: "审批", task: "任务", matter: "事", outlook: "前瞻", revisit: "回看", review: "复盘", event: "事件" };
const HORIZON = { day: "当天", week: "本周", month: "本月", matter: "这件事" };
const REVIEW_KIND = { day: "日复盘", week: "周复盘", month: "月复盘", matter: "事后复盘" };
const st = { tab: "", meta: null, tl: { days: 7, kind: "", domain: "", q: "" }, editor: null };

export async function render(main, args) {
  st.meta ??= await api("/life/meta");
  main.innerHTML = `<div class="page" id="life"><div class="page-head"><h1>生活</h1><span class="sub">你的私人内容，只给你看：这里和你跟它的私聊</span></div><div id="lifetabs"></div><div id="lifebody"></div></div>`;
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

// ───────── 事 + 话头 ─────────
const OPEN_M = ["open", "active", "closing"];
const EV_LEVEL = { fyi: "知道就行", watch: "要盯", reply: "要你回", decide: "要你拍板" };
const EV_KIND = { ask: "找他", decision: "定了", commitment: "答应", progress: "进展", risk: "风险", deadline: "时间点", info: "信息" };
const EV_DONE = { done: "处理了", dropped: "不用了" };
PAGES.matters = async (body) => {
  const [ms, tps, rv] = await Promise.all([api("/life/matters"), api("/life/topics"), api("/life/review")]);
  st.openMatters = ms.filter((m) => OPEN_M.includes(m.status));
  const openIds = new Set(st.openMatters.map((m) => m.id));
  // 主线 are what he follows; 子事 fold under them, and one whose 主线 has closed stands on its own
  st.mains = st.openMatters.filter((m) => !m.parent_id || !openIds.has(m.parent_id));
  const kidsOf = (id) => st.openMatters.filter((m) => m.parent_id === id);
  const card = (m) => row(`#${m.id} ${m.title ?? "（没标题）"}`, [st.meta.domains[m.domain] ?? m.domain, m.merged_into && `并进了 #${m.merged_into}`, m.opened_at && `${mdhm(m.opened_at)} 开始`, m.closed_at && `${mdhm(m.closed_at)} 收`, m.close_condition && `收的条件：${m.close_condition}`,
    m.asks && `${m.asks} 条等你`, m.events && `${m.events} 条事件`, m.last_event && `最近 ${rel(m.last_event)}`, m.keys?.length && `又叫 ${m.keys.slice(0, 3).join("、")}`,
    m.tasks && `${m.tasks} 个任务`, m.followups && `${m.followups} 个待跟进`, m.readings && `${m.readings} 次解读`].filter(Boolean).join(" · "), pill(m.status), `data-act="matter" data-id="${m.id}"`);
  const topic = (t) => row(t.topic, [`${t.n} 条`, t.where.length && `在 ${t.where.join("、")}`, t.open && `${t.open} 条等你`, `最近 ${rel(t.last)}`].filter(Boolean).join(" · "), "", `data-act="topic" data-t="${esc(t.topic)}"`);
  const main = (m) => { const k = kidsOf(m.id); return card(m) + (k.length ? `<details class="kids"><summary class="sub">下面 ${k.length} 件子事</summary><div class="list">${k.map(card).join("")}</div></details>` : ""); };
  const open = st.mains, subs = st.openMatters.length - open.length, closed = ms.filter((m) => !OPEN_M.includes(m.status));
  body.innerHTML = reviewHtml(rv) + (open.length ? `<section><h2>在办 <span class="sub">${open.length} 条主线${subs ? `，${subs} 件子事` : ""}</span></h2><div class="list">${open.map(main).join("")}</div></section>` : "") +
    (tps.length ? `<section><h2>话头 <span class="sub">近两周反复说到、还没挂到事上的</span></h2><div class="list">${tps.map(topic).join("")}</div></section>` : "") +
    (closed.length ? `<section><h2>收了的</h2><div class="list">${closed.map(card).join("")}</div></section>` : "") + opsHtml(rv.ops) || empty("还没有「事」。对话里说「开一件事」，或它觉得一件事要跟一阵时会提议；也可以从「导入」把以前的事搬进来。");
};
// 每日整理 (§15.14): suggestions only; a button here is the same as the one on the card
const reviewItem = (r) => `<div class="card"><div class="inline wrap"><span class="tag">${esc(r.kind_zh)}</span><span>${esc(r.text)}</span></div>${r.why ? `<div class="sub">${esc(r.why)}</div>` : ""}
  <div class="actions">${r.options.length ? r.options.map((o, i) => `<button type="button" class="btn small${i ? "" : " primary"}" data-act="mrdo" data-id="${r.id}" data-a="${esc(o.a)}">${esc(o.label)}</button>`).join("")
    : r.status === "acted" || r.status === "ok" ? `<span class="sub">✓ ${esc(r.done_zh ?? "好")}</span><button type="button" class="btn small" data-act="mrdo" data-id="${r.id}" data-a="undo">撤销</button>` : ""}</div></div>`;
function reviewHtml(rv) {
  if (!rv.today.length && !rv.queue.length) return "";
  const rest = rv.queue.filter((r) => !rv.today.some((t) => t.id === r.id));
  return `<section><h2>今天的整理 <span class="sub">点了才改，改的都能撤销</span></h2>${rv.today.map(reviewItem).join("") || `<div class="sub">今天没有挑出来的。</div>`}
    ${rest.length ? `<details class="kids"><summary class="sub">还有 ${rv.waiting} 条在排队${rv.resting ? `，${rv.resting} 条先放着` : ""}</summary>${rest.map(reviewItem).join("")}</details>` : ""}</section>`;
}
const opLine = (o) => `<li class="tl-item"><time class="sub tabular">${mdhm(o.ts)}</time><div class="main"><div class="text">${esc(o.summary ?? o.kind)}</div>
  <div class="inline wrap"><span class="sub">${esc([o.by, o.why].filter(Boolean).join(" · "))}${o.undone_at ? " · 已撤销" : ""}</span>${o.undone_at ? "" : `<button type="button" class="btn small" data-act="opundo" data-id="${o.id}">撤销</button>`}</div></div></li>`;
const opsHtml = (ops) => ops.length ? `<section><details class="kids"><summary><b>改动记录</b> <span class="sub">${ops.length}</span></summary><ol class="tl">${ops.map(opLine).join("")}</ol></details></section>` : "";
const refreshMatters = () => { if (st.tab === "matters") return PAGES.matters($("#lifebody")); };
ACTS.mrdo = (el) => busy(el, "…", async () => { await api(`/life/review/${el.dataset.id}`, { method: "POST", body: { a: el.dataset.a } }); toast(el.dataset.a === "undo" ? "撤销了，一个月内不再问这条" : "好了"); await refreshMatters(); });
ACTS.opundo = (el) => busy(el, "…", async () => { await api(`/life/op/${el.dataset.id}/undo`, { method: "POST", body: {} }); toast("撤销了"); await refreshMatters(); });
ACTS.regroup = (el) => busy(el, "…", async () => {
  const id = el.dataset.id, action = el.dataset.how, target = action === "detach" ? undefined : Number($("#mrtarget")?.value);
  if (action !== "detach" && !target) return toast("先选一条主线");
  if (action === "merge" && !confirm("合并是把它当成重复的事并进去，事件和关键词都会搬过去。可以撤销。继续？")) return;
  await api(`/life/matter/${id}/regroup`, { method: "POST", body: { action, target } });
  toast("好了，可以在改动记录里撤销"); await refreshMatters(); await ACTS.matter({ dataset: { id: action === "merge" ? target : id } });
});
const evItem = (e) => `<li class="tl-item"><time class="sub tabular">${mdhm(e.ts)}</time><div class="main"><div class="inline wrap"><span class="tag">${esc(EV_LEVEL[e.level] ?? e.level)}</span><span class="tag">${esc(EV_KIND[e.kind] ?? e.kind)}</span>
  <span class="sub">${esc([e.place, e.actor].filter(Boolean).join(" · "))}${EV_DONE[e.state] ? ` · ${EV_DONE[e.state]}` : ""}</span>${e.link ? `<a class="tag link" href="${esc(e.link)}" target="_blank" rel="noopener">原处</a>` : ""}</div><div class="text">${esc(e.summary)}</div></div></li>`;
ACTS.matter = async (el) => {
  const box = openDrawer(`事 #${el.dataset.id}`);
  const m = await api(`/life/matter/${el.dataset.id}`);
  const asks = m.events.filter((e) => e.state === "open"), rest = m.events.filter((e) => e.state !== "open");
  st.mains ??= (await api("/life/matters")).filter((x) => OPEN_M.includes(x.status) && !x.parent_id);
  const targets = OPEN_M.includes(m.status) ? st.mains.filter((x) => x.id !== m.id && x.domain === m.domain) : [];
  const shape = `${m.merged_into ? `<div class="sub">并进了 <button type="button" class="tag link" data-act="matter" data-id="${m.merged_into}">事 #${m.merged_into}</button>，要拆回来在改动记录里撤销。</div>` : ""}
    ${m.parent ? `<div class="inline wrap"><span class="sub">属于主线</span><button type="button" class="tag link" data-act="matter" data-id="${m.parent.id}">#${m.parent.id} ${esc(m.parent.title ?? "")}</button><button type="button" class="btn small" data-act="regroup" data-how="detach" data-id="${m.id}">拆出来</button></div>` : ""}
    ${m.children.length ? `<div class="inline wrap"><span class="sub">子事</span>${m.children.map((k) => `<button type="button" class="tag link" data-act="matter" data-id="${k.id}">#${k.id} ${esc(k.title ?? "")}</button>`).join("")}</div>` : ""}
    ${m.merged.length ? `<div class="sub">并进来的：${m.merged.map((k) => `#${k.id} ${esc(k.title ?? "")}`).join("、")}</div>` : ""}
    ${targets.length ? `<div class="inline wrap"><label class="sr" for="mrtarget">主线</label><select id="mrtarget"><option value="">选一条主线…</option>${targets.map((x) => `<option value="${x.id}">#${x.id} ${esc(x.title ?? "")}</option>`).join("")}</select>
      <button type="button" class="btn small" data-act="regroup" data-how="attach" data-id="${m.id}">挂到它下面</button><button type="button" class="btn small" data-act="regroup" data-how="merge" data-id="${m.id}">是重复的，合并进去</button></div>` : ""}`;
  box.innerHTML = `
    <div class="card"><div class="inline wrap">${pill(m.status)}<b>${esc(m.title ?? "")}</b>${domainTag(m.domain)}</div>
      <div class="sub">${m.opened_at ? `${mdhm(m.opened_at)} 开始` : ""}${m.closed_at ? ` · ${mdhm(m.closed_at)} 收` : ""}${m.close_condition ? ` · 收的条件：${esc(m.close_condition)}` : ""}</div>
      ${m.keys.length ? `<div class="sub">又叫：${esc(m.keys.join("、"))}（群里、私聊、信息源说到这些词的，会挂到这件事上）</div>` : ""}${shape}</div>
    ${asks.length ? `<section data-matter><h3>等你 <span class="sub">${asks.length}</span></h3>${asks.map((e) => eventCard(e, { inMatter: true })).join("")}</section>` : ""}
    ${m.text ? `<section><h3>这件事的页面</h3><div class="card">${mdText(m.text)}</div></section>` : ""}
    ${m.tasks.length ? `<section><h3>任务</h3><div class="list">${m.tasks.map((t) => row(`#${t.id} ${t.goal}`, mdhm(t.ts), pill(t.status), `data-act="task" data-id="${esc(t.id)}"`)).join("")}</div></section>` : ""}
    ${m.followups.length ? `<section><h3>跟进</h3><div class="list">${m.followups.map((t) => row(t.note ?? "（跟进）", mdhm(t.due_at), pill(t.status))).join("")}</div></section>` : ""}
    <section><h3>事件 <span class="sub">${rest.length}</span></h3>${rest.length ? `<ol class="tl">${rest.slice().reverse().map(evItem).join("")}</ol>` : empty("（还没有。群里、私聊、信息源里说到这件事时会挂上来。）")}</section>
    <section><h3>时间线</h3>${m.timeline.length ? `<ol class="tl">${m.timeline.slice().reverse().map((r) => `<li class="tl-item"><time class="sub tabular">${mdhm(r.ts)}</time><div class="main"><span class="tag">${esc(KIND_ZH[r.kind] ?? r.kind)}</span><div class="text">${esc(r.text)}</div></div></li>`).join("")}</ol>` : empty("（还没有）")}</section>
    ${opsHtml(m.ops)}`;
};
ACTS.topic = async (el) => {
  const t = el.dataset.t;
  const box = openDrawer(`话头：${t}`);
  const evs = await api(`/life/topic?t=${encodeURIComponent(t)}`);
  const opts = (st.openMatters ?? []).map((m) => `<option value="${m.id}">#${m.id} ${esc(m.title ?? "")}</option>`).join("");
  box.innerHTML = `<div class="card note"><div class="sub">它是一件在办的事的一部分，就挂上去：这些事件和以后说到「${esc(t)}」的都归到那件事。是一件新的事，在对话里说「为「${esc(t)}」起个局」，之前的事件会一起挂上。</div>
      ${opts ? `<div class="inline wrap"><label class="sr" for="tplink">挂到</label><select id="tplink">${opts}</select><button type="button" class="btn small primary" data-act="topiclink" data-t="${esc(t)}">挂上</button></div>` : `<div class="sub">现在没有在办的事。</div>`}</div>
    <section data-matter><h3>事件 <span class="sub">${evs.length}</span></h3>${evs.slice().reverse().map((e) => eventCard(e, { inMatter: true })).join("") || empty("（没有）")}</section>`;
};
ACTS.topiclink = (el) => busy(el, "在挂…", async () => {
  const mid = $("#tplink").value;
  const r = await api("/life/topic/link", { method: "POST", body: { topic: el.dataset.t, matter_id: Number(mid) } });
  toast(`挂上了 ${r.moved} 条`);
  if (st.tab === "matters") PAGES.matters($("#lifebody"));
  await ACTS.matter({ dataset: { id: mid } });
});

// ───────── 人 / 因缘 (§18): lib/people.js ─────────
PAGES.people = peopleTab;
PAGES.yinyuan = yinyuanTab;

// ───────── 导入 (§17.4) ─────────
PAGES.imports = async (body) => {
  const list = await api("/imports");
  body.innerHTML = `
    <div class="card note"><b>从别处搬过来</b><div class="sub">以前的 agent、笔记、聊天导出、周报都行。最好先让原来的工具按「导入格式」整理成 JSON（下面有提示词，复制过去就能用）；直接贴原始材料也可以，这里会先整理一遍。先预览，确认了才写；导入的每一条都带来源，可以整批撤销。人只进 agent 的人物页，不改 people.yaml。</div></div>
    <form class="card" id="impform">
      <div class="inline wrap"><label for="impfrom" class="lbl">从哪来</label><input type="text" id="impfrom" placeholder="比如：旧 agent 的记忆、2025 年的周报" maxlength="60"></div>
      <label for="imptext" class="lbl">内容（导入格式的 JSON，或者原始材料）</label>
      <textarea id="imptext" rows="10" placeholder="贴在这里，或者选一个文件"></textarea>
      <div class="inline wrap"><label class="btn small" for="impfile">选文件…</label><input type="file" id="impfile" class="sr" accept=".json,.md,.txt,.csv,.yaml,.yml">
        <span class="sub" id="impinfo"></span><span class="grow"></span><button type="submit" class="btn primary">预览</button></div>
    </form>
    <div id="impplan"></div>
    <details class="card"><summary>导入格式和提示词（给别的工具用）</summary><div id="impprompt">${loading()}</div></details>
    <section><h2>导入过的</h2>${list.length ? `<div class="list">${list.map(impRow).join("")}</div>` : empty("还没有。")}</section>`;
  $("#impfile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 450_000) { toast("文件太大（上限约 450 KB），拆成几份分次导入"); e.target.value = ""; return; }
    $("#imptext").value = await f.text();
    if (!$("#impfrom").value) $("#impfrom").value = f.name.replace(/\.[^.]+$/, "").slice(0, 60);
    $("#impinfo").textContent = `${f.name} · ${Math.round(f.size / 1024)} KB`;
  });
  $("#impform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#imptext").value, btn = e.submitter ?? $("#impform button[type=submit]");
    if (!text.trim()) return $("#imptext").focus();
    await busy(btn, /^\s*[{[]/.test(text) ? "在读…" : "在整理（要一两分钟）…", async () => {
      const p = await api("/import/preview", { method: "POST", body: { text, from: $("#impfrom").value.trim() || undefined } });
      $("#impplan").innerHTML = planHtml(p);
    });
  });
  $("#impprompt").closest("details").addEventListener("toggle", async (e) => {
    if (!e.target.open || $("#impprompt").dataset.loaded) return;
    const d = await api("/import/prompt");
    $("#impprompt").dataset.loaded = "1";
    $("#impprompt").innerHTML = `<div class="actions"><button type="button" class="btn small" data-act="impcopy" data-k="prompt">复制提示词</button><button type="button" class="btn small" data-act="impcopy" data-k="example">复制示例</button></div>
      <pre class="code" id="imp-prompt">${esc(d.prompt)}</pre><h3>示例</h3><pre class="code" id="imp-example">${esc(d.example)}</pre>`;
  });
};
const impRow = (r) => {
  const s = r.summary ?? {};
  const what = s.error ? `失败：${s.error}` : [s.people_new || s.people_updated ? `人 ${(s.people_new?.length ?? 0) + (s.people_updated?.length ?? 0)}` : "", s.matters_new || s.matters_merged ? `事 ${(s.matters_new?.length ?? 0) + (s.matters_merged?.length ?? 0)}` : "", s.events != null ? `事件 ${s.events}（等你 ${s.open ?? 0}）` : ""].filter(Boolean).join(" · ");
  const st_ = { applied: ["good", "已导入"], undone: ["plain", "已撤销"], failed: ["crit", "失败"], applying: ["warn", "导入中"] }[r.status] ?? ["plain", r.status];
  return row(`#${r.id} ${r.origin ?? ""}`, `${mdhm(r.ts)}${what ? ` · ${what}` : ""}`,
    `<span class="pill ${st_[0]}">${st_[1]}</span>${r.status === "applied" ? ` <button type="button" class="btn small" data-act="impundo" data-id="${r.id}">撤销</button>` : ""}`);
};
function planHtml(p) {
  const { plan, doc } = p, shape = plan.shape;
  const people = plan.people.map((x) => `<li>${x.exists ? "补充" : "新建"} <b>${esc(x.name)}</b>${x.relation ? ` <span class="sub">${esc(x.relation)}</span>` : ""}</li>`).join("");
  const matters = plan.matters.map((m) => `<li>${m.merge ? `并入 #${m.merge.id} ${esc(m.merge.title ?? "")}` : m.parent ? "新建子事" : "新建"}：<b>${esc(m.title)}</b> <span class="sub">${esc(st.meta.domains[m.domain] ?? m.domain ?? "")} · ${esc(m.status)} · ${m.events} 条事件</span></li>`).join("");
  const evs = doc.events.slice(0, 40).map((e) => `<li><span class="sub tabular">${esc(new Date(e.ts).toISOString().slice(0, 10))}</span> <span class="tag">${esc(EV_LEVEL[e.level] ?? e.level)}</span> ${esc(e.text)}${e.state === "open" ? " <span class=\"sub\">（还在等你）</span>" : ""}</li>`).join("");
  return `<section class="card" id="impplancard"><h3>预览 <span class="sub">${p.kind === "json" ? "按导入格式读的" : "从原始材料整理出来的，看一眼对不对"} · 来自「${esc(p.from)}」</span></h3>
    ${p.already ? `<div class="err">这份材料已经导入过（#${p.already}）。要重来先撤销那次。</div>` : ""}
    <h4>人 <span class="sub">${plan.people.length}</span></h4>${people ? `<ul class="notes">${people}</ul>` : `<div class="sub">（无）</div>`}
    <h4>事 <span class="sub">会有 ${shape.mains} 条在办的主线${shape.subs ? `、${shape.subs} 件子事` : ""}，一共 ${shape.total} 件${shape.closed ? `（${shape.closed} 件已收）` : ""}</span></h4>${shape.warn.map((w) => `<div class="err">${esc(w)}</div>`).join("")}${matters ? `<ul class="notes">${matters}</ul>` : `<div class="sub">（无）</div>`}
    <h4>事件 <span class="sub">${plan.events.n} 条，还在等你的 ${plan.events.open} 条${plan.events.loose ? `，没挂到事上的 ${plan.events.loose} 条` : ""}</span></h4>${evs ? `<ul class="notes">${evs}</ul>${doc.events.length > 40 ? `<div class="sub">……只列前 40 条</div>` : ""}` : ""}
    <div class="actions">${p.already ? "" : `<button type="button" class="btn primary" data-act="impapply" data-sha="${esc(p.sha)}">导入</button>`}<button type="button" class="btn" data-act="impcancel">算了</button></div></section>`;
}
ACTS.impapply = (el) => busy(el, "在导入…", async () => {
  const r = await api("/import/apply", { method: "POST", body: { sha: el.dataset.sha } });
  toast(`导入 #${r.id}：人 ${r.people_new.length + r.people_updated.length}、事 ${r.matters_new.length + r.matters_merged.length}、事件 ${r.events}`, 5000);
  $("#imptext").value = ""; $("#impfrom").value = "";
  await PAGES.imports($("#lifebody"));
});
ACTS.impcancel = () => { $("#impplan").innerHTML = ""; };
ACTS.impundo = async (el) => {
  if (!confirm(`撤销导入 #${el.dataset.id}？它带进来的人物记录、事、事件都会拿掉（之后又有别的记录挂上的事会留着，标成不办）。`)) return;
  await busy(el, "在撤销…", async () => { await api(`/import/${el.dataset.id}/undo`, { method: "POST" }); toast("撤销了"); await PAGES.imports($("#lifebody")); });
};
ACTS.impcopy = async (el) => {
  await navigator.clipboard.writeText($(`#imp-${el.dataset.k}`).textContent);
  toast("复制了");
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
  const order = { candidate: 0, endorsed: 1, seeing_off: 2, faded: 3, let_go: 4, dropped: 5 };
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
    <div class="inline wrap">${pill(x.status, x.status === "dropped" ? "不认" : undefined)}<span class="text grow">${esc(x.text)}</span></div>
    <div class="sub">${x.first_seen ? `${mdhm(x.first_seen)} 第一次看到` : ""}${x.last_seen ? ` · 最近 ${rel(x.last_seen)}` : ""}${x.owner_said ? " · 你说过" : ""}${x.noticed.owner || x.noticed.agent ? ` · 你先看见 ${x.noticed.owner ?? 0} 次、它先 ${x.noticed.agent ?? 0} 次` : ""}${x.note ? ` · ${esc(x.note)}` : ""}</div>
    ${x.evidence.length ? `<details><summary>证据 ${x.evidence.length} 条</summary><ul class="notes">${x.evidence.map((e) => `<li>${esc(typeof e === "string" ? e : JSON.stringify(e))}</li>`).join("")}</ul></details>` : ""}
    <div class="actions">${btn("endorsed", x.status === "let_go" ? "恢复" : x.status === "faded" ? "还在" : "认可", "primary")}${btn("seeing_off", "送一程")}${btn("let_go", "放下")}${btn("dropped", "不认", "danger")}${x.status !== "candidate" ? btn("candidate", "回到候选") : ""}</div>
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
const JOB_ZH = { day: "日运", week: "周运", month: "月运" };
const OTHER_PLACE = "__other";

PAGES.birth = async (body) => {
  let v = await api("/life/birth"), saved = "", raw = null;
  body.innerHTML = `<div class="card note"><b>不填也能用。</b><div class="sub">六爻和紫占不需要生辰；填了之后紫微才能排盘，每月多一份流月。这里和私聊里跟它说，改的是同一份 config/self.yaml，每次改动都有记录、能回滚。管理群只收到「改了」，不显示内容。</div></div>
    <div id="birthform"></div>
    <details class="rawyaml"><summary>直接改 self.yaml（节律、送一程阈值也在这里）</summary><div id="birthed"></div></details>`;

  const val = (id) => $(`#bf-${id}`, body)?.value.trim() ?? "";
  const opts = (list, cur) => list.map(([k, label]) => `<option value="${esc(k)}"${String(cur ?? "") === String(k) ? " selected" : ""}>${esc(label)}</option>`).join("");
  // the error node is tied to its field only while shown: text aria-describedby points at is read out even when hidden
  const field = (id, label, control, hint = "") => `<div class="fld" data-fld="${id}"><label for="bf-${id}">${label}</label>${control}${hint ? `<span class="sub">${hint}</span>` : ""}<span class="fld-err" id="bf-${id}-err" hidden></span></div>`;
  const text = (id, cur, attrs = "") => `<input type="text" id="bf-${id}" value="${esc(cur ?? "")}" autocomplete="off" aria-invalid="false" ${attrs}>`;

  function collect() {
    const city = val("city"), lunar = val("calendar") === "lunar", num = (s) => s === "" ? null : Number(s);
    const birth = { date: val("date"), time: val("time"), calendar: lunar ? "lunar" : v.birth?.calendar === "solar" ? "solar" : null, leap_month: lunar ? $("#bf-leap", body).checked : null, gender: val("gender"),
      place: city === OTHER_PLACE ? val("place") : city, longitude: num(val("longitude")), timezone: num(val("timezone")) };
    const blank = !birth.date && !birth.time && !birth.gender && !birth.place && birth.longitude === null && birth.timezone === null;
    const lenses = Object.fromEntries(Object.keys(v.lenses).map((k) => {
      const on = $(`#bf-on-${k}`, body).checked;   // only a real change: an untouched save must leave the file alone
      return [k, { ...(on !== v.lenses[k].enabled ? { enabled: on } : {}), notes: val(`notes-${k}`) || null, ...(k === "liuyao" ? { cast: val(`cast-${k}`) || null } : {}) }];
    }));
    return { ...(blank && !v.birth ? {} : { birth }), lenses };
  }
  const formDirty = () => !!$("#bf-date", body) && JSON.stringify(collect()) !== saved;

  function showErrors(message) {
    const box = $("#bf-err", body);
    let first, placed = 0;
    // the server is the one validator; its "- birth.date：…" lines also land next to their fields
    for (const [, key, msg] of message.matchAll(/^- (?:birth\.(\w+)|lenses\.(?:\w+)\.profile\.\w+)：(.+)$/gm)) {
      const id = { leap_month: "leap", place: "city" }[key] ?? key, input = key && $(`#bf-${id}`, body), err = key && $(`#bf-${id}-err`, body);
      if (!input || !err) continue;
      err.textContent = msg; err.hidden = false;
      input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", err.id);
      first ??= input; placed++;
    }
    // what landed on a field isn't repeated up here in the file's own terms
    box.textContent = placed && placed === message.split("\n").filter((l) => l.startsWith("- ")).length ? `有 ${placed} 处要改，看下面标红的地方。` : message;
    box.hidden = false;
    (first ?? box).focus?.();
  }
  function clearErrors() {
    $("#bf-err", body).hidden = true;
    for (const e of $$(".fld-err", body)) e.hidden = true;
    for (const i of $$("[aria-describedby]", $("#birthform", body))) { i.removeAttribute("aria-describedby"); i.setAttribute("aria-invalid", "false"); }
  }
  async function refreshRaw() { if (!raw?.dirty()) raw = await mountEditor($("#birthed", body), "self.yaml", { private: true, onSaved: async () => { v = await api("/life/birth"); if (!formDirty()) draw(); } }); }
  async function apply(r, what) {
    v = r; draw(); await refreshRaw();
    toast(!r.changed ? "没有改动" : `${what}${r.moved.length ? "。之后的看法用新版本，以前写下的不动" : ""}`, 4000);
  }

  function draw() {
    const b = v.birth ?? {}, known = v.cities.some((c) => c.name === b.place), city = !b.place ? "" : known ? b.place : OTHER_PLACE, lunar = b.calendar === "lunar";
    const jobs = Object.entries(v.jobs).map(([h, j]) => `${JOB_ZH[h]}：${j ? esc(jobWhen(j)) : "关着"}`).join(" · ");
    $("#birthform", body).innerHTML = `<form id="bf" novalidate>
      <div class="card err" id="bf-err" role="alert" tabindex="-1" hidden></div>
      <section><h3>出生信息</h3>
        <div class="sub bf-state">${v.ready ? `排盘用：${esc(v.chart_input.datetime)}（公历）· 经度 ${esc(v.chart_input.longitude)} · UTC${v.chart_input.timezone >= 0 ? "+" : ""}${esc(v.chart_input.timezone)}` : v.birth ? "还不完整，紫微暂时排不了盘" : "还没填"}</div>
        <div class="formgrid">
          ${field("calendar", "历法", `<select id="bf-calendar" aria-invalid="false">${opts([["solar", "公历"], ["lunar", "农历"]], b.calendar ?? "solar")}</select>`)}
          ${field("date", "出生日期", text("date", b.date, `inputmode="numeric" placeholder="1990-05-09"`), "按上面选的历法写")}
          ${field("time", "出生时间", text("time", b.time, `inputmode="numeric" placeholder="09:40"`), "24 小时制")}
          ${field("gender", "性别", `<select id="bf-gender" aria-invalid="false">${opts([["", "请选择"], ["male", "男"], ["female", "女"]], b.gender)}</select>`)}
          ${field("city", "出生地", `<select id="bf-city" aria-invalid="false">${opts([["", "请选择"], ...v.cities.map((c) => [c.name, c.name]), [OTHER_PLACE, "其他地方（自己填经度）"]], city)}</select>`, "用于真太阳时")}
          ${field("place", "地名", text("place", known ? "" : b.place))}
          ${field("longitude", "经度", text("longitude", b.longitude, `inputmode="decimal" placeholder="120.155"`), "东经为正，西经为负")}
          ${field("timezone", "时区", text("timezone", b.timezone, `inputmode="numeric" placeholder="8"`), "不填就是 UTC+8")}
        </div>
        <label class="check" id="bf-leapwrap"><input type="checkbox" id="bf-leap" aria-invalid="false"${b.leap_month ? " checked" : ""}> 这个月是闰月</label>
        <span class="fld-err" id="bf-leap-err" hidden></span>
      </section>
      <section><h3>镜头</h3>
        ${Object.entries(v.lenses).map(([k, l]) => `<div class="card lensbox">
          <label class="check"><input type="checkbox" id="bf-on-${k}"${l.enabled ? " checked" : ""}> <b>${esc(l.zh)}</b></label>
          <div class="sub">${l.methods.map((m) => esc(m.zh.split("：")[0]) + (m.runnable ? "" : "（要生辰）")).join(" · ")}</div>
          <div class="formgrid">
            ${k === "liuyao" ? field(`cast-${k}`, "起卦方式", `<select id="bf-cast-${k}">${opts([["", "默认（大衍筮法）"], ...Object.entries(v.cast_methods)], l.cast)}</select>`) : ""}
            ${field(`notes-${k}`, "给这门镜头的要求", text(`notes-${k}`, l.notes, `maxlength="500" placeholder="比如：多看工作，少说术语"`))}
          </div></div>`).join("")}
        <div class="sub">例行看法 · ${jobs} · <a href="#/self/config/jobs.yaml">在 jobs.yaml 开关</a></div>
      </section>
      <div class="actions"><button type="submit" class="btn primary">保存</button><button type="button" class="btn" id="bf-reset">放弃改动</button>${v.birth ? `<button type="button" class="btn" id="bf-clear">清空出生信息</button>` : ""}</div>
      <section><h3>历史</h3><div class="list">${v.history.map((h, i) => `<div class="row"><div class="main"><div>${esc(h.subject)}</div><div class="sub">${esc(h.sha)} · ${mdhm(h.at)}</div></div>${i ? `<button type="button" class="btn small" data-back="${esc(h.sha)}">回到这版</button>` : `<span class="sub">当前</span>`}</div>`).join("") || `<div class="empty">（还没有历史）</div>`}</div></section>
    </form>`;
    const sync = () => {
      const isLunar = val("calendar") === "lunar", other = val("city") === OTHER_PLACE;
      $("#bf-leapwrap", body).hidden = !isLunar;
      $('[data-fld="place"]', body).hidden = !other;
    };
    sync();
    $("#bf-calendar", body).addEventListener("change", sync);
    $("#bf-city", body).addEventListener("change", () => {
      const c = v.cities.find((x) => x.name === val("city"));
      if (c) { $("#bf-longitude", body).value = c.lon; $("#bf-timezone", body).value = c.tz ?? ""; }
      sync();
    });
    $("#bf", body).addEventListener("submit", (e) => {
      e.preventDefault();
      busy(e.submitter ?? $("#bf button[type=submit]", body), "在存…", async () => {
        clearErrors();
        try { await apply(await api("/life/birth", { method: "PUT", body: { patch: collect(), hash: v.hash } }), "已保存"); }
        catch (x) { showErrors(x.message); }
      });
    });
    $("#bf-reset", body).addEventListener("click", draw);
    $("#bf-clear", body)?.addEventListener("click", (e) => {
      if (!confirm("清空出生信息？紫微会停下，以前写下的看法不动，之后可以从历史里找回来。")) return;
      busy(e.currentTarget, "在清…", async () => {
        clearErrors();
        try { await apply(await api("/life/birth", { method: "PUT", body: { patch: { birth: null }, hash: v.hash } }), "已清空"); } catch (x) { showErrors(x.message); }
      });
    });
    for (const btn of $$("[data-back]", body)) btn.addEventListener("click", () => {
      if (!confirm(`回到版本 ${btn.dataset.back}？这也会记成一次新的改动，可以再改回来。`)) return;
      busy(btn, "在回滚…", async () => {
        clearErrors();
        try { await apply(await api("/life/birth/rollback", { method: "POST", body: { sha: btn.dataset.back, hash: v.hash } }), "已回滚"); } catch (x) { showErrors(x.message); }
      });
    });
    saved = JSON.stringify(collect());
  }

  draw();
  await refreshRaw();
  st.editor = { dirty: () => formDirty() || !!raw?.dirty() };
};
