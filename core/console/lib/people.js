// 生活 › 人 and 生活 › 因缘 (§18). Everyone he has met, what kind of person they are, who is around them, and how each
// tie began. Trust stays in people.yaml (shown here read-only); everything editable here is memory: circle, note,
// merges, splits, relations. Solid = a record says so or he confirmed it; 推测 = matched by name or someone's claim.

import { $, $$, esc, api, toast, row, rel, isoDay, empty, loading, chips, mdText, busy, ACTS, openDrawer } from "/lib/core.js";
import { stackedBars, CAT } from "/lib/charts.js";
import { forceGraph } from "/lib/graph.js";

const st = { q: "", circle: "", list: null, circles: [], rels: [], g: { limit: 60, matters: false } };
const confTag = (c) => c === "INFERRED" ? `<span class="tag" title="按名字对上的，或别人说的">推测</span>` : "";
export function viaText(p) {
  const v = p.first_via;
  if (!p.first_seen && !v) return "";
  const where = !v ? "" : v.kind === "matter" ? `因为「${v.label}」这件事` : v.kind === "page" ? "先有了人物页" : v.label === "私聊" ? "在私聊里" : `在「${v.label}」`;
  return `${p.first_seen ? isoDay(p.first_seen) : ""} ${where}${v?.with?.length ? `，同场有 ${v.with.join("、")}` : ""}${v?.me ? "，你也在" : ""}`.trim();
}
async function loadPeople(force = false) {
  if (!st.list || force) { const d = await api("/life/people"); st.list = d.people; st.circles = d.circles; st.rels = d.rels; }
  return st.list;
}
const nameList = () => `<datalist id="pnames">${(st.list ?? []).filter((p) => !p.hidden).map((p) => `<option value="${esc(`${p.name} #${p.id}`)}"></option>`).join("")}</datalist>`;
const btnOf = (e) => e.submitter ?? e.target.querySelector("button[type=submit]");
const pickId = (v) => { const m = /#(\d+)\s*$/.exec(v ?? ""); if (m) return Number(m[1]); const hit = (st.list ?? []).filter((p) => p.name === String(v ?? "").trim()); return hit.length === 1 ? hit[0].id : null; };

// ───────── 人 ─────────
export async function peopleTab(body) {
  body.innerHTML = loading();
  await loadPeople(true);
  body.innerHTML = `
    <div class="card note"><div class="sub">它见过的每一个人：群里、私聊、事件、导入、人物页。这里只是「认识」，不给任何权限；谁可信、能让它做什么，仍然只在 people.yaml。同一个人被认成两个，点开一个「并进来」；认错了，在「叫法」里拆出去。</div></div>
    <div class="filters">
      ${chips(Object.fromEntries([["", "全部"], ...st.circles.map((c) => [c, c]), ["未分", "未分"]]), st.circle, "pcircle")}
      <div class="inline wrap"><label class="sr" for="pq">搜人</label><input type="search" id="pq" placeholder="名字或叫法" value="${esc(st.q)}" data-keep="0"></div>
    </div>
    <div id="plist"></div>`;
  let t; $("#pq").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value.trim(); drawPeople(); }, 250); });
  drawPeople();
}
ACTS.pcircle = (el) => { st.circle = el.dataset.f; for (const b of $$("[data-act=pcircle]")) b.setAttribute("aria-pressed", String(b === el)); drawPeople(); };
function drawPeople() {
  const box = $("#plist");
  if (!box) return;
  const q = st.q.toLowerCase();
  const rows = st.list.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!st.circle || p.circle === st.circle || (st.circle === "未分" && !p.circle)));
  const line = (p) => row(p.name, [p.circle ?? (p.auto_circle && `圈子：${p.auto_circle}`), p.config && `people.yaml：${p.config.relation ?? p.config.key}`, p.matters && `${p.matters} 件事`,
    p.last_seen && `最近 ${rel(p.last_seen)}`, p.first_seen && `${isoDay(p.first_seen)} 初见`, p.note].filter(Boolean).join(" · "), p.circle ? `<span class="tag">${esc(p.circle)}</span>` : "", `data-act="person" data-id="${p.id}"`);
  const main = rows.filter((p) => !p.hidden && !p.name_only), named = rows.filter((p) => !p.hidden && p.name_only), hid = rows.filter((p) => p.hidden);
  box.innerHTML = (main.length ? `<div class="list">${main.map(line).join("")}</div>` : empty(st.q || st.circle ? "没有对上的人。" : "还没有人。群里、私聊有人说话，或导入以后，会出现在这里。")) +
    (named.length ? `<details class="card"><summary>只见过名字 <span class="sub">${named.length} · 来自事件或导入，没有账号，可能和上面某人是同一个</span></summary><div class="list">${named.map(line).join("")}</div></details>` : "") +
    (hid.length ? `<details class="card"><summary>藏起来的 <span class="sub">${hid.length} · 机器人、无关的，不进图</span></summary><div class="list">${hid.map(line).join("")}</div></details>` : "");
}

