// 会话: lanes on the left (one per conversation: 私聊, each group's drafts, each task, the system jobs), the runs of the
// chosen lane as a conversation in the middle (inputs, a run bar, the steps folded, approvals workable in place, what
// went out), and the chain of one run on the right: every model request with its system prompt split into sections,
// what each part costs in tokens, cache hits, versions, and the full request body.
// Lane "*" is everything at once (the old 流转 page). Layout comes from container queries on <main>: narrow shows the
// lane list OR the timeline, medium shows both with the chain in the drawer, wide shows three columns.

import { $, $$, esc, api, pill, tierDot, row, rel, hm, mdhm, dur, money, k, pct, isoDay, dayLabel, empty, loading, busyTyping, chips,
  ACTS, openDrawer, TIER, ROLE, INPUT } from "/lib/core.js";
import { approvalCard, stepsHtml, inputLabel } from "/lib/items.js";
import { shareBar, CAT } from "/lib/charts.js";

const GROUPS = { dm: "私聊", group: "群", draft: "起草", task: "任务", system: "系统", other: "其他" };
const st = { lane: "", lanes: [], runs: [], next: null, sig: "", openSteps: new Set(), flow: { items: [], next: null, filter: "all", paged: false }, chain: null };

export async function render(main, args) {
  main.innerHTML = `<div class="sess" id="sess">
    <aside class="pane lanes" aria-label="会话列表"><div class="pane-head"><h1>会话</h1><span class="sub" id="lanecount"></span></div><nav id="lanelist">${loading()}</nav></aside>
    <section class="pane timeline" aria-label="对话"><div class="pane-head" id="tlhead"></div><div id="tlbody"></div></section>
    <aside class="pane chain" id="chainpane" aria-label="链路">${chainHint()}</aside>
  </div>`;
  // steps load the first time they are opened ("toggle" doesn't bubble: listen in the capture phase)
  $("#sess").addEventListener("toggle", (e) => { const d = e.target; if (d.matches?.("details.steps")) onSteps(d); }, true);
  await Promise.all([drawLanes(), update(args)]);
}

export async function update(args) {
  const lane = args[0] ?? "";
  const sess = $("#sess");
  if (!sess) return;
  sess.dataset.depth = lane ? "lane" : "lanes";
  if (lane === st.lane && $("#tlbody").childElementCount) return;
  st.lane = lane; st.sig = ""; st.runs = []; st.next = null; st.openSteps.clear();
  markLane();
  await drawTimeline(true);
  if (lane) $(".timeline").scrollTop = 0;
}

export async function onFlow() {
  await drawLanes();
  await drawTimeline(false);
}

const chainHint = () => `<div class="hint"><b>链路</b><div class="sub">点某一轮的「链路」，看模型这轮实际收到了什么：系统提示各段占多少 token、缓存命中、版本、花费，还有完整请求。</div></div>`;

// ───────── lanes ─────────
async function drawLanes() {
  const list = $("#lanelist");
  if (!list) return;
  st.lanes = await api("/lanes?days=30");
  if (!$("#lanelist")) return;
  const running = st.lanes.reduce((a, l) => a + l.running, 0);
  $("#lanecount").textContent = `${st.lanes.length} 条 · 30 天${running ? ` · ${running} 在跑` : ""}`;
  const by = {};
  for (const l of st.lanes) (by[l.group] ??= []).push(l);
  list.innerHTML = `<a class="lane" href="#/sessions/*" data-lane="*"><i class="dot" aria-hidden="true"></i><span class="name">全部动态</span><span class="sub meta">对话、群消息、任务、审批按时间排</span></a>` +
    Object.entries(GROUPS).filter(([g]) => by[g]).map(([g, label]) => `<h2 class="lane-group">${esc(label)}</h2>${by[g].map(laneItem).join("")}`).join("");
  markLane();
}

