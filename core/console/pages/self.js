// 它自己: how it is running (connections, what's busy, jobs), whether it's getting better (§16 health trend), its own
// improvement proposals (diff, replay, roll back), its memory (commits, pages, search), what it costs, its models and
// keys, its config files, which groups it watches, and the other places it reads (§17.3 信息源).

import { $, $$, S, esc, api, toast, pill, tierDot, row, tile, rel, mdhm, isoDay, money, k, empty, loading, tabs, chips, diffHtml, mdText,
  busy, ACTS, openDrawer, closeDrawer, TIER, ROLE, jobWhen } from "/lib/core.js";
import { approvalCard } from "/lib/items.js";
import { stackedBars, CAT } from "/lib/charts.js";
import { mountEditor } from "/lib/editor.js";

const TABS = { status: "状态", health: "健康", proposals: "提案", memory: "记忆", usage: "用量", models: "模型与密钥", config: "配置", groups: "群", sources: "信息源" };
const st = { tab: "", arg: "", usageDays: 14, g: { filter: "all", q: "", limit: 80, list: [] }, editor: null };

export async function render(main, args) {
  main.innerHTML = `<div class="page" id="selfpage"><div class="page-head"><h1>它自己</h1></div><div id="selftabs"></div><div id="selfbody"></div></div>`;
  st.tab = ""; st.arg = "";
  await update(args);
}
export async function update(args) {
  const tab = TABS[args[0]] ? args[0] : "status", arg = args[1] ?? "";
  if (tab === st.tab && arg === st.arg) return;
  if (st.editor?.dirty() && !confirm("配置有没保存的改动，离开就丢了。离开？")) { history.back(); return; }
  st.tab = tab; st.arg = arg; st.editor = null;
  $("#selftabs").innerHTML = tabs(TABS, tab, "#/self");
  const body = $("#selfbody");
  body.innerHTML = loading();
  await PAGES[tab](body, arg);
}
export function onStatus() { if (st.tab === "status") PAGES.status($("#selfbody")); }

const PAGES = {};
const LANE = (l) => !l ? "" : l === "feishu:dm:owner" ? "私聊" : l.startsWith("system:") ? "系统" : l.startsWith("feishu:group") ? "群" : l.startsWith("feishu:wb") ? "工作台" : l.startsWith("draft:") ? "起草" : l.startsWith("task:") ? "任务" : l;