ACTS.person = async (el) => {
  const id = Number(el.dataset.id);
  const box = openDrawer("人");
  await loadPeople();
  const d = await api(`/life/person/${id}`);
  const opts = (cur) => `<option value="">（自动${d.auto_circle ? `：${esc(d.auto_circle)}` : ""}）</option>${st.circles.map((c) => `<option${cur === c ? " selected" : ""}>${esc(c)}</option>`).join("")}`;
  const near = (e) => row(e.name, [e.label, e.rel !== "rel" && `×${Math.round(e.weight)}`, e.last_ts && `最近 ${rel(e.last_ts)}`, e.evidence?.slice(0, 2).join("、")].filter(Boolean).join(" · "), confTag(e.conf),
    e.id.startsWith("p:") ? `data-act="person" data-id="${e.id.slice(2)}"` : e.id.startsWith("m:") ? `data-act="matter" data-id="${e.id.slice(2)}"` : "");
  const relRow = (r) => `<div class="row"><div class="main"><div class="clip">${r.dir === "out" ? `${esc(r.other_name)} 是 TA 的${esc(r.rel)}` : `TA 是 ${esc(r.other_name)} 的${esc(r.rel)}`} ${confTag(r.conf)}</div>${r.evidence ? `<div class="sub">${esc(r.evidence)}</div>` : ""}</div>
    <div class="side">${r.conf === "INFERRED" ? `<button type="button" class="btn small" data-act="relset" data-id="${r.id}" data-a="confirm" data-p="${id}">对</button>` : ""}<button type="button" class="btn small" data-act="relset" data-id="${r.id}" data-a="drop" data-p="${id}">去掉</button></div></div>`;
  box.innerHTML = `
    <form class="card" id="pform">
      <div class="inline wrap"><label class="sr" for="pname">名字</label><input type="text" id="pname" value="${esc(d.name)}" maxlength="40" class="grow">
        <label class="sr" for="pcirc">圈子</label><select id="pcirc">${opts(d.circle)}</select></div>
      <label class="sr" for="pnote">一句话</label><input type="text" id="pnote" value="${esc(d.note ?? "")}" maxlength="300" placeholder="一句话：TA 是什么样的人、怎么相处">
      <div class="inline wrap"><label class="inline"><input type="checkbox" id="phide"${d.hidden ? " checked" : ""}> 藏起来（机器人、无关的人）</label><span class="grow"></span><button type="submit" class="btn small primary">存</button></div>
      <div class="sub">${d.config ? `信任设置在 people.yaml（${esc(d.config.key)}）：关系 ${esc(d.config.relation ?? "—")}${d.config.importance ? ` · importance ${esc(d.config.importance)}` : ""}。要改去「它自己 › 配置」。` : "不在 people.yaml：只是认识，没有任何权限。"}</div>
    </form>
    <section><h3>因缘</h3><div class="card">
      <div>${esc(viaText(d) || "初见不详")}</div>
      <div class="sub">${d.last_seen ? `最近一次 ${esc(rel(d.last_seen))}` : ""}</div>
      <div id="pmonth"></div></div></section>
    <section><h3>身边</h3><div id="pego" class="card"></div></section>
    ${d.relations.length ? `<section><h3>关系</h3><div class="list">${d.relations.map(relRow).join("")}</div></section>` : ""}
    <section><h3>记一条关系</h3><form class="card" id="prel">${nameList()}<datalist id="prels">${st.rels.map((r) => `<option value="${esc(r)}"></option>`).join("")}</datalist>
      <div class="inline wrap"><label class="sr" for="prelwho">谁</label><input type="text" id="prelwho" list="pnames" placeholder="谁" class="grow"> <span>是 TA 的</span>
        <label class="sr" for="prelrel">关系</label><input type="text" id="prelrel" list="prels" placeholder="同事 / 上级 / 家人…" maxlength="12" size="10"><button type="submit" class="btn small primary">记</button></div>
      <div class="sub">你在这里记的算确定的；它从聊天里听来的会标「推测」，等你点「对」。</div></form></section>
    ${d.people.length ? `<section><h3>常一起的人 <span class="sub">${d.people.length}</span></h3><div class="list">${d.people.slice(0, 20).map(near).join("")}</div></section>` : ""}
    ${d.matters.length ? `<section><h3>一起的事</h3><div class="list">${d.matters.map(near).join("")}</div></section>` : ""}
    ${d.places.length ? `<section><h3>常在</h3><div class="list">${d.places.slice(0, 10).map(near).join("")}</div></section>` : ""}
    ${d.pages.length ? `<section><h3>资料和页面</h3><div class="list">${d.pages.slice(0, 15).map(near).join("")}</div></section>` : ""}
    ${d.page ? `<section><h3>人物页 <span class="sub">people/${esc(d.slug)}.md</span></h3><div class="card">${mdText(d.page)}</div></section>` : ""}
    <section><h3>叫法</h3><div class="card"><div class="tags">${d.aliases.map((a) => `<span class="tag">${esc({ name: "名字", feishu: "飞书", wechat: "微信" }[a.kind] ?? a.kind)}：${esc(a.alias)}${d.aliases.length > 1 ? ` <button type="button" class="linkish" data-act="psplit" data-p="${id}" data-k="${esc(a.kind)}" data-v="${esc(a.raw)}" title="这个叫法其实是另一个人">拆出</button>` : ""}</span>`).join("")}</div>
      <form class="inline wrap" id="pmerge"><label class="sr" for="pmergewho">并进来</label><input type="text" id="pmergewho" list="pnames" placeholder="同一个人的另一条" class="grow"><button type="submit" class="btn small">并进来</button></form></div></section>`;
  $("#drawer-title").textContent = d.name;
  if (d.monthly.length > 1) stackedBars($("#pmonth"), d.monthly.map((m) => m.m.slice(2)), [{ label: "TA 说话", color: CAT[0], values: d.monthly.map((m) => m.n) }], { height: 110, aria: `${d.name} 每月说话次数` });
  api(`/life/graph?focus=p:${id}`).then((v) => forceGraph($("#pego"), v, { height: 300, labels: 16, aria: `${d.name} 身边`, empty: "还看不出身边有谁。", onPick: pickNode }));
  $("#pform").addEventListener("submit", (e) => { e.preventDefault(); busy(btnOf(e), "在存…", async () => {
    await api(`/life/person/${id}`, { method: "POST", body: { name: $("#pname").value, circle: $("#pcirc").value || null, note: $("#pnote").value, hidden: $("#phide").checked } });
    toast("存了"); await loadPeople(true); drawPeople();
  }); });
  $("#prel").addEventListener("submit", (e) => { e.preventDefault(); busy(btnOf(e), "在记…", async () => {
    const other = pickId($("#prelwho").value), r = $("#prelrel").value.trim();
    if (!other || !r) { toast("选一个人（从下拉里挑），再写关系"); return; }
    await api("/life/relation", { method: "POST", body: { a: id, b: other, rel: r } });
    toast("记下了"); ACTS.person({ dataset: { id } });
  }); });
  $("#pmerge").addEventListener("submit", (e) => { e.preventDefault(); busy(btnOf(e), "在并…", async () => {
    const other = pickId($("#pmergewho").value);
    if (!other || other === id) { toast("从下拉里挑另一个人"); return; }
    if (!confirm(`把「${$("#pmergewho").value}」并进「${d.name}」？叫法、关系都会归过来。`)) return;
    await api("/life/person/merge", { method: "POST", body: { from: other, into: id } });
    toast("并好了"); await loadPeople(true); drawPeople(); ACTS.person({ dataset: { id } });
  }); });
};
function pickNode(n) {
  if (n.id.startsWith("p:")) ACTS.person({ dataset: { id: n.id.slice(2) } });
  else if (n.id.startsWith("m:")) ACTS.matter({ dataset: { id: n.id.slice(2) } });
  else if (n.id !== "me") toast(n.label);
}
ACTS.relset = (el) => busy(el, "…", async () => {
  await api(`/life/relation/${el.dataset.id}`, { method: "POST", body: { act: el.dataset.a } });
  toast(el.dataset.a === "confirm" ? "确认了" : "去掉了");
  if (el.dataset.p) ACTS.person({ dataset: { id: el.dataset.p } });
});
ACTS.psplit = async (el) => {
  if (!confirm(`「${el.dataset.v.slice(0, 20)}」其实是另一个人？拆出来单独成一个人。`)) return;
  const r = await api("/life/person/split", { method: "POST", body: { from: Number(el.dataset.p), kind: el.dataset.k, alias: el.dataset.v } });
  toast("拆出来了"); await loadPeople(true); drawPeople(); ACTS.person({ dataset: { id: r.id } });
};

