// Shared by every page: formatting, the API client, toasts, the detail drawer (<dialog>) and the click dispatcher.
// Everything the server sends is untrusted text: it goes through esc() before it touches innerHTML.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const S = { status: null, tz: "Asia/Shanghai", me: null };

// ───────── formatting ─────────
export const fmt = (ms, o) => ms ? new Intl.DateTimeFormat("zh-CN", { timeZone: S.tz, hour12: false, ...o }).format(new Date(ms)) : "—";
export const hm = (ms) => fmt(ms, { hour: "2-digit", minute: "2-digit" });
export const mdhm = (ms) => fmt(ms, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
export const isoDay = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: S.tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
export const dayLabel = (ms) => { const d = isoDay(ms); return d === isoDay(Date.now()) ? "今天" : d === isoDay(Date.now() - 86400_000) ? "昨天" : d; };
export function rel(ms) {
  if (!ms) return "—";
  const s = (Date.now() - ms) / 1000, a = Math.abs(s), suf = s >= 0 ? "前" : "后";
  if (a < 45) return s >= 0 ? "刚刚" : "马上";
  if (a < 3600) return `${Math.round(a / 60)} 分钟${suf}`;
  if (a < 86400) return `${Math.round(a / 3600)} 小时${suf}`;
  return `${Math.round(a / 86400)} 天${suf}`;
}
export const dur = (a, b) => { if (!a || !b) return ""; const s = Math.max(0, (b - a) / 1000); return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`; };
export const money = (n) => `$${Number(n ?? 0).toFixed(Number(n ?? 0) < 1 ? 3 : 2)}`;
export const k = (n) => (n ?? 0) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : (n ?? 0) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n ?? 0));
export const pct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : "—";
export const pj = (s) => { try { return JSON.parse(s ?? "null"); } catch { return null; } };

export const ST = {
  done: ["good", "完成"], sent: ["good", "已发"], approved: ["good", "已批"], ok: ["good", "正常"], fired: ["good", "已触发"], kept: ["good", "保留"],
  endorsed: ["good", "认可"], reviewed: ["good", "已复盘"], chatted: ["good", "聊过"],
  running: ["warn", "进行中"], processing: ["warn", "处理中"], received: ["warn", "排队"], pending: ["warn", "待处理"], queued: ["warn", "排队"],
  sending: ["warn", "发送中"], waiting_approval: ["warn", "等审批"], needs_input: ["warn", "等你回答"], started: ["warn", "在跑"],
  proposed: ["warn", "待批"], candidate: ["warn", "候选"], open: ["warn", "进行中"], active: ["warn", "进行中"], closing: ["warn", "在收"],
  failed: ["crit", "失败"], rejected: ["crit", "驳回"], unknown: ["crit", "状态不明"], error: ["crit", "出错"],
  aborted: ["serious", "中止"], interrupted: ["serious", "中断"], missed: ["serious", "错过"], conflict: ["serious", "冲突"],
  expired: ["plain", "过期"], superseded: ["plain", "被替换"], invalidated: ["plain", "作废"], cancelled: ["plain", "取消"],
  dropped: ["plain", "放下"], merged: ["plain", "并进别的事"], skipped: ["plain", "跳过"], digest: ["plain", "摘要"], rolled_back: ["plain", "已回滚"],
  seeing_off: ["plain", "送一程"], unchatted: ["plain", "没聊"],
};
export const pill = (st, label) => { const [c, l] = ST[st] ?? ["plain", st ?? "—"]; return `<span class="pill ${c}">${esc(label ?? l)}</span>`; };
export const TIER = { chat: "总控", work: "执行", light: "读取", expert: "专家" };
export const tierDot = (t) => `<span class="tierdot" style="background:var(--t-${TIER[t] ? t : "none"}, var(--muted))" title="${esc(TIER[t] ?? t ?? "")}"></span>`;
export const ROLE = { main: "对话", draft: "起草", worker: "任务", dream: "夜间整理", triage: "分拣", improve: "自我改进", lens: "解读" };
export const KIND = { send: "代发消息", plan: "计划", deferred_tool: "推送代码", proposal: "改进提案", rollback: "回滚" };
export const INPUT = { user: "你", timer: "定时", task: "任务通知", approval: "审批结果", card: "卡片", group: "群消息", event: "事件" };
export const jobWhen = (j) => j.every === "day" ? `每天 ${j.at}` : j.every === "week" ? `每周${"日一二三四五六"[Number(j.weekday ?? 0)]} ${j.at}` : `每月 ${j.day ?? 1} 日 ${j.at}`;

// ───────── API ─────────
export async function api(path, o = {}) {
  const method = o.method ?? "GET";
  const go = () => fetch("/api" + path, {
    method,
    headers: { "x-sbot-console": "1", ...(o.body ? { "content-type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  let r;
  try { r = await go(); }
  catch (e) {
    // network-level failure: GETs retry once; writes don't (could double-apply)
    if (method === "GET") { try { r = await go(); } catch { /* fall through */ } }
    if (!r) throw new Error(`请求没送到服务器（${e.message}）。看下 Tailscale 是否连着、浏览器有没有走代理，然后再试。`);
  }
  // public entrance: the session cookie ran out → back to its login page (the tailnet entrance never answers 401)
  if (r.status === 401) { location.assign("/_login"); throw new Error("登录过期了"); }
  const j = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
  if (!r.ok) { const e = new Error(j.error ?? r.status); e.status = r.status; e.body = j; throw e; }
  return j;
}

export function toast(msg, ms = 2600) {
  const box = $("#toasts");
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  box.appendChild(t);
  // a manual popover lives in the top layer; re-showing it puts it above an open modal drawer
  if (box.popover) { if (box.matches(":popover-open")) box.hidePopover(); box.showPopover(); }
  setTimeout(() => t.remove(), ms);
}
window.addEventListener("unhandledrejection", (ev) => toast(`出错了：${ev.reason?.message ?? ev.reason}`, 8000));

// ───────── small building blocks ─────────
export function row(title, sub, side = "", attrs = "") {
  const click = /data-(act|href)/.test(attrs);
  return `<div class="row${click ? " click" : ""}" ${attrs}><div class="main"><div class="clip">${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}</div><div class="side">${side}</div></div>`;
}
export function tile(key, value, sub, p) {
  const level = p == null ? "" : p >= 100 ? "var(--crit)" : p >= 80 ? "var(--serious)" : "var(--accent)";
  return `<div class="tile"><div class="k">${esc(key)}</div><div class="v tabular">${esc(value)}</div><div class="s">${esc(sub)}</div>${p == null ? "" : `<div class="meter"><i style="width:${Math.min(100, p).toFixed(1)}%;background:${level}"></i></div>`}</div>`;
}
export const empty = (t) => `<div class="empty">${esc(t)}</div>`;
export const loading = () => `<div class="empty">加载中…</div>`;
export function diffHtml(diff) {
  return `<div class="diff">${String(diff).split("\n").map((l) => {
    const c = /^(\+\+\+|---|diff |index |new file|deleted file|…)/.test(l) || l.startsWith("@@") ? "h" : l.startsWith("+") ? "a" : l.startsWith("-") ? "d" : "";
    return `<div class="${c}">${esc(l) || " "}</div>`; }).join("")}</div>`;
}
/** plain text with markdown headings / bold made a little stronger; no HTML from the text survives */
export const mdText = (t) => `<div class="md">${String(t ?? "").split("\n").map((l) => /^#{1,4}\s/.test(l) ? `<span class="h">${esc(l.replace(/^#+\s/, ""))}</span>` : esc(l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")).join("\n")}</div>`;
export const tabs = (items, cur, base) => `<nav class="subtabs" aria-label="分区">${Object.entries(items).map(([key, label]) => `<a href="${base}/${key}"${cur === key ? ` aria-current="page"` : ""}>${esc(label)}</a>`).join("")}</nav>`;
export const chips = (items, cur, act, attr = "f") => `<div class="chips">${Object.entries(items).map(([key, label]) => `<button type="button" class="chip" aria-pressed="${cur === key}" data-act="${act}" data-${attr}="${esc(key)}">${esc(label)}</button>`).join("")}</div>`;
/** don't redraw under someone typing: true when a text field in `el` has focus or unsaved text */
export const busyTyping = (el) => !!el && ([...el.querySelectorAll("textarea, input[type=text], input[type=search]")].some((f) => f.value.trim() && f.dataset.keep !== "0") || el.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName));

// ───────── drawer: a native modal <dialog> ─────────
export function openDrawer(title, html = loading(), actions = "") {
  const d = $("#drawer");
  $("#drawer-title").textContent = title;
  $("#drawer-actions").innerHTML = actions;
  const body = $("#drawer-body");
  body.innerHTML = html;
  if (!d.open) d.showModal();
  body.scrollTop = 0;
  return body;
}
export const closeDrawer = () => { const d = $("#drawer"); if (d.open) d.close(); };
export const drawerOpen = () => $("#drawer").open;
// closedby="any" isn't in Safari: light-dismiss by hand there. Press and release must both land outside the box.
if (!("closedBy" in HTMLDialogElement.prototype)) {
  const d = $("#drawer");
  const outside = (e) => { const r = d.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
  let down = false;
  d.addEventListener("pointerdown", (e) => { down = outside(e); });
  d.addEventListener("pointerup", (e) => { if (down && outside(e)) d.close(); });
}

// ───────── clicks: data-act="name" → ACTS[name](el, ev); data-href → navigate ─────────
export const ACTS = {};
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (el && !el.disabled) {
    const fn = ACTS[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    try { await fn(el, e); } catch (err) { toast(err.message ?? String(err), 6000); }
    return;
  }
  const h = e.target.closest("[data-href]");
  if (h && !e.target.closest("a, button, summary, textarea, input")) location.hash = h.dataset.href;
});
/** run fn with the button disabled and a busy label */
export async function busy(el, label, fn) {
  const old = el.textContent;
  el.disabled = true; el.textContent = label;
  try { return await fn(); } finally { el.disabled = false; el.textContent = old; }
}