// ───────── 状态 ─────────
PAGES.status = (body) => {
  const s = S.status;
  if (!s) { body.innerHTML = `<div class="empty">连接中…</div>`; return; }
  const u = s.usage, p = u.budget ? (u.cost / u.budget) * 100 : null;
  const obs = s.observer, l24 = obs.last24h ?? {};
  const conn = [
    ...Object.entries(s.feishu ?? {}).map(([key, x]) => row(`飞书事件 · ${key === "im.message.receive_v1" ? "消息" : key === "card.action.trigger" ? "卡片按钮" : key}`,
      `重启 ${x.restarts} 次 · 最近事件 ${rel(x.lastEvent)}`, x.ready ? pill("ok", "在线") : pill("failed", "断开"))),
    row("飞书个人身份（读群、以你的身份发）", "VPS 上 lark-cli 的用户授权", s.lark.user ? pill("ok", "已授权") : pill("failed", "未授权")),
    row("群观察", `上次拉取 ${rel(obs.lastPoll)} · ${obs.chats} 个群 · 24 小时：分拣 ${(l24.pending ?? 0) + (l24.done ?? 0) + (l24.skipped ?? 0)} 条（含私聊、信息源），摘要 ${l24.digest ?? 0}`,
      obs.lastPoll && Date.now() - obs.lastPoll < 5 * 60_000 ? pill("ok", "在读") : pill("missed", "没在读")),
    row("巡检", s.sentinel.active.length ? `在报：${s.sentinel.active.join("、")}` : `上次 ${rel(s.sentinel.last)}，没有问题`,
      s.sentinel.active.length ? pill("serious", `${s.sentinel.active.length} 项`) : pill("ok", "正常"), s.sentinel.active.length ? `data-href="#/inbox"` : ""),
    row("收件 / 发件", `等处理 ${s.inbox.waiting ?? 0} · 处理中 ${s.inbox.processing ?? 0} · 待发 ${s.outbox.pending ?? 0} · 24 小时发送失败 ${s.outbox.failed24h ?? 0}`,
      (s.outbox.failed24h ?? 0) ? pill("failed", "有失败") : pill("ok", "正常")),
    row("核心进程", `${s.core.rev ? `版本 ${s.core.rev} · ` : ""}pid ${s.core.pid} · 启动 ${rel(s.core.startedAt)} · 内存 ${s.core.rssMb} MB · node ${s.core.node}`, pill("ok", "运行中")),
  ].join("");
  const running = [
    ...s.runs.map((r) => row(`${ROLE[r.role] ?? r.role} · ${LANE(r.lane)}`, `${TIER[r.tier] ?? r.tier ?? ""} · 开始 ${rel(r.started)}`, pill("running"), r.lane ? `data-href="#/sessions/${encodeURIComponent(r.lane)}"` : "")),
    ...s.tasks.map((t) => row(`任务 #${t.id}：${t.goal}`, t.question ? `在问你：${t.question}` : `开始 ${rel(t.started)} · 最近输出 ${rel(t.last_output_at)}`, pill(t.status), `data-act="task" data-id="${esc(t.id)}"`)),
  ].join("");
  const jobs = s.jobs.map((j) => row(j.name, `${jobWhen(j.spec)}（${j.spec.do}）· 下次 ${mdhm(j.next)}${j.last ? ` · 上次 ${mdhm(j.last.at)}` : ""}`,
    `${j.last ? pill(String(j.last.outcome).split(" ")[0]) : ""} <button type="button" class="btn small" data-act="runjob" data-name="${esc(j.name)}">现在跑</button>`)).join("");
  const d = s.dream, rep = d.report;
  body.innerHTML = `
    <div class="tiles">
      ${tile("今日花费", money(u.cost), u.budget ? `上限 ${money(u.budget)} · 到 ${money(u.alertAt * 0.8)} 巡检提醒` : "没设上限", p)}
      ${tile("模型调用", String(u.calls), u.errors ? `失败 ${u.errors} 次 · 输出 ${k(u.output)}` : `无失败 · 输出 ${k(u.output)}`)}
      ${tile("待审批", String(s.approvals.length), s.approvals.length ? "在「待办」里批" : "没有要批的")}
      ${tile("主动消息", `${s.quiet.today}/${s.quiet.cap}`, s.quiet.held ? `压下 ${s.quiet.held} 条，进明早早报` : "先安静：今天的额度", (s.quiet.today / Math.max(1, s.quiet.cap)) * 100)}
    </div>
    <section><h2>正在跑</h2><div class="list">${running || `<div class="empty">现在没有在跑的对话或任务。</div>`}</div></section>
    <section><h2>连接与健康</h2><div class="list">${conn}</div></section>
    <section><h2>定时任务 <a class="sub" href="#/self/config/jobs.yaml">改 jobs.yaml</a></h2><div class="list">${jobs || `<div class="empty">没有定时任务。</div>`}</div></section>
    <section><h2>记忆</h2><div class="list">
      ${row(`${s.memory.pages} 个页面`, s.memory.lastCommit ? `最近一次提交 ${rel(Number(s.memory.lastCommit[1]) * 1000)}：${s.memory.lastCommit[2]}` : "", "›", `data-href="#/self/memory/pages"`)}
      ${row("夜间整理", d.lastAt ? `上次 ${mdhm(d.lastAt)}${rep ? ` · ${rep.commits.length} 处修改、${rep.notes.length} 条留言${rep.sent ? "，已发管理群" : "，还没发"}` : ""}` : "还没跑过", "›", `data-href="#/self/memory"`)}
    </div></section>
    <div class="sub center">${esc(S.me?.login ?? "")} · ${esc(s.owner)} 的 SStudioBot · ${mdhm(s.now)}</div>`;
};
ACTS.runjob = (el) => busy(el, "在跑…", async () => { const r = await api(`/jobs/${el.dataset.name}/run`, { method: "POST" }); toast(r.result, 4000); });