function laneItem(l) {
  const state = l.running ? "run" : l.pending ? "wait" : l.bad24 || ["failed", "aborted", "interrupted"].includes(l.lastStatus) ? "bad" : "";
  const label = state === "run" ? "在跑" : state === "wait" ? `${l.pending} 条待批` : state === "bad" ? "最近出过错" : "";
  return `<a class="lane" href="#/sessions/${encodeURIComponent(l.lane)}" data-lane="${esc(l.lane)}">
    <i class="dot ${state}" aria-hidden="true"></i><span class="name clip">${esc(l.name)}</span>${l.pending ? `<b class="badge" aria-hidden="true">${l.pending}</b>` : ""}
    <span class="sub meta">${rel(l.last)} · ${l.runs} 轮${l.cost ? ` · ${money(l.cost)}` : ""}${l.taskStatus ? ` · ${esc(pillText(l.taskStatus))}` : ""}${label ? `<span class="sr">，${esc(label)}</span>` : ""}</span></a>`;
}
const pillText = (s) => ({ done: "完成", failed: "失败", running: "在跑", needs_input: "等你回答", interrupted: "中断", cancelled: "取消", queued: "排队", waiting_approval: "等审批" }[s] ?? s);
function markLane() {
  const cur = st.lane || "*";
  for (const a of $$("#lanelist .lane")) { if (a.dataset.lane === cur) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
}

// ───────── timeline of one lane ─────────
async function drawTimeline(force) {
  const body = $("#tlbody");
  if (!body) return;
  if (!st.lane || st.lane === "*") return drawFlowPane(force);
  if (!force && busyTyping(body)) { $("#tlstale")?.removeAttribute("hidden"); return; }
  if (force) body.innerHTML = loading();
  const want = Math.min(Math.max(st.runs.length, 20), 100);
  const d = await api(`/lane?key=${encodeURIComponent(st.lane)}&limit=${force ? 20 : want}`);
  if (d.lane !== st.lane || !$("#tlbody")) return;
  const sig = JSON.stringify(d.runs.map((r) => [r.id, r.status, r.ended, r.requests, r.outputs.map((o) => o.status), r.approvals.map((a) => [a.status, a.v])]));
  if (!force && sig === st.sig) return;
  st.sig = sig; st.runs = d.runs; st.next = d.next;
  const lane = st.lanes.find((l) => l.lane === st.lane);
  $("#tlhead").innerHTML = `<a class="back" href="#/sessions">‹ 会话</a><h2 class="clip">${esc(d.name)}</h2>
    <span class="sub">${lane ? `${lane.runs} 轮 · ${money(lane.cost)}${lane.generation != null ? ` · 第 ${lane.generation + 1} 代会话` : ""}` : ""}</span>
    <button type="button" class="btn small" id="tlstale" data-act="tlrefresh" hidden>有新变化 · 刷新</button>`;
  paintRuns();
}
ACTS.tlrefresh = () => drawTimeline(true);

function paintRuns() {
  const body = $("#tlbody");
  const runs = st.runs.slice().reverse();   // oldest at the top, like a conversation
  let html = st.next ? `<div class="more"><button type="button" class="btn small" data-act="tlolder">更早的</button></div>` : "";
  let day = "";
  for (const r of runs) {
    const dd = isoDay(r.started);
    if (dd !== day) { day = dd; html += `<div class="daysep"><span>${esc(dayLabel(r.started))}</span></div>`; }
    html += turnHtml(r);
  }
  body.innerHTML = html || empty("这条会话 30 天内没有记录。");
  for (const id of st.openSteps) { const d = body.querySelector(`details.steps[data-run="${CSS.escape(id)}"]`); if (d) d.open = true; }
}
ACTS.tlolder = (el) => busyLoad(el, async () => {
  const d = await api(`/lane?key=${encodeURIComponent(st.lane)}&before=${st.next}&limit=20`);
  const pane = $(".timeline"), h = pane.scrollHeight;
  st.runs = [...st.runs, ...d.runs]; st.next = d.next;
  paintRuns();
  pane.scrollTop += pane.scrollHeight - h;   // keep the reader where they were
});
async function busyLoad(el, fn) { el.disabled = true; el.textContent = "加载中…"; await fn(); }

function turnHtml(r) {
  const ins = r.inputs.map((x) => `<div class="msg in"><div class="who">${esc(inputLabel(x))} · ${hm(x.ts)}${x.status !== "done" ? ` ${pill(x.status)}` : ""}</div>${x.text ? `<div class="text">${esc(x.text)}</div>` : ""}</div>`).join("");
  const outs = r.outputs.map((o) => `<div class="msg out${o.status === "failed" ? " bad" : ""}"><div class="who">${o.as === "user" ? "以你的身份" : "bot"} · ${esc(o.kind)}${o.channel !== "feishu" ? ` · ${esc(o.channel)}` : ""} · ${hm(o.ts)} ${o.status !== "sent" ? pill(o.status) : ""}</div>
    <div class="text">${esc(o.text)}</div>${o.error ? `<div class="err sub">${esc(o.error)}</div>` : ""}</div>`).join("");
  const u = r.usage;
  return `<article class="turn" data-run="${esc(r.id)}">
    ${ins}
    <div class="runbar">
      ${tierDot(r.tier)}<b>${esc(ROLE[r.role] ?? r.role)}</b>${r.status !== "done" ? pill(r.status) : ""}
      <span class="sub">${hm(r.started)}${r.ended ? ` · ${dur(r.started, r.ended)}` : " · 在跑"}${u ? ` · ${u.calls} 次 · ${money(u.cost)}${u.cr ? ` · 缓存 ${pct(u.cr, u.i + u.cr + (u.cw ?? 0))}` : ""}` : ""}</span>
      <button type="button" class="btn small link" data-act="chain" data-id="${esc(r.id)}" aria-label="这一轮的链路">链路${r.requests ? ` · ${r.requests}` : ""} ›</button>
    </div>
    ${r.role === "worker" ? "" : `<details class="steps" data-run="${esc(r.id)}" data-role="${esc(r.role)}"><summary>过程</summary><div class="stepsbody">${loading()}</div></details>`}
    ${r.error ? `<div class="err">${esc(r.error)}</div>` : ""}
    ${r.approvals.map((a) => approvalCard(a, { compact: true })).join("")}
    ${outs}
  </article>`;
}

async function onSteps(d) {
  const id = d.dataset.run;
  if (!d.open) { st.openSteps.delete(id); return; }
  st.openSteps.add(id);
  if (d.dataset.loaded) return;
  d.dataset.loaded = "1";
  const r = await api(`/run/${encodeURIComponent(id)}`);
  d.querySelector(".stepsbody").innerHTML = stepsHtml(r.steps, d.dataset.role);
}

// ───────── 全部动态 (lane "*") ─────────
const FLOW_FILTERS = { all: "要紧的", run: "对话与起草", message: "群消息", task: "任务", approval: "审批" };
const ACTION = { draft: "起草回复", notify: "提醒你", notified: "已提醒", archive: "归档", digest: "进摘要", ignore: "忽略", skip: "跳过", skipped: "跳过", escalate: "升级" };

async function drawFlowPane(force) {
  const f = st.flow;
  if (force) {
    $("#tlhead").innerHTML = `<a class="back" href="#/sessions">‹ 会话</a><h2>全部动态</h2>${chips(FLOW_FILTERS, f.filter, "flowfilter")}`;
    $("#tlbody").innerHTML = loading();
  } else if (f.paged) return;   // reading older pages: don't yank them away
  const d = await api("/flow?limit=40");
  if (st.lane && st.lane !== "*") return;
  f.items = d.items; f.next = d.next; f.paged = false;
  paintFlow();
}
function paintFlow() {
  const f = st.flow, body = $("#tlbody");
  if (!body) return;
  const needsOwner = (i) => i.type !== "message" || ["draft", "notify", "notified", "escalate"].includes(i.action) || i.status === "pending";
  const items = f.items.filter((i) => (f.filter === "all" && needsOwner(i)) || i.type === f.filter ||
    (f.filter === "approval" && i.type === "run" && i.approvals?.length) || (f.filter === "task" && i.type === "run" && i.role === "worker"));
  let html = "", day = "";
  for (const i of items) {
    const dd = isoDay(i.ts);
    if (dd !== day) { if (day) html += "</div>"; day = dd; html += `<div class="daysep"><span>${esc(dayLabel(i.ts))}</span></div><div class="list">`; }
    html += flowItem(i);
  }
  if (day) html += "</div>";
  body.innerHTML = (html || empty("这段时间没有记录。")) + (f.next ? `<div class="more"><button type="button" class="btn small" data-act="flowmore">更早的</button></div>` : "");
}
function flowItem(i) {
  if (i.type === "run") {
    const lane = st.lanes.find((l) => l.lane === i.lane);
    const ins = i.inputs.slice(0, 2).map((x) => `<div class="io"><span class="who">${esc(INPUT[x.kind] ?? x.kind)}</span> ${esc(x.text)}</div>`).join("");
    const outs = i.outputs.slice(0, 2).map((x) => `<div class="io out"><span class="who">${x.as === "user" ? "以你的身份" : "bot"}</span> ${esc(x.text)} ${x.status !== "sent" ? pill(x.status) : ""}</div>`).join("");
    const ap = i.approvals.map((a) => `<div class="io out"><span class="who">审批 #${a.id}</span> ${esc(a.title ?? a.kind)} ${pill(a.status)}</div>`).join("");
    return `<div class="row flow-run"><div class="main">
      <div class="inline wrap">${tierDot(i.tier)}<b>${esc(ROLE[i.role] ?? i.role)}</b>${i.lane ? `<a href="#/sessions/${encodeURIComponent(i.lane)}" class="sub">${esc(lane?.name ?? i.lane)}</a>` : ""}
        <span class="sub">${hm(i.started)}${i.ended ? ` · ${dur(i.started, i.ended)}` : ""}${i.usage ? ` · ${money(i.usage.cost)}` : ""}</span>${i.status !== "done" ? pill(i.status) : ""}
        <button type="button" class="btn small link push" data-act="chain" data-id="${esc(i.id)}">链路 ›</button></div>
      ${ins}${ap}${outs}${i.error ? `<div class="err sub">${esc(i.error)}</div>` : ""}</div></div>`;
  }
  if (i.type === "message") {
    const act = i.action ? ACTION[i.action] ?? i.action : i.senderKind === "owner" ? "你自己发的" : i.status === "pending" ? "等分拣" : null;
    const cls = i.action === "draft" ? "warn" : i.action === "notify" || i.action === "notified" ? "serious" : "plain";
    return `<div class="row"><div class="main"><div class="sub clip">群消息 · ${esc(i.chat)} · ${esc(i.sender)} · ${hm(i.ts)}</div>
      <div class="clip2">${esc(i.text)}</div>${i.note ? `<div class="sub clip">分拣：${esc(i.note)}</div>` : ""}</div>
      <div class="side">${act ? `<span class="pill ${cls}">${esc(act)}</span>` : pill(i.status)}${i.link ? ` <a class="btn small" href="${esc(i.link)}" target="_blank" rel="noopener">飞书</a>` : ""}</div></div>`;
  }
  if (i.type === "task") return row(`任务 #${i.id}：${i.goal}`, `${TIER[i.tier] ?? i.tier ?? ""}${i.repo ? ` · 仓库 ${i.repo}` : ""} · ${hm(i.ts)}${i.error ? ` · ${i.error}` : ""}`, pill(i.status), `data-href="#/sessions/${encodeURIComponent(`task:${i.id}`)}"`);
  if (i.type === "approval") return row(`审批 #${i.id}：${i.title ?? i.kind}`, `${hm(i.ts)}${i.decided_at ? ` · ${hm(i.decided_at)} 决定` : ""}`, pill(i.status), `data-act="approval" data-id="${i.id}"`);
  return row(`${INPUT[i.kind] ?? i.kind}${i.source ? ` · ${i.source}` : ""}`, `${hm(i.ts)}${i.text ? ` · ${i.text}` : ""}`, pill(i.status));
}
ACTS.flowfilter = (el) => { st.flow.filter = el.dataset.f; for (const b of $$("[data-act=flowfilter]")) b.setAttribute("aria-pressed", String(b === el)); paintFlow(); };
ACTS.flowmore = (el) => busyLoad(el, async () => {
  const f = st.flow, d = await api(`/flow?limit=40&before=${f.next}`);
  f.items = [...f.items, ...d.items]; f.next = d.next; f.paged = true;
  paintFlow();
});

// ───────── chain: one run → its requests → one request in detail ─────────
function chainTarget(title) {
  const pane = $("#chainpane");
  if (pane && pane.offsetWidth > 0) {
    pane.innerHTML = `<div class="pane-head"><h2 class="clip">${esc(title)}</h2><button type="button" class="btn small" data-act="chainclose">收起</button></div><div class="chainbody">${loading()}</div>`;
    pane.scrollTop = 0;
    return pane.querySelector(".chainbody");
  }
  return openDrawer(title);
}
ACTS.chainclose = () => { const p = $("#chainpane"); if (p) p.innerHTML = chainHint(); for (const t of $$(".turn.sel")) t.classList.remove("sel"); };

ACTS.chain = async (el) => {
  const id = el.dataset.id;
  for (const t of $$(".turn")) t.classList.toggle("sel", t.dataset.run === id);
  const box = chainTarget("链路");
  const [d, reqs] = await Promise.all([api(`/run/${encodeURIComponent(id)}`), api(`/run/${encodeURIComponent(id)}/requests`)]);
  const r = d.run, ver = r.versions_json ? JSON.parse(r.versions_json) : null;
  const tot = d.usage.reduce((a, x) => ({ cost: a.cost + (x.cost ?? 0), i: a.i + (x.input_tokens ?? 0), o: a.o + (x.output_tokens ?? 0), cr: a.cr + (x.cache_read ?? 0), cw: a.cw + (x.cache_write ?? 0) }), { cost: 0, i: 0, o: 0, cr: 0, cw: 0 });
  const fed = tot.i + tot.cr + tot.cw;
  box.innerHTML = `
    <div class="card"><div class="inline wrap">${tierDot(r.tier)}<b>${esc(ROLE[r.role] ?? r.role)}</b>${pill(r.status)}<span class="sub">${esc(r.model ?? TIER[r.tier] ?? "")}</span></div>
      <div class="sub">${mdhm(r.started)} → ${r.ended ? hm(r.ended) : "还在跑"}${r.ended ? `（${dur(r.started, r.ended)}）` : ""}${r.stop_reason ? ` · ${esc(r.stop_reason)}` : ""}</div>
      ${r.error ? `<div class="err">${esc(r.error)}</div>` : ""}
      <div class="sub mono clip">${esc(r.id)}${r.session_ref ? ` · ${esc(r.session_ref)}` : ""}</div></div>
    <div class="tiles four">
      <div class="tile"><div class="k">花费</div><div class="v tabular">${money(tot.cost)}</div><div class="s">${d.usage.length} 次调用</div></div>
      <div class="tile"><div class="k">喂进去</div><div class="v tabular">${k(fed)}</div><div class="s">token，含缓存</div></div>
      <div class="tile"><div class="k">缓存命中</div><div class="v tabular">${pct(tot.cr, fed)}</div><div class="s">读 ${k(tot.cr)} · 写 ${k(tot.cw)}</div></div>
      <div class="tile"><div class="k">输出</div><div class="v tabular">${k(tot.o)}</div><div class="s">token</div></div>
    </div>
    ${ver ? `<section><h3>这轮用的版本</h3><div class="tags">${Object.entries(ver).map(([kk, v]) => `<span class="tag"><b>${esc(kk)}</b> ${esc(typeof v === "object" ? JSON.stringify(v) : v)}</span>`).join("")}</div></section>` : ""}
    <section><h3>模型请求</h3>${reqs.length ? `<div class="list">${reqs.map((q, i) => `<div class="row click" data-act="req" data-id="${q.id}">
        <div class="main"><div>${tierDot(q.tier)}#${i + 1} <span class="sub">${hm(q.ts)} · ${esc(String(q.model ?? "").split("/").pop())}</span></div>
        <div class="sub">喂 ${k((q.input_tokens ?? 0) + (q.cache_read ?? 0) + (q.cache_write ?? 0))} · 缓存 ${pct(q.cache_read ?? 0, (q.input_tokens ?? 0) + (q.cache_read ?? 0) + (q.cache_write ?? 0))} · 出 ${k(q.output_tokens)} · ${q.ms ? `${(q.ms / 1000).toFixed(1)}s` : "—"}${q.status >= 400 ? ` · 失败 ${q.status}` : ""}</div></div>
        <div class="side tabular">${money(q.cost)} ›</div></div>`).join("")}</div>`
      : `<div class="empty">${["main", "draft"].includes(r.role) ? "这轮的请求没存（只留 7 天）。" : "只存对话和起草的完整请求；这轮下面是每次调用的用量。"}</div>
        ${d.usage.length ? `<div class="list scroll-x" tabindex="0" role="region" aria-label="每次调用"><table><thead><tr><th>时间</th><th>档</th><th class="n">输入</th><th class="n">缓存读</th><th class="n">输出</th><th class="n">耗时</th><th class="n">花费</th></tr></thead><tbody>
          ${d.usage.map((x) => `<tr><td>${hm(x.ts)}</td><td>${tierDot(x.tier)}${esc(TIER[x.tier] ?? x.tier)}</td><td class="n">${k(x.input_tokens)}</td><td class="n">${k(x.cache_read)}</td><td class="n">${k(x.output_tokens)}</td><td class="n">${x.ms ? (x.ms / 1000).toFixed(1) + "s" : "—"}</td><td class="n">${money(x.cost)}${x.status >= 400 ? ` ${pill("failed", x.status)}` : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}`}</section>
    ${r.lane && st.lane !== r.lane ? `<div class="sub"><a href="#/sessions/${encodeURIComponent(r.lane)}">去这条会话 ›</a></div>` : ""}`;
  box.dataset.run = id;
};

const SEG = { system: ["系统提示", CAT[0]], tools: ["工具定义", CAT[1]], history: ["历史消息", CAT[2]], input: ["这次的输入", CAT[3]] };

ACTS.req = async (el) => {
  const box = el.closest(".chainbody, #drawer-body");
  const runId = box?.dataset.run;
  box.innerHTML = loading();
  const q = await api(`/request/${el.dataset.id}`);
  const u = q.usage, fed = (u.input ?? 0) + (u.cache_read ?? 0) + (u.cache_write ?? 0);
  const sum = (g) => q.segments.filter((s) => s.group === g).reduce((a, s) => a + s.tokens, 0);
  const p = q.params;
  box.innerHTML = `
    ${runId ? `<button type="button" class="btn small link" data-act="chain" data-id="${esc(runId)}">‹ 这一轮</button>` : ""}
    <div class="card"><div class="inline wrap">${tierDot(q.tier)}<b>请求 #${q.id}</b><span class="sub">${mdhm(q.ts)} · ${esc(String(q.model ?? "").split("/").pop())} · ${k(q.bytes)} 字节</span></div>
      <div class="sub">max_tokens ${esc(p.max_tokens ?? "—")}${p.temperature != null ? ` · temperature ${esc(p.temperature)}` : ""}${p.thinking ? ` · thinking ${esc(p.thinking.type ?? "")}${p.thinking.budget_tokens ? ` ${esc(p.thinking.budget_tokens)}` : ""}` : ""}${p.stream ? " · stream" : ""}${p.tool_choice ? ` · tool_choice ${esc(p.tool_choice.type ?? JSON.stringify(p.tool_choice))}` : ""}</div></div>
    <div class="tiles four">
      <div class="tile"><div class="k">喂进去</div><div class="v tabular">${k(fed)}</div><div class="s">新 ${k(u.input)} · 缓存读 ${k(u.cache_read)} · 写 ${k(u.cache_write)}</div></div>
      <div class="tile"><div class="k">缓存命中</div><div class="v tabular">${pct(u.cache_read ?? 0, fed)}</div><div class="s">${(u.cache_read ?? 0) ? "前缀没变的部分走了缓存" : "这次没命中缓存"}</div></div>
      <div class="tile"><div class="k">输出</div><div class="v tabular">${k(u.output)}</div><div class="s">${u.ms ? `${(u.ms / 1000).toFixed(1)}s` : ""}</div></div>
      <div class="tile"><div class="k">花费</div><div class="v tabular">${money(u.cost)}</div><div class="s">${u.status >= 400 ? `失败 ${esc(u.status)}` : "成功"}</div></div>
    </div>
    <section><h3>这次喂进去的 token 花在哪 ${q.segments[0]?.estimated ? `<span class="sub">（没有用量数据，按字数估）</span>` : `<span class="sub">（总数是真的，各段按字数分摊）</span>`}</h3>
      ${shareBar(Object.entries(SEG).map(([g, [label, color]]) => ({ label, color, value: sum(g) })), (v) => k(v))}</section>
    ${q.versions ? `<section><h3>版本</h3><div class="tags">${Object.entries(q.versions).map(([kk, v]) => `<span class="tag"><b>${esc(kk)}</b> ${esc(typeof v === "object" ? JSON.stringify(v) : v)}</span>`).join("")}</div></section>` : ""}
    <section><h3>分段 <span class="sub">${q.segments.length} 段</span></h3><div class="parts">${q.segments.map((s, i) => `<details class="part">
      <summary><span class="tierdot" style="background:${SEG[s.group][1]}" title="${esc(SEG[s.group][0])}"></span><span class="clip">${esc(s.title)}</span>
        <span class="sub tabular">${s.estimated ? "≈" : ""}${k(s.tokens)}${s.cache ? ` · <span class="tag">缓存断点</span>` : ""}</span>
        <i class="segbar" aria-hidden="true" style="--w:${fed ? Math.min(100, (s.tokens / fed) * 100).toFixed(1) : 0}%;--c:${SEG[s.group][1]}"></i></summary>
      <pre class="code">${esc(s.text)}</pre></details>`).join("")}</div></section>
    ${q.tools.length ? `<section><h3>工具 <span class="sub">${q.tools.length} 个，按定义长度</span></h3><div class="tags">${q.tools.slice().sort((a, b) => b.chars - a.chars).map((t) => `<span class="tag">${esc(t.name)} <span class="sub">${k(t.chars)} 字</span></span>`).join("")}</div></section>` : ""}
    <section><button type="button" class="btn" data-act="reqraw" data-id="${q.id}">看完整请求 JSON</button><div id="reqraw"></div></section>`;
};
ACTS.reqraw = async (el) => {
  const out = el.parentElement.querySelector("#reqraw");
  if (out.childElementCount) { out.innerHTML = ""; el.textContent = "看完整请求 JSON"; return; }
  const r = await api(`/request/${el.dataset.id}?raw=1`);
  out.innerHTML = `<pre class="code raw">${esc(r.text)}</pre>`;
  el.textContent = "收起";
};
