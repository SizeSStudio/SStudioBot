// 因缘图 (§读4): a small force layout, hand-made SVG, no library. The layout is computed once (300 ticks, deterministic
// seed) and drawn still, so there is nothing to animate (reduced motion is respected for free) and the same data always
// lands in the same place. Solid lines are backed by records; dashed ones are inferred (name match, someone's claim).
// Colors are the categorical slots in fixed order: person, matter, place, page/document; him in ink.

import { esc } from "/lib/core.js";

export const KIND_COLOR = { me: "var(--ink)", person: "var(--t-chat)", matter: "var(--t-work)", place: "var(--t-light)", page: "var(--t-expert)", raw: "var(--t-expert)" };
export const KIND_ZH = { me: "你", person: "人", matter: "事", place: "群", page: "页面", raw: "资料" };

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const hash = (str) => [...str].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function layout(nodes, edges, W, H, focus) {
  const rand = rng(hash(nodes.map((n) => n.id).join("|")));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  // start on rings by cluster so circles begin near each other
  const groups = [...new Set(nodes.map((n) => n.cluster ?? n.kind))];
  const P = nodes.map((n) => {
    const g = groups.indexOf(n.cluster ?? n.kind), a = (g / groups.length) * Math.PI * 2 + rand() * 0.8, r = 80 + rand() * Math.min(W, H) * 0.3;
    return { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
  });
  const L = edges.map((e) => ({ s: idx.get(e.a), t: idx.get(e.b), w: e.weight })).filter((l) => l.s != null && l.t != null);
  const k = Math.sqrt((W * H) / Math.max(nodes.length, 1)) * 0.55;
  const fi = focus ? idx.get(focus) : -1;
  // a node with no lines is only pushed away; pull it in harder so it doesn't shrink everyone else when fitted
  const deg = new Array(P.length).fill(0);
  for (const l of L) { deg[l.s]++; deg[l.t]++; }
  for (let it = 0; it < 300; it++) {
    const cool = 1 - it / 300;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d2 = dx * dx + dy * dy || 0.01;
      const f = (k * k) / d2;
      P[i].vx += dx * f; P[i].vy += dy * f; P[j].vx -= dx * f; P[j].vy -= dy * f;
    }
    for (const l of L) {
      const a = P[l.s], b = P[l.t], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = ((d - k) / d) * Math.min(0.12, 0.03 + Math.log2(1 + l.w) * 0.015);
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      const g = deg[i] ? 0.012 : 0.06;
      p.vx += (W / 2 - p.x) * g; p.vy += (H / 2 - p.y) * g;
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy), cap = 18 * cool + 1;
      if (v > cap) { p.vx *= cap / v; p.vy *= cap / v; }
      if (i === fi) { p.x = W / 2; p.y = H / 2; } else { p.x += p.vx; p.y += p.vy; }
      p.vx *= 0.5; p.vy *= 0.5;
    }
  }
  // fit into the box
  const xs = P.map((p) => p.x), ys = P.map((p) => p.y), pad = 28;
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((W - pad * 2) / Math.max(x1 - x0, 1), (H - pad * 2) / Math.max(y1 - y0, 1), 1.6);
  return P.map((p) => ({ x: pad + (p.x - x0) * s + ((W - pad * 2) - (x1 - x0) * s) / 2, y: pad + (p.y - y0) * s + ((H - pad * 2) - (y1 - y0) * s) / 2 }));
}