// ───────── 健康 (§16): small multiples, one measure per chart, weekly ─────────
const METRICS = [
  ["approved", "草稿一次就批", "次", "好"], ["revised", "改过再批", "次"], ["rejected", "草稿被拒", "次", "少"], ["mine", "你自己回了（没用草稿）", "次", "少"],
  ["expired", "草稿过期没人管", "次", "少"], ["rounds", "平均改稿轮数", "轮", "少"], ["missed", "群里漏提醒", "次", "少"], ["notify", "群消息提醒你", "次"],
  ["draft", "群消息起草", "次"], ["tasksDone", "任务完成", "个", "好"], ["tasksFailed", "任务失败", "个", "少"], ["pushes", "推送代码", "次"],
  ["proactive", "主动找你", "次"], ["expert", "专家把关", "次"], ["failedRuns", "对话出错", "轮", "少"], ["total", "花费", "$"],
];
PAGES.health = async (body) => {
  const h = await api("/self/health?weeks=8");
  const val = (w, key) => key === "notify" || key === "draft" ? Number(w.triage?.[key] ?? 0) : Number(w[key] ?? 0);
  const last = h.weeks[h.weeks.length - 1], prev = h.weeks[h.weeks.length - 2];
  const fmtv = (key, v) => key === "total" ? money(v) : key === "rounds" ? v.toFixed(1) : String(Math.round(v));
  body.innerHTML = `
    <div class="sub">每格一个指标，每根柱子是一周（截至今天往前 7 天一组）。看趋势，不打分。</div>
    <div class="multiples">${METRICS.map(([key, label, unit, good]) => {
      const a = val(last, key), b = prev ? val(prev, key) : 0;
      const delta = a === b ? "和上周一样" : `${a > b ? "比上周多" : "比上周少"} ${fmtv(key, Math.abs(a - b))}`;
      return `<figure class="card mult"><figcaption><span>${esc(label)}</span>${good ? `<span class="sub">（${good === "好" ? "越多越好" : "越少越好"}）</span>` : ""}</figcaption>
        <div class="big tabular">${esc(fmtv(key, a))}<span class="sub"> ${unit === "$" ? "" : unit} · ${esc(delta)}</span></div><div class="mchart" data-key="${key}"></div></figure>`;
    }).join("")}</div>
    <section><h2>自我改进</h2><div class="card">${mdText(h.improve)}</div>
      <div class="sub">评测用例：${h.cases.map((c) => `${esc(c.kind)} ${c.n}`).join("，") || "还没有"}（来自你真实的回复和处理，不是编的）</div></section>`;
  for (const el of $$(".mchart", body)) {
    const key = el.dataset.key;
    stackedBars(el, h.weeks.map((w) => w.label), [{ label: METRICS.find((m) => m[0] === key)[1], color: "var(--accent)", values: h.weeks.map((w) => val(w, key)) }],
      { height: 90, left: 34, fmtY: (v) => key === "total" ? `$${v}` : String(v), fmtV: (v) => fmtv(key, v), tipTitle: (i) => `${isoDay(h.weeks[i].from)} ~ ${isoDay(h.weeks[i].to)}`, aria: METRICS.find((m) => m[0] === key)[1] });
  }
};

// ───────── 提案 (§16) ─────────
PAGES.proposals = async (body) => {
  const ps = await api("/self/proposals");
  body.innerHTML = ps.length ? `<div class="sub">它对自己提示词、规则的改动建议。批准后生效，两周后回看；随时可以回滚。</div><div class="list">${ps.map((p) =>
    row(`#${p.id} ${p.target}：${p.change ?? ""}`, `${mdhm(p.ts)}${p.problem ? ` · 问题：${p.problem}` : ""}${p.replay ? ` · ${p.replay.split("\n")[0]}` : ""}${p.review_due && p.status === "approved" ? ` · ${mdhm(p.review_due)} 回看` : ""}`,
      pill(p.status), `data-act="proposal" data-id="${p.id}"`)).join("")}</div>` : empty("还没有提案。每周自我改进会根据你的真实处理（改稿、拒绝、自己回）提。");
};
ACTS.proposal = async (el) => {
  const id = el.dataset.id;
  const box = openDrawer(`提案 #${id}`);
  const p = await api(`/self/proposal/${id}`);
  box.innerHTML = `
    <div class="card"><div class="inline wrap">${pill(p.status)}<b>${esc(p.target)}</b><span class="sub">${mdhm(p.ts)}${p.old_version ? ` · ${esc(p.old_version)} → ${esc(p.new_version ?? "")}` : ""}${p.applied_at ? ` · ${mdhm(p.applied_at)} 生效` : ""}</span></div>
      ${p.problem ? `<div><span class="lbl">问题</span> ${esc(p.problem)}</div>` : ""}<div><span class="lbl">改动</span> ${esc(p.change ?? "")}</div>
      ${p.status === "approved" ? `<div class="actions"><button type="button" class="btn danger" data-act="proprollback" data-id="${p.id}">现在回滚</button><span class="sub">不等两周回看，立刻换回旧版本</span></div>` : ""}</div>
    ${p.approval && p.approval.status === "pending" ? `<section><h3>审批</h3>${approvalCard(p.approval, { compact: true })}</section>` : ""}
    <section><h3>回放 <span class="sub">新版本在过去真实案例上跑一遍的结果</span></h3><div class="card text">${esc(p.replay || "（没有回放）")}</div></section>
    <section><h3>diff</h3>${diffHtml(p.diff)}</section>
    ${p.evidence ? `<section><h3>依据</h3><pre class="code">${esc(JSON.stringify(p.evidence, null, 1))}</pre></section>` : ""}
    ${p.review ? `<section><h3>两周回看</h3><pre class="code">${esc(JSON.stringify(p.review, null, 1))}</pre></section>` : ""}
    ${p.rollback ? `<section><h3>回滚</h3>${approvalCard(p.rollback, { compact: true })}</section>` : ""}
    ${p.approval && p.approval.status !== "pending" ? `<section><h3>审批记录</h3>${approvalCard(p.approval, { compact: true })}</section>` : ""}`;
};
ACTS.proprollback = async (el) => {
  if (!confirm("现在就回滚这条提案？会换回旧版本、git 提交，管理群会收到通知。")) return;
  await busy(el, "在回滚…", async () => {
    const r = await api(`/self/proposal/${el.dataset.id}/rollback`, { method: "POST" });
    toast(r.result, 5000); closeDrawer();
    if (st.tab === "proposals") PAGES.proposals($("#selfbody"));
  });
};

