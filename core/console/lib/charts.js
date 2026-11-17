// Charts, hand-made SVG. Thin marks, 4px rounded data ends on the baseline, 2px surface gaps between stacked fills,
// recessive grid, a hover tooltip on every bar; a legend whenever there are two or more series.
// Categorical colors are the tier slots in fixed order (--t-chat, --t-work, --t-light, --t-expert), never cycled.

import { esc } from "/lib/core.js";

export const CAT = ["var(--t-chat)", "var(--t-work)", "var(--t-light)", "var(--t-expert)"];

function niceTicks(max) {
  if (!(max > 0)) return [0, 1];
  let step = Math.pow(10, Math.floor(Math.log10(max / 4)));
  for (const m of [1, 2, 2.5, 5, 10]) if (step * m * 4 >= max) { step *= m; break; }
  const out = []; for (let v = 0; v <= max + step * 0.999; v += step) out.push(+v.toPrecision(6));
  return out.length < 2 ? [0, step] : out;
}
const barPath = (x, y, w, h, r) => { r = Math.min(r, h, w / 2); return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`; };
export const legend = (series) => `<div class="legend">${series.map((s) => `<span><span class="tierdot" style="background:${s.color}"></span>${esc(s.label)}</span>`).join("")}</div>`;

/** vertical stacked bars, one per category; series [{label, color, values[]}] */
export function stackedBars(el, cats, series, o = {}) {
  const W = Math.max(240, el.clientWidth || 600), H = o.height ?? 200, L = o.left ?? 46, R = 10, T = 10, B = 22;
  const totals = cats.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
  const top = Math.max(...totals, 0);
  const showRef = o.ref && o.ref.value > 0 && o.ref.value <= Math.max(top * 1.6, 1e-9);
  const ticks = niceTicks(Math.max(top, showRef ? o.ref.value : 0, 1e-9)), max = ticks[ticks.length - 1];
  const pw = W - L - R, ph = H - T - B, bw = pw / cats.length, barW = Math.max(3, Math.min(30, bw * 0.62));
  const y = (v) => T + ph - (v / max) * ph;
  const fy = o.fmtY ?? String;
  let g = ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(fy(t))}</text>`).join("");
  const every = Math.max(1, Math.ceil(cats.length / Math.max(1, Math.floor(pw / 46))));
  cats.forEach((c, i) => {
    const x = L + bw * i + (bw - barW) / 2;
    const segs = series.map((s) => ({ s, v: s.values[i] || 0 })).filter((z) => z.v > 0);
    let acc = 0;
    segs.forEach((z, j) => {
      const y0 = y(acc), y1 = y(acc + z.v); acc += z.v;
      const h = y0 - y1 - (j > 0 ? 2 : 0);
      if (h < 0.6) return;
      g += j === segs.length - 1 ? `<path d="${barPath(x, y1, barW, h, 4)}" fill="${z.s.color}"/>` : `<rect x="${x}" y="${y1}" width="${barW}" height="${h}" fill="${z.s.color}"/>`;
    });
    if (i % every === 0) g += `<text x="${L + bw * i + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(c)}</text>`;
    g += `<rect class="hit" data-i="${i}" x="${L + bw * i}" y="${T}" width="${bw}" height="${ph}"/>`;
  });
  g += `<line class="base" x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}"/>`;
  if (showRef) g += `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(o.ref.value)}" y2="${y(o.ref.value)}"/><text x="${W - R}" y="${y(o.ref.value) - 4}" text-anchor="end">${esc(o.ref.label)}</text>`;
  const leg = series.length > 1 ? legend(series) : "";
  el.innerHTML = `${leg}<div class="chart"><svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="${esc(o.aria ?? "")}">${g}</svg><div class="tip" hidden></div></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".tip"), fv = o.fmtV ?? fy;
  svg.addEventListener("pointermove", (e) => {
    const hit = e.target.closest?.(".hit");
    if (!hit) { tip.hidden = true; return; }
    const i = Number(hit.dataset.i);
    tip.innerHTML = `<b>${esc(o.tipTitle ? o.tipTitle(i) : cats[i])}</b>` + series.map((s) => `<div><span class="tierdot" style="background:${s.color}"></span>${esc(s.label)}　${esc(fv(s.values[i] || 0))}</div>`).join("") +
      (series.length > 1 ? `<div>合计　<b>${esc(fv(totals[i]))}</b></div>` : "");
    tip.hidden = false;
    const cx = ((L + bw * i + bw / 2) / W) * svg.clientWidth, tw = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(0, cx - tw / 2), svg.clientWidth - tw)}px`;
    tip.style.top = `${leg ? 26 : 0}px`;
  });
  svg.addEventListener("pointerleave", () => { tip.hidden = true; });
}

/** one horizontal 100% bar split into parts [{label, value, color}], 2px gaps, hover title per part; legend with values below */
export function shareBar(parts, fmtV = String) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const live = parts.filter((p) => p.value > 0);
  return `<div class="share" role="img" aria-label="${esc(live.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join("，"))}">${live.map((p) =>
    `<i style="flex:${p.value} 1 0;background:${p.color}" title="${esc(`${p.label}：${fmtV(p.value)}（${Math.round((p.value / total) * 100)}%）`)}"></i>`).join("")}</div>
    <div class="legend share-legend">${parts.map((p) => `<span><span class="tierdot" style="background:${p.color}"></span>${esc(p.label)} <b class="tabular">${esc(fmtV(p.value))}</b> <span class="sub">${Math.round((p.value / total) * 100)}%</span></span>`).join("")}</div>`;
}
