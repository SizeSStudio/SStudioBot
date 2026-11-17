// One config file in a text editor: hash-locked save (someone else's change since load → refused, not overwritten),
// server-side schema check before anything is written, git history below. Used by 配置 and by 出生信息 (self.yaml).

import { $, esc, api, toast, row, mdhm, busy, diffHtml } from "/lib/core.js";

/** mount an editor for `file` into `el`. o.note: what the file is for; o.back: href for a back link; o.private: no diff in history */
export async function mountEditor(el, file, o = {}) {
  let cur = await api(`/config/${file}`);
  el.innerHTML = `
    <div class="editor">
      <div class="inline wrap edhead">${o.back ? `<a href="${esc(o.back)}" class="btn small">‹ 全部</a>` : ""}<b class="grow mono">${esc(file)}</b>
        <span class="sub" data-role="dirty" hidden>有没保存的改动</span>
        <button type="button" class="btn small" data-role="reset">放弃改动</button><button type="button" class="btn small primary" data-role="save">保存</button></div>
      ${o.note ? `<div class="sub">${o.note}</div>` : ""}
      <div class="card err" data-role="err" role="alert" hidden></div>
      <label class="sr" for="ed-${esc(file)}">${esc(file)} 内容</label>
      <textarea class="code" id="ed-${esc(file)}" spellcheck="false" autocapitalize="off" autocomplete="off" data-keep="0" rows="22">${esc(cur.text)}</textarea>
      <section><h3>历史</h3><div class="list" data-role="hist"></div></section>
    </div>`;
  const ta = el.querySelector("textarea"), err = el.querySelector("[data-role=err]"), dirty = el.querySelector("[data-role=dirty]");
  const hist = () => { el.querySelector("[data-role=hist]").innerHTML = cur.history.map((h) => row(h.subject, `${h.sha} · ${mdhm(h.at)}`)).join("") || `<div class="empty">（还没有历史）</div>`; };
  const mark = () => { dirty.hidden = ta.value === cur.text; };
  hist();
  ta.addEventListener("input", mark);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); mark(); }
    if (e.key === "Escape") ta.blur();   // a way out of the Tab trap for keyboard users
    if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); el.querySelector("[data-role=save]").click(); }
  });
  el.querySelector("[data-role=reset]").addEventListener("click", () => { ta.value = cur.text; err.hidden = true; mark(); });
  el.querySelector("[data-role=save]").addEventListener("click", (e) => busy(e.currentTarget, "在存…", async () => {
    err.hidden = true;
    try {
      const r = await api(`/config/${file}`, { method: "PUT", body: { text: ta.value, hash: cur.hash } });
      cur = r; ta.value = r.text; mark(); hist();
      toast(!r.changed ? "没有改动" : r.widened?.length ? `已保存。放宽了：${r.widened.join("；")}` : o.private ? "已保存（飞书里只说改了，不显示内容）" : "已保存，管理群会收到通知", 4000);
      o.onSaved?.(r);
    } catch (x) { err.textContent = x.message; err.hidden = false; }
  }));
  return { dirty: () => ta.value !== cur.text };
}
export { diffHtml };