// ───────── 记忆 ─────────
const MEM = { log: "改动", pages: "页面", search: "搜索" };
PAGES.memory = async (body, sub) => {
  const tab = MEM[sub] ? sub : "log";
  body.innerHTML = `${chipsLinks(MEM, tab, "#/self/memory")}<div id="mbody">${loading()}</div>`;
  const mb = $("#mbody");
  if (tab === "log") {
    const log = await api("/memory/log?limit=120");
    mb.innerHTML = `<div class="sub">agent-home 的每次提交。夜间整理的修改可以点开看 diff、一键撤销。</div><div class="list">${log.map((c) =>
      `<div class="row click" data-act="commit" data-sha="${esc(c.sha)}"><div class="main"><div class="clip"><code>${esc(c.sha)}</code> ${esc(c.subject)}${c.dream ? `<span class="tag">夜间整理</span>` : ""}${c.revert ? `<span class="tag">已撤销</span>` : ""}</div>
        <div class="sub clip">${esc(c.files.slice(0, 4).join("、"))}${c.files.length > 4 ? ` 等 ${c.files.length} 个` : ""}</div></div><div class="side sub">${rel(c.at)}</div></div>`).join("") || empty("（无）")}</div>`;
  } else if (tab === "pages") {
    const pages = await api("/memory/pages");
    const groups = {};
    for (const p of pages) (groups[p.path.includes("/") ? p.path.split("/")[0] + "/" : "根目录"] ??= []).push(p);
    mb.innerHTML = Object.entries(groups).map(([g, ps]) => `<section><details${g === "journal/" ? "" : " open"}><summary><h2>${esc(g)} <span class="sub">${ps.length}</span></h2></summary><div class="list">${ps.slice().reverse().slice(0, g === "journal/" ? 30 : 500).map((p) =>
      row(p.title, `${p.path}${p.summary ? ` · ${p.summary}` : ""}`, `<span class="tag">${esc(p.visibility)}</span>`, `data-act="page" data-path="${esc(p.path)}"`)).join("")}</div></details></section>`).join("") || empty("还没有页面。");
  } else {
    mb.innerHTML = `<form class="inline" id="mform" role="search"><label class="sr" for="mq">搜记忆</label><input type="search" id="mq" placeholder="搜记忆"><button class="btn" type="submit">搜</button></form><div id="mres"></div>`;
    $("#mform").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#mq").value.trim(); if (!q) return;
      const r = await api(`/memory/search?q=${encodeURIComponent(q)}`);
      const lines = r.result.startsWith("(") ? [] : r.result.split("\n");
      $("#mres").innerHTML = lines.length ? `<div class="list">${lines.map((l) => { const m = /^([^:]+\.md)(?::(\d+))?: (.*)$/.exec(l) ?? [null, l, "", ""];
        return row(m[3] || m[1], `${m[1]}${m[2] ? `:${m[2]}` : ""}`, "", `data-act="page" data-path="${esc(m[1])}"`); }).join("")}</div>` : empty("没搜到。");
    });
    $("#mq").focus();
  }
};
const chipsLinks = (items, cur, base) => `<nav class="chips" aria-label="记忆">${Object.entries(items).map(([key, v]) => `<a class="chip" href="${base}/${key}"${cur === key ? ` aria-current="page"` : ""}>${esc(v)}</a>`).join("")}</nav>`;
ACTS.page = async (el) => {
  const box = openDrawer(el.dataset.path);
  const p = await api(`/memory/page?path=${encodeURIComponent(el.dataset.path)}`);
  box.innerHTML = `<div class="card">${mdText(p.text)}</div>`;
};
ACTS.commit = async (el) => {
  const sha = el.dataset.sha;
  const box = openDrawer(`提交 ${sha}`, loading(), `<button type="button" class="btn small danger" data-act="memrollback" data-sha="${esc(sha)}">撤销这次</button>`);
  const c = await api(`/memory/commit/${sha}`);
  box.innerHTML = `<div class="card text">${esc(c.message)}</div><div class="sub">${mdhm(c.at)}</div>${diffHtml(c.diff.trim())}`;
};
ACTS.memrollback = async (el) => {
  if (!confirm(`撤销提交 ${el.dataset.sha}？会新增一个反向提交，管理群会收到通知。`)) return;
  const r = await api(`/memory/rollback/${el.dataset.sha}`, { method: "POST" });
  toast(r.result, 5000);
  if (r.result.startsWith("已撤销")) { closeDrawer(); if (st.tab === "memory") PAGES.memory($("#selfbody"), st.arg); }
};

