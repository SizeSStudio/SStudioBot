// Shell: four areas, hash routes (#/area/...), one ES module per area in /pages/, live status over SSE.
// A page module exports render(main, args); optionally update(args) for in-area navigation without a full redraw,
// onFlow() when something moved (runs, approvals, tasks, outbox), onStatus(status) every time the status changes.

import { $, $$, S, api, closeDrawer, drawerOpen } from "/lib/core.js";

const AREAS = ["inbox", "sessions", "life", "self"];
let cur = { area: "", mod: null };

function route() {
  const [area, ...rest] = (location.hash.replace(/^#\/?/, "") || "inbox").split("/");
  return { area: AREAS.includes(area) ? area : "inbox", args: rest.map((s) => decodeURIComponent(s)) };
}

async function go() {
  const { area, args } = route();
  for (const a of $$(".areas a")) { if (a.dataset.area === area) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  const main = $("#main");
  try {
    if (cur.area === area && cur.mod?.update) return await cur.mod.update(args);
    const mod = await import(`/pages/${area}.js`);
    cur = { area, mod };
    document.title = `${$(`.areas a[data-area=${area}] span`).textContent} · SStudioBot`;
    window.scrollTo(0, 0);
    await mod.render(main, args);
  } catch (e) {
    main.innerHTML = `<div class="page"><div class="card err"></div></div>`;
    main.querySelector(".err").textContent = e.message ?? String(e);
  }
}
window.addEventListener("hashchange", () => { if (drawerOpen()) closeDrawer(); go(); });

function badges(s) {
  const waiting = s.tasks.filter((t) => t.status === "needs_input" || t.status === "interrupted").length;
  const alerts = s.sentinel.active.filter((k) => !k.startsWith("appr.")).length;
  const set = (area, n, label) => { const b = $(`.areas a[data-area=${area}] .badge`); b.hidden = !n; b.textContent = n > 99 ? "99+" : String(n); b.setAttribute("aria-label", label); };
  set("inbox", s.approvals.length + waiting + alerts, `${s.approvals.length} 个待批、${waiting} 个任务在等、${alerts} 条巡检`);
  set("sessions", s.runs.length, `${s.runs.length} 轮在跑`);
  set("self", 0, "");
}

function live(on, text) { const l = $("#live"); l.classList.toggle("on", on); l.lastElementChild.textContent = text ?? (on ? "实时" : "重连中"); }
function connect() {
  const es = new EventSource("/api/events");
  es.addEventListener("status", (e) => {
    S.status = JSON.parse(e.data); S.tz = S.status.tz || S.tz;
    badges(S.status);
    cur.mod?.onStatus?.(S.status);
  });
  es.addEventListener("flow", () => cur.mod?.onFlow?.());
  es.onopen = () => live(true);
  es.onerror = () => live(false);
}
// a write from this page (approve, answer a task…): let the page catch up without waiting for the next SSE tick
document.addEventListener("sbot:changed", () => setTimeout(() => cur.mod?.onFlow?.(), 300));

api("/me").then((m) => { S.me = m; $("#who").textContent = m.login; }).catch(() => {});
connect();
go();