// ───────── 因缘 ─────────
export async function yinyuanTab(body) {
  body.innerHTML = `
    <div class="card note"><div class="sub">人和人、人和事是怎么连上的：谁常和谁说话、谁在哪件事里、谁是经由谁出现的。只从记录里算，不调模型；打开这里或它查人时更新，最多 15 分钟一次。下面的「留意」只是摆出来的事实，不是判断。</div></div>
    <div class="filters inline wrap">${chips({ 40: "40 人", 80: "80 人", 150: "150 人" }, String(st.g.limit), "glimit")}
      <label class="inline"><input type="checkbox" id="gmat"${st.g.matters ? " checked" : ""}> 带上事</label><span class="grow"></span>
      <button type="button" class="btn small" data-act="grebuild">现在重算</button></div>
    <div id="ggraph" class="card">${loading()}</div>
    <div id="gobs">${loading()}</div>`;
  $("#gmat").addEventListener("change", (e) => { st.g.matters = e.target.checked; drawCircle(); });
  await loadPeople(true);
  await drawCircle(); await drawObs();   // the circle list below comes with the circle view
}
ACTS.glimit = (el) => { st.g.limit = Number(el.dataset.f); for (const b of $$("[data-act=glimit]")) b.setAttribute("aria-pressed", String(b === el)); drawCircle(); };
ACTS.grebuild = (el) => busy(el, "在算…", async () => { const r = await api("/life/graph/rebuild", { method: "POST" }); toast(`重算了：${r.nodes} 个点、${r.edges} 条线，${r.ms} ms`); await loadPeople(true); await drawCircle(); await drawObs(); });