// ───────── 用量 ─────────
const REQ = { owner: "主对话", main: "主对话", task: "任务", worker: "任务", check: "检查", triage: "群消息分拣", draft: "起草", expert: "专家把关", ex: "专家把关", dream: "夜间整理", system: "系统", improve: "自我改进", lens: "解读" };
const TIERS = ["chat", "work", "light", "expert"];
PAGES.usage = async (body) => {
  body.innerHTML = `${chips({ 7: "7 天", 14: "14 天", 30: "30 天", 90: "90 天" }, String(st.usageDays), "udays")}<div id="ubody">${loading()}</div>`;
  const u = await api(`/usage?days=${st.usageDays}`);
  const days = []; for (let t = u.from; t <= u.to; t += 86400_000) days.push(isoDay(t));
  const val = (d, t, f) => u.days.find((r) => r.d === d && r.tier === t)?.[f] ?? 0;
  const total = u.days.reduce((a, r) => a + r.cost, 0), calls = u.days.reduce((a, r) => a + r.calls, 0);
  const today = days[days.length - 1], todayCost = TIERS.reduce((a, t) => a + val(today, t, "cost"), 0);
  const series = TIERS.map((t, i) => ({ label: TIER[t], color: CAT[i], values: days.map((d) => val(d, t, "cost")) }));
  $("#ubody").innerHTML = `
    <div class="tiles">
      ${tile(`${st.usageDays} 天花费`, money(total), `日均 ${money(total / days.length)}`)}
      ${tile("今天", money(todayCost), u.budget ? `上限 ${money(u.budget)}` : "没设上限", u.budget ? (todayCost / u.budget) * 100 : null)}
      ${tile("调用", String(calls), `日均 ${Math.round(calls / days.length)}`)}
      ${tile("输出 token", k(u.days.reduce((a, r) => a + r.o, 0)), `缓存读 ${k(u.days.reduce((a, r) => a + r.cr, 0))}`)}
    </div>
    <section><h2>每天花费（按档）<button type="button" class="btn small push" data-act="utable" aria-pressed="false">表格</button></h2><div class="card"><div id="cdays"></div><div id="tdays" class="scroll-x" tabindex="0" role="region" aria-label="每天花费表格" hidden></div></div></section>
    <section><h2>今天每小时</h2><div class="card"><div id="chours"></div></div></section>
    <section><h2>谁在花</h2><div class="list scroll-x" tabindex="0" role="region" aria-label="谁在花"><table><thead><tr><th>用途</th><th class="n">调用</th><th class="n">花费</th><th class="w30">占比</th></tr></thead><tbody>
      ${u.byRequester.map((r) => `<tr><td>${esc(REQ[r.who] ?? r.who)}</td><td class="n">${r.calls}</td><td class="n">${money(r.cost)}</td><td><div class="meter flat"><i style="width:${total ? ((r.cost / total) * 100).toFixed(1) : 0}%"></i></div></td></tr>`).join("") || `<tr><td colspan="4" class="sub">（无）</td></tr>`}</tbody></table></div></section>
    <section><h2>按模型</h2><div class="list scroll-x" tabindex="0" role="region" aria-label="按模型"><table><thead><tr><th>模型</th><th class="n">调用</th><th class="n">输出</th><th class="n">耗时</th><th class="n">失败</th><th class="n">花费</th></tr></thead><tbody>
      ${u.byModel.map((r) => `<tr><td class="nowrap">${tierDot(r.tier)}${esc(String(r.model ?? "?").split("/").pop())}</td><td class="n">${r.calls}</td><td class="n">${k(r.o)}</td><td class="n">${r.ms ? (r.ms / 1000).toFixed(1) + "s" : "—"}</td><td class="n">${r.errors || 0}</td><td class="n">${money(r.cost)}</td></tr>`).join("") || `<tr><td colspan="6" class="sub">（无）</td></tr>`}</tbody></table></div></section>`;
  stackedBars($("#cdays"), days.map((d) => d.slice(5)), series, { fmtY: (v) => `$${v}`, fmtV: money, ref: u.budget ? { value: u.budget, label: `每日上限 $${u.budget}` } : null, tipTitle: (i) => days[i], aria: "每天花费，按模型档堆叠" });
  $("#tdays").innerHTML = `<table><thead><tr><th>日期</th>${TIERS.map((t) => `<th class="n">${TIER[t]}</th>`).join("")}<th class="n">合计</th></tr></thead><tbody>${days.slice().reverse().map((d) => `<tr><td>${d}</td>${TIERS.map((t) => `<td class="n">${money(val(d, t, "cost"))}</td>`).join("")}<td class="n">${money(TIERS.reduce((a, t) => a + val(d, t, "cost"), 0))}</td></tr>`).join("")}</tbody></table>`;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  stackedBars($("#chours"), hours.map(String), TIERS.map((t, i) => ({ label: TIER[t], color: CAT[i], values: hours.map((h) => u.hours.find((r) => r.h === h && r.tier === t)?.cost ?? 0) })),
    { height: 150, fmtY: (v) => `$${v}`, fmtV: money, tipTitle: (i) => `${i}:00–${i + 1}:00`, aria: "今天每小时花费" });
};
ACTS.udays = (el) => { st.usageDays = Number(el.dataset.f); PAGES.usage($("#selfbody")); };
ACTS.utable = (el) => { const t = $("#tdays"), c = $("#cdays"); t.hidden = !t.hidden; c.hidden = !t.hidden; el.setAttribute("aria-pressed", String(!t.hidden)); };