/** draw {nodes, edges} into el; onPick(node) on click. Labels for the focus, him and the heaviest nodes; the rest on hover. */
export function forceGraph(el, view, o = {}) {
  const { nodes, edges } = view;
  if (!nodes.length) { el.innerHTML = `<div class="empty">${esc(o.empty ?? "还没有可画的。")}</div>`; return; }
  const W = Math.max(300, el.clientWidth || 640), H = o.height ?? Math.round(Math.min(560, Math.max(340, W * 0.7)));
  const focus = nodes.find((n) => n.focus)?.id;
  const pos = layout(nodes, edges, W, H, focus);
  const at = new Map(nodes.map((n, i) => [n.id, pos[i]]));
  const maxW = Math.max(1, ...nodes.map((n) => n.weight));
  const r = (n) => n.kind === "me" ? 9 : n.focus ? 8 : 3.5 + Math.sqrt(n.weight / maxW) * 7;
  const labelled = new Set([...nodes].sort((a, b) => b.weight - a.weight).slice(0, o.labels ?? 24).map((n) => n.id));
  let g = "";
  edges.forEach((e, j) => {
    const a = at.get(e.a), b = at.get(e.b);
    if (!a || !b) return;
    const w = Math.min(4, 0.75 + Math.log2(1 + e.weight) * 0.45);
    g += `<line data-e="${j}" class="ge${e.conf === "INFERRED" ? " inf" : ""}${e.rel === "rel" ? " rel" : ""}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke-width="${w.toFixed(2)}"><title>${esc(`${e.label}${e.evidence?.length ? `：${e.evidence.slice(0, 3).join("、")}` : ""}${e.conf === "INFERRED" ? "（推测）" : ""}`)}</title></line>`;
  });
  nodes.forEach((n, i) => {
    const p = pos[i], rr = r(n), show = n.kind === "me" || n.focus || labelled.has(n.id);
    const shape = n.kind === "matter" ? `<rect x="${(p.x - rr).toFixed(1)}" y="${(p.y - rr).toFixed(1)}" width="${(rr * 2).toFixed(1)}" height="${(rr * 2).toFixed(1)}" rx="2.5"/>`
      : n.kind === "place" ? `<path d="M${p.x.toFixed(1)},${(p.y - rr * 1.15).toFixed(1)}l${(rr * 1.15).toFixed(1)},${(rr * 1.15).toFixed(1)}l${(-rr * 1.15).toFixed(1)},${(rr * 1.15).toFixed(1)}l${(-rr * 1.15).toFixed(1)},${(-rr * 1.15).toFixed(1)}z"/>`
      : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${rr.toFixed(1)}"/>`;
    g += `<g class="gn${n.focus ? " focus" : ""}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(`${KIND_ZH[n.kind] ?? ""} ${n.label}`)}" style="fill:${KIND_COLOR[n.kind] ?? "var(--muted)"}">${shape}<circle class="hit" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${Math.max(rr + 6, 12)}"/>${show ? `<text x="${p.x.toFixed(1)}" y="${(p.y + rr + 12).toFixed(1)}" text-anchor="middle">${esc(clip(n.label))}</text>` : ""}<title>${esc(`${KIND_ZH[n.kind] ?? ""}：${n.label}`)}</title></g>`;
  });
  const kinds = [...new Set(nodes.map((n) => n.kind))].filter((k) => k !== "me");
  const legend = `<div class="legend">${kinds.map((k) => `<span><span class="tierdot" style="background:${KIND_COLOR[k]}"></span>${esc(KIND_ZH[k] ?? k)}</span>`).join("")}<span class="sub">实线：有记录　虚线：推测</span></div>`;
  el.innerHTML = `${legend}<div class="graph"><svg viewBox="0 0 ${W} ${H}" height="${H}" role="group" aria-label="${esc(o.aria ?? "因缘图")}">${g}</svg></div>`;
  const pick = (t) => { const gEl = t.closest?.(".gn"); if (gEl && o.onPick) o.onPick(nodes[Number(gEl.dataset.i)]); };
  const svg = el.querySelector("svg");
  svg.addEventListener("click", (e) => pick(e.target));
  svg.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(e.target); } });
  // hovering a node lifts it and its ties, dims the rest
  svg.addEventListener("pointerover", (e) => {
    const gEl = e.target.closest?.(".gn");
    if (!gEl) { svg.classList.remove("dim"); return; }
    const id = nodes[Number(gEl.dataset.i)].id, near = new Set([id]);
    for (const x of edges) if (x.a === id) near.add(x.b); else if (x.b === id) near.add(x.a);
    svg.classList.add("dim");
    svg.querySelectorAll(".gn").forEach((n) => n.classList.toggle("lit", near.has(nodes[Number(n.dataset.i)].id)));
    svg.querySelectorAll(".ge").forEach((l) => { const x = edges[Number(l.dataset.e)]; l.classList.toggle("lit", x.a === id || x.b === id); });
  });
  svg.addEventListener("pointerleave", () => svg.classList.remove("dim"));
}
const clip = (s) => { s = String(s ?? ""); return s.length > 10 ? s.slice(0, 9) + "…" : s; };