async function drawCircle() {
  const v = await api(`/life/graph?limit=${st.g.limit}${st.g.matters ? "&matters=1" : ""}`);
  const box = $("#ggraph");
  if (!box) return;
  forceGraph(box, v, { aria: "你身边的人和他们之间的连线", empty: "还没有人。群里、私聊有人说话，或者导入以后，这里会长出来。", onPick: pickNode });
  st.circlesView = v.circles;
}

async function drawObs() {
  const o = await api("/life/yinyuan");
  const box = $("#gobs");
  if (!box) return;
  const byCluster = new Map();
  for (const p of st.list) if (p.cluster != null && !p.hidden) byCluster.set(p.cluster, [...(byCluster.get(p.cluster) ?? []), p]);
  const chip = (p) => `<button type="button" class="tag link" data-act="person" data-id="${p.id}">${esc(p.name)}</button>`;
  const circles = (st.circlesView ?? []).map((c) => `<div class="row"><div class="main"><div class="clip">${esc(c.label)} <span class="sub">${c.size} 人</span></div><div class="tags">${(byCluster.get(c.id) ?? []).sort((a, b) => (b.last_seen ?? 0) - (a.last_seen ?? 0)).slice(0, 12).map(chip).join("")}</div></div></div>`).join("");
  const sec = (title, sub, inner) => inner ? `<section><h2>${esc(title)} <span class="sub">${esc(sub)}</span></h2>${inner}</section>` : "";
  box.innerHTML =
    sec("圈子", "按谁常和谁说话、一起在哪些事里自动分的；名字取大家最常在的群", circles && `<div class="list">${circles}</div>`) +
    sec("新结的缘", "近 30 天第一次出现", o.fresh.length && `<div class="list">${o.fresh.map((p) => row(p.name, viaText(p), "", `data-act="person" data-id="${p.id}"`)).join("")}</div>`) +
    sec("常在一起，还不知道什么关系", "点开记一笔；不记也没关系", o.pairs.length && `<div class="list">${o.pairs.map((x) => row(`${x.a_name} 和 ${x.b_name}`, [`说话挨着 ${Math.round(x.weight)} 次`, x.where.slice(0, 2).join("、"), x.last_ts && `最近 ${rel(x.last_ts)}`].filter(Boolean).join(" · "), "", `data-act="pair" data-a="${x.a}" data-b="${x.b}" data-an="${esc(x.a_name)}" data-bn="${esc(x.b_name)}"`)).join("")}</div>`) +
    sec("牵线的人", "跨着两个以上的圈子", o.bridges.length && `<div class="list">${o.bridges.map((b) => row(b.name, `连着 ${b.circles.join("、")}`, "", `data-act="person" data-id="${b.id}"`)).join("")}</div>`) +
    sec("渐远的", "以前常来往，最近两个月没出现", o.fading.length && `<div class="list">${o.fading.map((p) => row(p.name, `最近 ${rel(p.last_seen)}`, "", `data-act="person" data-id="${p.id}"`)).join("")}</div>`) +
    sec("待认", "", (o.name_only || o.ambiguous.length) && `<div class="card sub">${o.name_only ? `${o.name_only} 个人只见过名字（在「人」最下面）。` : ""}${o.ambiguous.length ? `重名：${o.ambiguous.map((a) => `${esc(a.name)}（${a.n} 个）`).join("、")}。是同一个人就并起来；不是，给其中一个改个名字。` : ""}</div>`) ||
    empty("还看不出什么。");
}
ACTS.pair = (el) => {
  const { a, b, an, bn } = el.dataset;
  const box = openDrawer(`${an} 和 ${bn}`);
  box.innerHTML = `<div class="card"><div class="sub">${esc(bn)} 是 ${esc(an)} 的：</div>${chips(Object.fromEntries(st.rels.map((r) => [r, r])), "", "pairrel", "r")}
    <div class="sub">点一个就记下（算确定的）。也可以分别点开两个人看看。</div>
    <div class="inline wrap"><button type="button" class="btn small" data-act="person" data-id="${a}">${esc(an)}</button><button type="button" class="btn small" data-act="person" data-id="${b}">${esc(bn)}</button></div></div>`;
  box.dataset.a = a; box.dataset.b = b;
};
ACTS.pairrel = (el) => busy(el, "…", async () => {
  const box = $("#drawer-body");
  await api("/life/relation", { method: "POST", body: { a: Number(box.dataset.a), b: Number(box.dataset.b), rel: el.dataset.r } });
  toast(`记下了：${el.dataset.r}`); drawObs();
});