// ───────── 模型与密钥 ─────────
PAGES.models = async (body) => {
  const [m, sec] = await Promise.all([api("/models"), api("/secrets")]);
  const b = m.budgets ?? {};
  body.innerHTML = `
    <section><h2>四档模型 <a class="sub" href="#/self/config/models.yaml">改 models.yaml</a></h2>
      ${m.tiers.map((t) => `<div class="card">
        <div class="inline wrap">${tierDot(t.name)}<b>${esc(TIER[t.name] ?? t.name)}</b><span class="sub">${esc(t.name)} · 端点 ${esc(t.endpoint)}</span>
          <span class="sub push">${t.today ? `今天 ${t.today.calls} 次 · ${money(t.today.cost)}${t.today.ms ? ` · 平均 ${(t.today.ms / 1000).toFixed(1)}s` : ""}${t.today.errors ? ` · 失败 ${t.today.errors}` : ""}` : "今天没用"}</span></div>
        <div class="inline"><label class="sr" for="model-${esc(t.name)}">${esc(TIER[t.name] ?? t.name)} 的模型</label><input type="text" class="grow mono" value="${esc(t.model)}" id="model-${esc(t.name)}" spellcheck="false" autocapitalize="off" data-keep="0"><button type="button" class="btn" data-act="setmodel" data-tier="${esc(t.name)}">换</button></div>
        ${t.price ? `<div class="sub">每百万 token：输入 $${t.price.in} · 输出 $${t.price.out}${t.price.cache_read != null ? ` · 缓存读 $${t.price.cache_read}` : ""}${t.price.cache_write != null ? ` · 缓存写 $${t.price.cache_write}` : ""}</div>` : ""}
      </div>`).join("")}
    </section>
    <section><h2>预算</h2><div class="list">
      ${row("每天花费上限", "到了就拒绝调用（代理返回 403）；巡检在 80% 时提醒", b.daily_cost ? `$${b.daily_cost}` : "不限")}
      ${row("每轮输出上限", "一轮对话最多输出这么多 token", String(b.run_output_tokens ?? 60000))}
    </div></section>
    <section><h2>端点</h2><div class="list">${m.endpoints.map((e) => row(e.name, `${e.base_url} · ${e.auth} · key 用 ${e.key_ref}`)).join("")}</div></section>
    <section><h2>密钥 <span class="sub">只能写</span></h2>
      <div class="sub">写进 VPS 上的 secrets.env（600，不进 git），下一次读取时生效，不用重启。这里永远不显示值，只显示有没有设。</div>
      <div class="list">${sec.map((s) => `<form class="row secret" data-name="${esc(s.name)}"><div class="main"><div><b class="mono">${esc(s.name)}</b> ${s.set ? pill("ok", "已设置") : pill("pending", "未设置")}</div>
        ${s.usedBy.length ? `<div class="sub">${esc(s.usedBy.join("；"))}</div>` : ""}
        <div class="inline"><label class="sr" for="sec-${esc(s.name)}">${esc(s.name)} 的新值</label><input type="password" class="grow" autocomplete="new-password" placeholder="${s.set ? "填新值覆盖" : "填入值"}" id="sec-${esc(s.name)}" data-keep="0"><button class="btn" type="submit">写入</button></div></div></form>`).join("")}
        <form class="row secret" data-name=""><div class="main"><div class="sub">别的密钥</div>
          <div class="inline"><label class="sr" for="sec-new-name">名字</label><input type="text" class="grow mono" placeholder="名字，比如 GITHUB_TOKEN" id="sec-new-name" autocapitalize="characters" spellcheck="false" data-keep="0"></div>
          <div class="inline"><label class="sr" for="sec-new">值</label><input type="password" class="grow" autocomplete="new-password" placeholder="值" id="sec-new" data-keep="0"><button class="btn" type="submit">写入</button></div></div></form>
      </div></section>`;
  for (const f of $$("form.secret", body)) f.addEventListener("submit", (e) => { e.preventDefault(); setSecret(f, e.submitter); });
};
ACTS.setmodel = async (el) => {
  const tier = el.dataset.tier, model = $(`#model-${tier}`).value.trim();
  if (!model || !confirm(`把「${TIER[tier] ?? tier}」档换成 ${model}？下一次调用起生效。`)) return;
  await busy(el, "…", () => api(`/models/${tier}`, { method: "POST", body: { model } }));
  toast("已换，管理群会收到通知"); PAGES.models($("#selfbody"));
};
async function setSecret(form, btn) {
  const name = form.dataset.name || $("#sec-new-name").value.trim().toUpperCase();
  const input = form.querySelector("input[type=password]"), value = input.value;
  if (!name || !value.trim()) return toast("名字和值都要填");
  await busy(btn, "在写…", async () => {
    try { await api(`/secrets/${name}`, { method: "PUT", body: { value } }); input.value = ""; toast(`${name} 已写入`); PAGES.models($("#selfbody")); }
    catch (e) { toast(`没写进去：${e.message}`, 8000); }
  });
}

// ───────── 配置 ─────────
const FILE_NOTE = {
  "models.yaml": "端点、四档模型、价格、预算", "people.yaml": "认人：你和其他人的 ID", "groups.yaml": "群观察开关（「群」页改得更快）",
  "gate.yaml": "敏感词、审批有效期、专家次数、主动消息上限、巡检预算线", "jobs.yaml": "定时任务：早报、夜间整理……",
  "feishu.yaml": "管理群、工作台群", "repos.yaml": "worker 能拿到、批准后能推送的仓库", "console.yaml": "能登录控制台的 Tailscale 账号",
  "self.yaml": "出生信息、节律（私人：在「生活 › 出生信息」改）",
  "sources.yaml": "信息源：飞书私聊开关、仓库、网页、插件（「信息源」页看状态）",
};
const SOURCE = { console: "控制台", card: "卡片", command: "命令", proposal: "提案", manual: "手改" };
PAGES.config = async (body, file) => {
  if (file === "self.yaml") { location.hash = "#/life/birth"; return; }
  if (file) {
    st.editor = await mountEditor(body, file, { back: "#/self/config", note: `${esc(FILE_NOTE[file] ?? "")}。保存时先校验格式，再写文件、git 提交、热加载，并在管理群通知；放宽限制的改动会单独提醒。` });
    return;
  }
  const [files, changes] = await Promise.all([api("/config"), api("/config-changes")]);
  body.innerHTML = `
    <section><h2>配置文件</h2><div class="list">${files.map((f) => row(f.file, `${FILE_NOTE[f.file] ?? ""}${f.exists ? (f.last ? ` · 上次改动 ${rel(f.last.at)}` : "") : " · 还没有（用默认值）"}`, "›",
      `data-href="${f.file === "self.yaml" ? "#/life/birth" : `#/self/config/${f.file}`}"`)).join("")}</div></section>
    <section><h2>最近的改动</h2><div class="list">${changes.map((c) => `<div class="row"><div class="main"><div>${esc(c.file)} <span class="tag">${esc(SOURCE[c.source] ?? c.source)}</span></div>
      ${c.diff && c.file !== "self.yaml" ? `<details><summary>${esc(c.diff.split("\n")[0].slice(0, 80))}</summary>${diffHtml(c.diff)}</details>` : c.file === "self.yaml" ? `<div class="sub">私人内容，去「出生信息」看</div>` : ""}</div><div class="side sub">${rel(c.ts)}</div></div>`).join("") || empty("（无）")}</div></section>`;
};

// ───────── 群 ─────────
const ACT_LABEL = { always: "全部", when_mentioned: "@我", digest: "摘要", disabled: "关闭" };
const ACT_LONG = { always: "全部进分拣", when_mentioned: "只看 @我", digest: "只出摘要", disabled: "关闭" };
const GF = { all: ["全部", () => true], active: ["7 天有消息", (g) => g.n7 > 0], always: ["全部进分拣", (g) => g.act === "always"], when_mentioned: ["只看@我", (g) => g.act === "when_mentioned"],
  digest: ["摘要", (g) => g.act === "digest"], disabled: ["关闭", (g) => g.act === "disabled"], external: ["外部群", (g) => g.external] };
PAGES.groups = async (body) => {
  st.g.list = await api("/groups");
  body.innerHTML = `
    <label class="sr" for="gq">搜群名</label><input type="search" id="gq" placeholder="搜群名（${st.g.list.length} 个群）" value="${esc(st.g.q)}" data-keep="0">
    <div id="gchips"></div>
    <div class="sub">按最近 7 天的消息数排。切换立即写进 groups.yaml；放宽（比如从关闭到全部）会在管理群单独提醒。</div>
    <div id="glist" class="list"></div>
    <div class="more"><button type="button" class="btn" data-act="gmore" id="gmore" hidden>显示更多</button></div>`;
  $("#gq").addEventListener("input", (e) => { st.g.q = e.target.value; st.g.limit = 80; drawGroups(); });
  drawGroups();
};
function drawGroups() {
  const g = st.g, q = g.q.trim().toLowerCase();
  $("#gchips").innerHTML = chips(Object.fromEntries(Object.entries(GF).map(([key, [label, f]]) => [key, `${label} ${g.list.filter(f).length}`])), g.filter, "gfilter");
  const list = g.list.filter(GF[g.filter][1]).filter((x) => !q || String(x.name).toLowerCase().includes(q));
  $("#glist").innerHTML = list.slice(0, g.limit).map((x) => `<div class="row"><div class="main">
      <div class="clip">${esc(x.name || x.id)}${x.external ? `<span class="tag">外部</span>` : ""}${x.muted ? `<span class="tag">免打扰</span>` : ""}</div>
      <div class="sub">${esc(ACT_LONG[x.act])}（${esc(x.why)}）${x.n7 ? ` · 7 天 ${x.n7} 条 · 最近 ${rel(x.last)}` : ""}</div></div>
    <div class="side"><div class="seg" role="group" aria-label="${esc(x.name || x.id)} 的观察方式">${Object.entries(ACT_LABEL).map(([a, l]) => `<button type="button" aria-pressed="${x.act === a}" data-act="setgroup" data-id="${esc(x.id)}" data-a="${a}">${l}</button>`).join("")}</div></div></div>`).join("") || empty("没有匹配的群。");
  $("#gmore").hidden = list.length <= g.limit;
}
ACTS.gfilter = (el) => { st.g.filter = el.dataset.f; st.g.limit = 80; drawGroups(); };
ACTS.gmore = () => { st.g.limit += 120; drawGroups(); };
ACTS.setgroup = async (el) => {
  const x = st.g.list.find((y) => y.id === el.dataset.id);
  if (!x || x.act === el.dataset.a) return;
  const r = await api(`/groups/${x.id}`, { method: "POST", body: { activation: el.dataset.a } });
  x.act = r.act; x.why = r.why; drawGroups(); toast(`${x.name}：${ACT_LONG[r.act]}`);
};

// ───────── 信息源 (§17.3) ─────────
PAGES.sources = async (body) => {
  const d = await api("/sources");
  const last = (x) => !x.last ? "还没拉过" : `上次 ${rel(x.last.at)}${x.last.ok ? `，新 ${x.last.n} 条` : `，出错：${x.last.err ?? ""}`}`;
  body.innerHTML = `
    <div class="card note"><b>它从哪些地方看事</b><div class="sub">群消息之外的来源，都在 sources.yaml 里配：飞书私聊（默认关）、飞书邮箱、仓库提交、网页变化，以及放在服务器 ${esc(d.plugins)}/sources/ 下的插件（Jira……）。拉到的东西和群消息一样进分拣、记成事件，挂到事上。插件只拿到 env 里点名的密钥。</div>
      <div class="actions"><a class="btn small" href="#/self/config/sources.yaml">编辑 sources.yaml</a></div></div>
    <div class="list">
      ${row("飞书私聊", d.dm ? "别人发给你的私聊进分拣（只记事件、不起草）；和它自己的私聊不算" : "关着。打开：sources.yaml 里 feishu.dm: true", d.dm ? pill("ok", "开") : pill("skipped", "关"))}
      ${d.sources.map((x) => row(`${x.id} · ${x.zh}`, `${x.what ?? ""} · 每 ${x.every} · ${x.domain}${x.env.length ? ` · 密钥 ${x.env.join("、")}` : ""} · ${last(x)}`,
        `${!x.enabled ? pill("skipped", "停用") : !x.last ? pill("pending", "等第一次") : x.last.ok ? pill("ok", "正常") : pill("failed", "出错")}${x.enabled ? ` <button type="button" class="btn small" data-act="srcrun" data-id="${esc(x.id)}">现在拉</button>` : ""}`)).join("")}
    </div>
    ${d.sources.length ? "" : `<div class="sub">还没有别的来源。sources.yaml 里有示例。</div>`}`;
};
ACTS.srcrun = (el) => busy(el, "在拉…", async () => {
  const r = await api(`/sources/${el.dataset.id}/run`, { method: "POST" });
  toast(r.ok ? `拉到 ${r.n} 条新的` : `出错：${r.err}`, 5000);
  if (st.tab === "sources") PAGES.sources($("#selfbody"));
});
