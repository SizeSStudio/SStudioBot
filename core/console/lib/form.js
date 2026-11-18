// Draws a config form from the description the server sends (DESIGN §10.6). No per-file code beyond two row captions:
// what a field is, what it allows and what it risks all come from GET /api/config/<file>/form. The server checks and
// writes; this file only collects a draft. In a draft a missing key means "leave it", null means "clear it".

import { $, esc, api, toast, rel, mdhm, busy, diffHtml, openDrawer, closeDrawer } from "/lib/core.js";
import { mountEditor } from "/lib/editor.js";

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const blank = (v) => v === undefined || v === null || v === "";
const pk = (p) => JSON.stringify(p);
const getIn = (o, p) => p.reduce((a, k) => (a == null ? undefined : a[k]), o);
function setIn(o, p, v) {
  let a = o;
  p.slice(0, -1).forEach((k, i) => { if (a[k] == null || typeof a[k] !== "object") a[k] = typeof p[i + 1] === "number" ? [] : {}; a = a[k]; });
  a[p[p.length - 1]] = v;
}
const WIDEN = { up: "调大算放宽", down: "调小算放宽", on: "打开算放宽", add: "新增算放宽", remove: "删除算放宽", change: "改动算放宽" };
const EMPTY = { repos: "还没有仓库，先去「代码仓库」添加。", plugins: "服务器上还没装插件。", plugin_secrets: "没有可给插件的密钥，先在「模型与密钥」里写入。", chats: "还没有已知的群。", persons: "还没有见过的人。" };
const ACK_NOTE = "保存后管理群会单独收到一条 ⚠️ 提醒。";

export async function mountConfigForm(el, file, o = {}) {
  const s = { d: null, root: { d: {}, w: null }, base: "", errors: [], top: "", widened: [], notes: [], diff: "", computed: null, stale: false, wizard: null, wizErr: "",
    open: new Set(), q: {}, limit: {}, kvBlank: {}, raw: null, rawOpen: false, timer: 0, seq: 0, ids: new Map() };
  const url = `/config/${file}/form`;
  // lives outside the redraws, so text half-typed into the raw editor survives a change in the form above it
  const rawBox = document.createElement("div");
  rawBox.dataset.r = "rawbox";
  const dirty = () => JSON.stringify(s.root.d) !== s.base;

  // ───────── options and small helpers ─────────
  const visible = (f, scope, fields) => {
    if (!f.showIf) return true;
    const ctl = fields.find((x) => x.key === f.showIf.key);
    return f.showIf.in.includes(scope?.[f.showIf.key] ?? ctl?.default);
  };
  function optionsOf(f) {
    if (f.optionsFrom === "endpoints") return Object.entries(s.root.d.endpoints ?? {}).filter(([, v]) => v !== null).map(([k]) => ({ value: k, label: k }));
    return f.options ?? s.d.context.options?.[f.optionsFrom] ?? [];
  }
  const labelOf = (f, v) => optionsOf(f).find((x) => x.value === v)?.label ?? (v == null ? "" : String(v));
  const idOf = (p) => { const k = pk(p); if (!s.ids.has(k)) s.ids.set(k, `cf${s.ids.size}`); return s.ids.get(k); };
  const attrs = (f, p, kind) => `data-p="${esc(pk(p))}" data-k="${kind}" id="${idOf(p)}"`;

  function optionTags(f, v) {
    const list = optionsOf(f), q = (s.q[pk(f.__p ?? [])] ?? "").trim().toLowerCase();
    const shown = list.filter((x) => x.value === v || !q || String(x.label).toLowerCase().includes(q) || String(x.value).toLowerCase().includes(q)).slice(0, 300);
    const none = f.required ? (blank(v) ? `<option value="">请选择</option>` : "") : `<option value=""${blank(v) ? " selected" : ""}>${esc(f.default !== undefined ? `默认（${labelOf(f, f.default)}）` : "不设置")}</option>`;
    const cur = !blank(v) && !list.some((x) => x.value === v) ? `<option value="${esc(JSON.stringify(v))}" selected>${esc(String(v))}（现在的值，不在列表里）</option>` : "";
    return none + cur + shown.map((x) => `<option value="${esc(JSON.stringify(x.value))}"${x.value === v ? " selected" : ""}>${esc(x.label)}</option>`).join("");
  }

  // ───────── one control ─────────
  function control(f, p, v) {
    const id = idOf(p);
    if (f.readonly) return `<div class="fro mono">${esc(isObj(v) || Array.isArray(v) ? JSON.stringify(v) : blank(v) ? "—" : typeof v === "boolean" ? (v ? "是" : "否") : String(v))}</div>`;
    const ph = f.placeholder ?? (f.default !== undefined && typeof f.default !== "object" ? String(f.default) : "");
    const unit = f.unit ? `<span class="sub funit">${esc(f.unit)}</span>` : "";
    switch (f.type) {
      case "number": {
        const min = f.min ?? (f.exclusiveMin !== undefined ? f.exclusiveMin : undefined);
        return `<div class="inline fnum"><input type="number" inputmode="decimal" step="${f.integer ? 1 : "any"}"${min !== undefined ? ` min="${min}"` : ""}${f.max !== undefined ? ` max="${f.max}"` : ""} placeholder="${esc(ph)}" value="${esc(v ?? "")}" ${attrs(f, p, "num")}>${unit}</div>`;
      }
      case "bool": return `<label class="fsw"><input type="checkbox" role="switch"${(v ?? f.default) === true ? " checked" : ""} ${attrs(f, p, "bool")} aria-label="${esc(f.label)}"><i></i></label>`;
      case "select": return `<select ${attrs(f, p, "sel")}${f.required ? " required" : ""}>${optionTags(f, v)}</select>`;
      case "segment": {
        const cur = v ?? null, btn = (val, label, title) => `<button type="button" aria-pressed="${cur === val}" data-p="${esc(pk(p))}" data-k="seg" data-v="${esc(JSON.stringify(val))}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button>`;
        return `<div class="seg" role="group" aria-label="${esc(f.label)}">${f.required ? "" : btn(null, "默认", f.default !== undefined ? `默认：${labelOf(f, f.default)}` : "")}${f.options.map((x) => btn(x.value, x.label, x.help)).join("")}</div>`;
      }
      case "time": return `<input type="time" value="${esc(/^\d:/.test(v ?? "") ? `0${v}` : v ?? "")}" ${attrs(f, p, "text")}>`;
      case "duration": {
        const m = /^(\d+)([mhd])$/.exec(String(v ?? "")), u = m?.[2] ?? "m";
        return `<div class="inline fnum"><input type="number" min="1" step="1" inputmode="numeric" placeholder="${esc(/^\d+/.exec(String(f.default ?? ""))?.[0] ?? "")}" value="${esc(m?.[1] ?? "")}" ${attrs(f, p, "dur")}>
          <select data-p="${esc(pk(p))}" data-k="dur-u" aria-label="单位">${[["m", "分钟"], ["h", "小时"], ["d", "天"]].map(([x, l]) => `<option value="${x}"${x === u ? " selected" : ""}>${l}</option>`).join("")}</select></div>`;
      }
      case "tags": {
        const list = v ?? f.default ?? [];
        return `<div class="ftags">${list.map((t, i) => `<span class="ftag">${esc(t)}<button type="button" aria-label="去掉 ${esc(t)}" data-p="${esc(pk(p))}" data-k="tag-del" data-i="${i}">×</button></span>`).join("")}
          <input type="text" placeholder="${esc(ph || "输入后按回车")}" autocapitalize="off" spellcheck="false" data-keep="0" ${attrs(f, p, "tag-add")}></div>`;
      }
      case "multiselect": {
        const list = optionsOf(f), cur = v ?? [], extra = cur.filter((x) => !list.some((y) => y.value === x)).map((x) => ({ value: x, label: `${x}（不在列表里）` }));
        const all = [...list, ...extra];
        return all.length ? `<div class="fchecks">${all.map((x) => `<label><input type="checkbox"${cur.includes(x.value) ? " checked" : ""} data-p="${esc(pk(p))}" data-k="multi" data-v="${esc(x.value)}"> <span class="mono">${esc(x.label)}</span></label>`).join("")}</div>` : `<div class="sub">${esc(EMPTY[f.optionsFrom] ?? "没有可选项。")}</div>`;
      }
      case "picker": {
        const list = optionsOf(f);
        if (f.open) return `<input type="text" list="${id}-l" autocapitalize="off" spellcheck="false" data-keep="0" placeholder="${esc(ph)}" value="${esc(v ?? "")}" ${attrs(f, p, "text")}><datalist id="${id}-l">${list.map((x) => `<option value="${esc(x.value)}">${esc(x.label)}</option>`).join("")}</datalist>`;
        if (!list.length && blank(v)) return `<div class="sub">${esc(EMPTY[f.optionsFrom] ?? "没有可选项。")}</div>`;
        f.__p = p;
        const search = list.length > 12 ? `<input type="search" placeholder="搜（共 ${list.length} 个）" aria-label="搜 ${esc(f.label)}" value="${esc(s.q[pk(p)] ?? "")}" data-p="${esc(pk(p))}" data-k="pick-q" data-keep="0">` : "";
        return `<div class="fpick">${search}<select ${attrs(f, p, "sel")}>${optionTags(f, v)}</select></div>`;
      }
      case "kv": return kvControl(f, p, v);
      default: {
        const list = f.suggest?.length ? ` list="${id}-l"` : "";
        return `<input type="text"${list} autocapitalize="off" spellcheck="false" data-keep="0" placeholder="${esc(ph)}" value="${esc(v ?? "")}" ${attrs(f, p, "text")}>${f.suggest?.length ? `<datalist id="${id}-l">${f.suggest.map((x) => `<option value="${esc(x)}"></option>`).join("")}</datalist>` : ""}`;
      }
    }
  }

  function kvControl(f, p, v) {
    const entries = Object.entries(v ?? {}), blanks = s.kvBlank[pk(p)] ?? 0, opts = f.keyField?.optionsFrom ? s.d.context.options?.[f.keyField.optionsFrom] ?? [] : null;
    const keyInput = (k) => opts
      ? `<select data-kv="k" aria-label="${esc(f.keyField.label)}"><option value="">请选择</option>${!k || opts.some((x) => x.value === k) ? "" : `<option value="${esc(k)}" selected>${esc(k)}</option>`}${opts.map((x) => `<option value="${esc(x.value)}"${x.value === k ? " selected" : ""}>${esc(x.label)}</option>`).join("")}</select>`
      : `<input type="text" data-kv="k" data-keep="0" aria-label="${esc(f.keyField?.label ?? "名字")}" placeholder="${esc(f.keyField?.label ?? "名字")}" value="${esc(k)}">`;
    const row = (k, x) => {
      const nested = x !== null && typeof x === "object";
      const val = nested ? `<input type="text" disabled value="${esc(JSON.stringify(x))}" data-raw="${esc(JSON.stringify(x))}" data-kv="v" title="结构复杂，去高级里改">`
        : `<input type="${f.valueType === "number" ? "number" : "text"}" data-kv="v" data-keep="0" aria-label="值" value="${esc(x ?? "")}"${f.valueType === "number" ? ` min="0" step="any" placeholder="${esc(f.unit ?? "")}"` : ""}>`;
      return `<div class="inline fkv" data-kvrow>${keyInput(k)}${val}<button type="button" class="btn small" data-p="${esc(pk(p))}" data-k="kv-del" aria-label="删掉这一行">×</button></div>`;
    };
    return `<div data-kvbox="${esc(pk(p))}">${entries.map(([k, x]) => row(k, x)).join("")}${Array.from({ length: blanks }, () => row("", "")).join("")}
      <button type="button" class="btn small" data-p="${esc(pk(p))}" data-k="kv-add">加一行</button></div>`;
  }

  // ───────── fields, groups, rows ─────────
  function usageLine(f, v) {
    if (!f.usage) return "";
    const used = s.d.context.usage?.[f.usage];
    if (used === undefined) return "";
    const limit = v ?? f.default, money = /美元/.test(f.unit ?? ""), show = (n) => (money ? `$${Number(n).toFixed(2)}` : String(n));
    const pct = limit ? Math.min(100, (used / limit) * 100) : null;
    return `<div class="sub">今天已用 <b>${esc(show(used))}</b>${limit ? ` / ${esc(show(limit))}` : ""}</div>${pct === null ? "" : `<div class="meter"><i style="width:${pct.toFixed(1)}%${pct >= 100 ? ";background:var(--crit)" : pct >= 80 ? ";background:var(--serious)" : ""}"></i></div>`}`;
  }

  function fieldHtml(f, p, scope) {
    const v = f.key === "." ? scope : scope?.[f.key];
    if (f.type === "group") return groupHtml(f, p, v);
    if (f.type === "list" || f.type === "map") return rowsHtml(f, p, v);
    const tag = f.widen && !f.readonly ? `<span class="tag fwarn">${WIDEN[f.widen.when]}</span>` : "";
    const isBool = f.type === "bool";
    const label = `<label class="ffl" for="${idOf(p)}">${esc(f.label)}${f.required && !f.readonly ? ` <span class="sub">必填</span>` : ""}</label>`;
    return `<div class="ff${isBool ? " ffb" : ""}"><div class="ffh">${label}${tag}${isBool ? control(f, p, v) : ""}</div>${isBool ? "" : control(f, p, v)}
      ${usageLine(f, v)}${f.help ? `<div class="sub">${esc(f.help)}</div>` : ""}<div class="err ffe" data-e="${esc(pk(p))}" hidden></div></div>`;
  }

  function fieldsHtml(fields, base, scope, skip = []) {
    const shown = fields.filter((f) => !skip.includes(f.key) && visible(f, scope, fields));
    const at = (f) => (f.key === "." ? base : [...base, f.key]);
    const main = shown.filter((f) => !f.advanced), more = shown.filter((f) => f.advanced);
    const k = pk([...base, "$more"]);
    return main.map((f) => fieldHtml(f, at(f), scope)).join("") + (more.length ? `<details class="fmore" data-open="${esc(k)}"${s.open.has(k) ? " open" : ""}><summary>更多设置</summary>${more.map((f) => fieldHtml(f, at(f), scope)).join("")}</details>` : "");
  }

  function groupHtml(f, p, v) {
    return `<fieldset class="fg"><legend>${esc(f.label)}</legend>${f.help ? `<div class="sub">${esc(f.help)}</div>` : ""}${fieldsHtml(f.fields, p, v ?? {})}<div class="err ffe" data-e="${esc(pk(p))}" hidden></div></fieldset>`;
  }

  const rowKeys = (f, v, sibling) => {
    const skip = new Set([...(f.excludeKeys ?? []), ...sibling]);
    const have = Object.keys(v ?? {}).filter((k) => !skip.has(k) && v[k] !== null);
    if (!f.keysFrom) return have;
    const known = (s.d.context.options?.[f.keysFrom] ?? []).map((x) => String(x.value));
    return [...known, ...have.filter((k) => !known.includes(k))];
  };

  function rowMeta(f, key, item) {
    if (f.rowMeta === "job") {
      if (item?.enabled === false) return "已暂停";
      const next = s.computed?.next && key in s.computed.next ? s.computed.next[key] : s.d.context.jobs?.[key]?.next, last = s.d.context.jobs?.[key]?.last;
      return [next ? `下次 ${mdhm(next)}` : "下次时间待定", last ? `上次 ${mdhm(last.at)} ${String(last.outcome).split(" ")[0]}` : ""].filter(Boolean).join(" · ");
    }
    if (f.rowMeta === "source") {
      if (item?.enabled === false) return "已暂停";
      const l = s.d.context.sources?.[key];
      return !l ? "还没拉过" : l.ok ? `上次 ${rel(l.at)}，新 ${l.n} 条` : `上次 ${rel(l.at)} 出错：${l.err ?? ""}`;
    }
    return "";
  }

  function rowHtml(f, p, key, item, chat) {
    const skip = f.inline ?? [], opt = f.titleFrom ? f.fields.find((x) => x.key === f.titleFrom) : null;
    const kind = opt ? optionsOfField(opt).find((x) => x.value === item?.[f.titleFrom]) : null;
    const title = chat?.label ?? (f.type === "map" && kind ? kind.label : item?.name ?? key);
    const sub = chat ? chat.help : [f.type === "map" && kind ? key : kind?.label, kind?.help].filter(Boolean).join(" · ");
    const meta = rowMeta(f, key, item);
    const shown = f.fields.filter((x) => skip.includes(x.key) && visible(x, item, f.fields));
    const inline = shown.map((x) => `<div class="fin"${x.type === "bool" ? "" : ` title="${esc(x.label)}"`}>${x.type === "bool" ? "" : `<label class="sr" for="${idOf([...p, x.key])}">${esc(x.label)}</label>`}${control(x, [...p, x.key], item?.[x.key])}<div class="err ffe" data-e="${esc(pk([...p, x.key]))}" hidden></div></div>`).join("");
    const rest = f.fields.filter((x) => !skip.includes(x.key) && !(x.readonly && blank(item?.[x.key])) && !(x.createOnly && x.type !== "bool" && (x.key === f.titleFrom || x.key === f.identity)) && visible(x, item, f.fields));
    const k = pk(p), body = fieldsHtml(rest, p, item ?? {}), rm = f.removable ? `<button type="button" class="btn small danger" data-k="rm" data-p="${esc(k)}">删除</button>` : "";
    return `<div class="frow"><div class="frh"><div class="main"><div class="clip"><b>${esc(title)}</b></div>${sub ? `<div class="sub">${esc(sub)}</div>` : ""}${meta ? `<div class="sub">${esc(meta)}</div>` : ""}</div><div class="fri">${inline}</div></div>
      ${body || rm ? `<details data-open="${esc(k)}"${s.open.has(k) ? " open" : ""}><summary>${f.keysFrom ? "详情" : "设置"}</summary><div class="frb">${body}${rm ? `<div class="actions">${rm}</div>` : ""}</div></details>` : ""}<div class="err ffe" data-e="${esc(k)}" hidden></div></div>`;
  }
  const optionsOfField = (x) => x.options ?? optionsOf(x);

  function rowsInner(f, p, v, sibling) {
    if (f.type === "list") return (v ?? []).map((item, i) => rowHtml(f, [...p, i], String(item?.[f.identity] ?? i + 1), item)).join("");
    const k = pk(p), q = (s.q[k] ?? "").trim().toLowerCase(), opts = f.keysFrom ? s.d.context.options?.[f.keysFrom] ?? [] : [];
    const chat = (id) => opts.find((x) => x.value === id);
    let keys = rowKeys(f, v, sibling);
    if (q) keys = keys.filter((id) => id.toLowerCase().includes(q) || String(chat(id)?.label ?? "").toLowerCase().includes(q));
    const limit = s.limit[k] ?? 60, shown = f.keysFrom ? keys.slice(0, limit) : keys;
    return shown.map((id) => rowHtml(f, [...p, id], id, v?.[id], f.keysFrom ? chat(id) ?? { label: v?.[id]?.name ?? id, help: "不在已知的群里" } : undefined)).join("") +
      (shown.length < keys.length ? `<div class="more"><button type="button" class="btn" data-k="more" data-p="${esc(k)}">再显示一些（还有 ${keys.length - shown.length} 个）</button></div>` : "");
  }

  function rowsHtml(f, p, v) {
    const k = pk(p), sibling = f.key === "." ? s.d.spec.sections.flatMap((x) => x.fields).map((x) => x.key).filter((x) => x !== ".") : [];
    const inner = rowsInner(f, p, v, sibling), w = s.wizard?.k === k;
    const search = f.keysFrom ? `<input type="search" placeholder="搜群名" aria-label="搜群名" value="${esc(s.q[k] ?? "")}" data-k="rows-q" data-p="${esc(k)}" data-keep="0">` : "";
    return `<div class="frows">${search}<div class="list" data-rows="${esc(k)}">${inner || `<div class="empty">还没有。</div>`}</div>
      ${w ? wizardHtml(f) : f.add ? `<div class="actions"><button type="button" class="btn" data-k="add" data-p="${esc(k)}">＋ ${esc(f.add.label)}</button></div>` : ""}<div class="err ffe" data-e="${esc(k)}" hidden></div></div>`;
  }

  // ───────── add wizard: the row's own fields, a step at a time ─────────
  // lists keep their key in a field of the row; only maps ask for one separately
  const keyPseudo = (f) => (f.keyField ? { key: "$key", type: "text", required: true, label: f.keyField.label, help: f.keyField.help, placeholder: f.keyField.placeholder, pattern: f.keyField.pattern, patternHint: f.keyField.patternHint } : null);
  const wizardFields = (f) => [...f.fields, keyPseudo(f)].filter(Boolean);
  const stepFields = (f) => f.add.steps[s.wizard.step].fields.map((k) => (k === "$key" ? keyPseudo(f) : f.fields.find((x) => x.key === k))).filter(Boolean);
  function wizardHtml(f) {
    const w = s.wizard, st = f.add.steps[w.step], all = wizardFields(f);
    const shown = stepFields(f).filter((x) => visible(x, s.root.w, all)).map((x) => ({ ...x, readonly: false, createOnly: false, advanced: false }));
    const last = w.step === f.add.steps.length - 1;
    return `<div class="card fwiz"><div class="inline"><b class="grow">${esc(f.add.label)}</b><span class="sub">第 ${w.step + 1} / ${f.add.steps.length} 步：${esc(st.title)}</span></div>
      ${st.help ? `<div class="sub">${esc(st.help)}</div>` : ""}${shown.map((x) => fieldHtml(x, ["w", x.key], s.root.w)).join("") || `<div class="sub">这一类不用再填别的。</div>`}
      ${s.wizErr ? `<div class="err">${esc(s.wizErr)}</div>` : ""}
      <div class="actions"><button type="button" class="btn" data-k="wiz-cancel">取消</button>${w.step ? `<button type="button" class="btn" data-k="wiz-back">上一步</button>` : ""}<button type="button" class="btn primary" data-k="wiz-next">${last ? "加进列表" : "下一步"}</button></div></div>`;
  }
  function suggestKey(f) {
    for (const k of f.add.suggestKey ?? []) {
      let v = s.root.w[k];
      if (blank(v)) continue;
      if (k === "url") { try { v = new URL(v).hostname.split(".").slice(-2, -1)[0] ?? v; } catch { continue; } }
      const sep = /-/.test(f.keyField?.pattern ?? f.fields.find((x) => x.key === f.identity)?.pattern ?? "") ? "-" : "_";
      const base = String(v).toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(/^[^a-z]+|[^a-z0-9]+$/g, "");
      if (!base) continue;
      const taken = (x) => (f.type === "list" ? (getIn(s.root, s.wizard.path) ?? []).some((r) => r?.[f.identity] === x) : getIn(s.root, s.wizard.path)?.[x] != null);
      let out = base.length > 1 ? base : `${base}${sep}1`;
      for (let i = 2; taken(out); i++) out = `${base}${sep}${i}`;
      return out;
    }
    return "";
  }
  function wizardStep(f, dir) {
    s.wizErr = "";
    if (dir > 0) {
      const all = wizardFields(f);
      for (const x of stepFields(f)) {
        if (!visible(x, s.root.w, all)) continue;
        const v = s.root.w[x.key];
        if (x.required && (blank(v) || (Array.isArray(v) && !v.length))) { s.wizErr = `「${x.label}」要填`; return draw(); }
        if (!blank(v) && x.pattern && typeof v === "string" && !new RegExp(x.pattern).test(v)) { s.wizErr = `「${x.label}」${x.patternHint ?? "格式不对"}`; return draw(); }
      }
      const key = f.type === "list" ? s.root.w[f.identity] : s.root.w.$key, cur = getIn(s.root, s.wizard.path);
      if (!blank(key) && (f.type === "list" ? (cur ?? []).some((r) => r?.[f.identity] === key) : cur?.[key] != null)) { s.wizErr = `已经有叫「${key}」的了`; return draw(); }
    }
    const next = s.wizard.step + dir;
    if (next >= f.add.steps.length) {
      const item = clone(s.root.w), key = item.$key;
      delete item.$key;
      if (f.type === "list") setIn(s.root, s.wizard.path, [...(getIn(s.root, s.wizard.path) ?? []), item]);
      else setIn(s.root, [...s.wizard.path, key], item);
      s.wizard = null; s.root.w = null;
      changed(true);
      return;
    }
    s.wizard.step = next;
    const slot = f.type === "list" ? f.identity : "$key";
    if (f.add.steps[next].fields.includes(slot) && blank(s.root.w[slot])) s.root.w[slot] = suggestKey(f);
    draw();
  }
  const findField = (p) => {   // the list / map field a row path belongs to
    const walk = (fields, base) => {
      for (const f of fields) {
        const at = f.key === "." ? base : [...base, f.key];
        if (pk(at) === pk(p) && (f.type === "list" || f.type === "map")) return f;
        if (f.type === "group") { const r = walk(f.fields, at); if (r) return r; }
      }
    };
    return walk(s.d.spec.sections.flatMap((x) => x.fields), ["d"]);
  };

  // ───────── the page ─────────
  function draw() {
    const d = s.d, active = document.activeElement, focus = active && el.contains(active) ? { p: active.dataset?.p, k: active.dataset?.k, at: active.selectionStart } : null;
    s.ids = new Map();
    const sections = d.broken ? "" : d.spec.sections.map((x, i) => {
      const body = `${x.help ? `<div class="sub">${esc(x.help)}</div>` : ""}<div class="card fsec">${fieldsHtml(x.fields, ["d"], s.root.d)}</div>`, k = pk(["$sec", i]);
      return x.advanced ? `<section><details data-open="${esc(k)}"${s.open.has(k) ? " open" : ""}><summary><h2>${esc(x.title)}</h2></summary>${body}</details></section>` : `<section><h2>${esc(x.title)}</h2>${body}</section>`;
    }).join("");
    el.innerHTML = `<div class="cform">
      <div class="inline wrap">${o.back ? `<a href="${esc(o.back)}" class="btn small">‹ 全部</a>` : ""}<b class="grow">${esc(d.spec.title)}</b><span class="sub mono">${esc(file)}</span></div>
      <div class="sub">${esc(d.spec.summary)}${d.exists ? "" : " 这个文件还不存在，保存时才创建，没改的项继续用默认值。"}</div>
      ${d.broken ? `<div class="card err" role="alert">这个文件现在解析不了（${esc(d.broken)}），表单先停用。控制台存不了它，要在服务器上修好文件；下面可以看原文。</div>` : ""}
      <div class="card err" data-r="stale" role="alert" hidden>这个文件在你打开之后被改过了（卡片、命令或别处）。<div class="actions"><button type="button" class="btn small" data-k="reload">载入最新内容（放弃这里的改动）</button></div></div>
      <div class="card err" data-r="errs" role="alert" hidden></div>
      ${sections}
      ${d.unknown.length ? `<section><h2>表单不认识的内容</h2><div class="card note"><div class="sub">这些写在文件里，表单没有对应的项。保存时原样保留，要改去「高级 › 查看原文」。</div><div class="list">${d.unknown.map((u) => `<div class="row"><div class="main"><code>${esc(u.path)}</code><div class="sub clip mono">${esc(u.value)}</div></div></div>`).join("")}</div></div></section>` : ""}
      <section><details class="fraw" data-r="raw"${s.rawOpen || d.broken ? " open" : ""}><summary><h2>高级 › 查看原文</h2></summary><div class="sub">出问题时兜底，也能看历史。保存同样要过校验、进 git、通知管理群。</div><div data-r="rawslot"></div></details></section>
      <div class="fbar"><div class="grow"><div class="sub" data-r="state"></div><div class="fwide" data-r="wide" hidden></div><details data-r="diffw" hidden><summary>将写入的改动</summary><div data-r="diff"></div></details></div>
        <button type="button" class="btn small" data-k="reset">放弃改动</button><button type="button" class="btn small primary" data-k="save"${d.broken ? " disabled" : ""}>保存</button></div>
    </div>`;
    if (focus?.p) {
      const t = [...el.querySelectorAll("[data-p]")].find((x) => x.dataset.p === focus.p && x.dataset.k === focus.k);
      if (t) { t.focus({ preventScroll: true }); if (typeof focus.at === "number") { try { t.setSelectionRange(focus.at, focus.at); } catch { /* not a text input */ } } }
    }
    el.querySelector("[data-r=rawslot]").append(rawBox);
    paint();
    if (s.rawOpen || d.broken) mountRaw().catch((x) => toast(x.message, 6000));
  }

  function paint() {
    const r = (n) => el.querySelector(`[data-r=${n}]`), isDirty = dirty();
    r("stale").hidden = !s.stale;
    r("state").textContent = !isDirty ? "没有改动" : s.errors.length ? `有 ${s.errors.length} 项要改` : "有没保存的改动";
    const errs = r("errs");
    errs.hidden = !s.errors.length && !s.top;
    errs.innerHTML = `${s.top ? `<div>${esc(s.top)}</div>` : ""}${s.errors.length ? `<ul class="notes">${s.errors.map((e) => `<li><b>${esc(e.label)}</b>：${esc(e.message)}</li>`).join("")}</ul>` : ""}`;
    for (const x of el.querySelectorAll("[data-e]")) { x.hidden = true; x.textContent = ""; }
    const slots = new Map([...el.querySelectorAll("[data-e]")].map((x) => [x.dataset.e, x]));
    for (const e of s.errors) {
      for (let n = e.path.length; n >= 0; n--) {
        const x = slots.get(pk(["d", ...e.path.slice(0, n)]));
        if (!x) continue;
        x.textContent = x.textContent ? `${x.textContent}；${e.message}` : e.message; x.hidden = false;
        for (let up = x.closest("details"); up; up = up.parentElement?.closest("details")) up.open = true;
        break;
      }
    }
    const wide = r("wide"), lines = [...s.widened, ...s.notes];
    wide.hidden = !lines.length || !isDirty;
    wide.innerHTML = lines.length ? `<b>⚠️ 这次改动放宽了限制</b><ul class="notes">${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : "";
    r("diffw").hidden = !s.diff || !isDirty;
    r("diff").innerHTML = s.diff ? diffHtml(s.diff) : "";
  }

  async function mountRaw() {
    if (s.rawLoading || rawBox.firstChild) return;
    s.rawLoading = true;
    try { s.raw = await mountEditor(rawBox, file, { note: "这是文件原文。", onSaved: () => load() }); }
    finally { s.rawLoading = false; }
  }

  async function load() { apply(await api(url)); }
  function apply(d) {
    rawBox.replaceChildren(); s.raw = null;   // its hash is out of date now
    s.d = d; s.root.d = isObj(d.values) ? clone(d.values) : {}; s.root.w = null; s.base = JSON.stringify(s.root.d);
    Object.assign(s, { errors: [], top: "", widened: [], notes: [], diff: "", computed: null, stale: false, wizard: null, wizErr: "", kvBlank: {} });
    draw();
  }

  async function preview() {
    const seq = ++s.seq;
    const p = await api(`${url}/preview`, { method: "POST", body: { values: s.root.d, hash: s.d.hash } });
    if (seq === s.seq) { Object.assign(s, { errors: p.errors, widened: p.widened, notes: p.notes, diff: p.diff, computed: p.computed ?? null, stale: p.stale, top: "" }); }
    return p;
  }
  function changed(redraw) {
    if (redraw) draw(); else paint();
    clearTimeout(s.timer);
    if (!dirty()) { Object.assign(s, { errors: [], widened: [], notes: [], diff: "", computed: null, top: "" }); if (redraw) draw(); else paint(); return; }
    s.timer = setTimeout(async () => {
      try {
        const hadNext = JSON.stringify(s.computed?.next ?? null); await preview();
        // next-run times live in the row captions, which only a redraw updates; never redraw under someone typing
        if (JSON.stringify(s.computed?.next ?? null) !== hadNext && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) draw(); else paint();
      } catch (e) { s.top = e.message; paint(); }
    }, 350);
  }

  const confirmWiden = (p) => new Promise((resolve) => {
    const box = openDrawer("确认放宽限制", `<div class="card note"><div class="sub">${esc(ACK_NOTE)}</div></div>
      <section><h3>这次放宽了</h3><ul class="notes">${p.widened.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></section>
      ${p.notes.length ? `<section><h3>后果</h3><ul class="notes">${p.notes.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></section>` : ""}`,
      `<button type="button" class="btn small danger" id="cf-yes">确认并保存</button>`);
    const dlg = box.closest("dialog"); let done = false;
    const end = (v) => { if (done) return; done = true; dlg.removeEventListener("close", no); resolve(v); };
    const no = () => end(false);
    dlg.addEventListener("close", no);
    $("#cf-yes").addEventListener("click", () => { end(true); closeDrawer(); }, { once: true });
  });

  async function save(btn) {
    clearTimeout(s.timer);
    if (s.raw?.dirty() && !confirm("「查看原文」里有没保存的改动，保存表单会丢掉它们。继续？")) return;
    await busy(btn, "在存…", async () => {
      s.top = "";
      try {
        const p = await preview();
        if (p.stale) return paint();
        if (p.errors.length) { paint(); el.querySelector("[data-r=errs]").scrollIntoView({ block: "nearest" }); return; }
        if (!p.changed) { paint(); toast("没有改动"); return; }
        if ((p.widened.length || p.notes.length) && !(await confirmWiden(p))) return paint();
        const r = await api(url, { method: "PUT", body: { values: s.root.d, hash: s.d.hash, ack: p.widened } });
        apply(r);
        toast(r.widened?.length ? `已保存。放宽了：${r.widened.join("；")}` : "已保存，管理群会收到通知", 4000);
        o.onSaved?.(r);
      } catch (e) {
        if (e.status === 422 && e.body?.errors) { s.errors = e.body.errors; s.top = e.message; }
        else if (e.status === 409 && !e.body?.need_ack) s.stale = true;
        else s.top = e.message;
        paint();
        el.querySelector("[data-r=errs]").scrollIntoView({ block: "nearest" });
      }
    });
  }

  // ───────── events ─────────
  const parseV = (t) => (t === "" ? null : JSON.parse(t));
  const pathOf = (t) => JSON.parse(t.dataset.p);
  function setDur(t) {
    const p = pathOf(t), wrap = t.closest(".fnum"), n = wrap.querySelector("[data-k=dur]").value, u = wrap.querySelector("[data-k=dur-u]").value;
    setIn(s.root, p, n ? `${n}${u}` : null);
  }
  function readKv(box) {
    const p = JSON.parse(box.dataset.kvbox), orig = getIn(JSON.parse(s.base), p.slice(1)) ?? {}, f = {};
    let blanks = 0;
    for (const row of box.querySelectorAll("[data-kvrow]")) {
      const k = row.querySelector("[data-kv=k]").value.trim(), input = row.querySelector("[data-kv=v]");
      if (!k) { blanks++; continue; }
      if (input.dataset.raw) { f[k] = JSON.parse(input.dataset.raw); continue; }
      const t = input.value;
      f[k] = input.type === "number" ? (t === "" ? null : Number(t)) : String(orig[k]) === t ? orig[k] : t;
    }
    s.kvBlank[box.dataset.kvbox] = blanks;
    setIn(s.root, p, f);
  }

  el.addEventListener("input", (e) => {
    const t = e.target, k = t.dataset.k;
    if (t.closest("[data-r=rawbox]")) return;
    if (t.dataset.kv) { readKv(t.closest("[data-kvbox]")); return changed(); }
    if (k === "text") { setIn(s.root, pathOf(t), t.value === "" ? null : t.value); changed(); }
    else if (k === "num") { setIn(s.root, pathOf(t), t.value === "" ? null : Number(t.value)); changed(); }
    else if (k === "dur") { setDur(t); changed(); }
    else if (k === "pick-q") {
      s.q[t.dataset.p] = t.value;
      const sel = t.parentElement.querySelector("select"), p = pathOf(t), f = fieldAtPath(p);
      if (sel && f) sel.innerHTML = optionTags({ ...f, __p: p }, getIn(s.root, p));
    } else if (k === "rows-q") {
      s.q[t.dataset.p] = t.value; delete s.limit[t.dataset.p];
      redrawRows(t.dataset.p);
    }
  });
  function fieldAtPath(p) {
    let fields = s.d.spec.sections.flatMap((x) => x.fields), f;
    for (let i = 1; i < p.length; i++) {
      f = fields.find((x) => x.key === p[i]);
      if (!f) { const m = fields.find((x) => x.key === "."); if (!m) return null; fields = m.fields; f = m; continue; }
      if (f.type === "list" || f.type === "map") { i++; }
      fields = f.fields ?? [];
    }
    return f;
  }
  function redrawRows(k) {
    const p = JSON.parse(k), f = findField(p), box = el.querySelector(`[data-rows="${CSS.escape(k)}"]`);
    if (f && box) { box.innerHTML = rowsInner(f, p, getIn(s.root, p), []) || `<div class="empty">没有匹配的。</div>`; paint(); }
  }

  el.addEventListener("change", (e) => {
    const t = e.target, k = t.dataset.k;
    if (t.closest("[data-r=rawbox]")) return;
    if (t.dataset.kv) { readKv(t.closest("[data-kvbox]")); return changed(t.tagName === "SELECT"); }
    if (k === "bool") { setIn(s.root, pathOf(t), t.checked); changed(true); }
    else if (k === "sel") { setIn(s.root, pathOf(t), parseV(t.value)); changed(true); }
    else if (k === "dur-u") { setDur(t); changed(); }
    else if (k === "multi") {
      const p = pathOf(t), cur = new Set(getIn(s.root, p) ?? []);
      if (t.checked) cur.add(t.dataset.v); else cur.delete(t.dataset.v);
      setIn(s.root, p, [...cur]); changed();
    }
  });
  el.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t.dataset?.k === "tag-add" && (e.key === "Enter" || e.key === ",")) { e.preventDefault(); addTag(t); }
    else if (e.key === "Enter" && t.tagName === "INPUT" && t.type !== "checkbox" && !t.closest("[data-r=rawbox]")) e.preventDefault();   // Enter must not act as save
    if ((e.metaKey || e.ctrlKey) && e.key === "s" && !t.closest?.("[data-r=rawbox]")) { e.preventDefault(); el.querySelector("[data-k=save]").click(); }
  });
  el.addEventListener("focusout", (e) => { if (e.target.dataset?.k === "tag-add" && e.target.value.trim()) addTag(e.target); });
  function addTag(t) {
    const p = pathOf(t), f = fieldAtPath(p), cur = getIn(s.root, p) ?? f?.default ?? [], v = t.value.trim();
    if (v && !cur.includes(v)) setIn(s.root, p, [...cur, v]);
    t.value = ""; changed(true);
  }
  el.addEventListener("toggle", (e) => {
    const t = e.target;
    if (t.dataset?.open) { if (t.open) s.open.add(t.dataset.open); else s.open.delete(t.dataset.open); }
    if (t.dataset?.r === "raw") { s.rawOpen = t.open; if (t.open) mountRaw().catch((x) => toast(x.message, 6000)); }
  }, true);

  el.addEventListener("click", (e) => {
    const t = e.target.closest("[data-k]");
    if (!t || t.closest("[data-r=rawbox]") || t.tagName === "INPUT" || t.tagName === "SELECT") return;
    const k = t.dataset.k;
    if (k === "save") return void save(t);
    if (k === "reset") { if (!dirty() || confirm("放弃这里没保存的改动？")) apply(s.d); return; }
    if (k === "reload") return void load();
    if (k === "seg") { setIn(s.root, pathOf(t), parseV(t.dataset.v) ?? null); return changed(true); }
    if (k === "tag-del") {
      const p = pathOf(t), f = fieldAtPath(p), cur = [...(getIn(s.root, p) ?? f?.default ?? [])];
      cur.splice(Number(t.dataset.i), 1); setIn(s.root, p, cur); return changed(true);
    }
    if (k === "kv-add") { s.kvBlank[t.dataset.p] = (s.kvBlank[t.dataset.p] ?? 0) + 1; return draw(); }
    if (k === "kv-del") { const box = t.closest("[data-kvbox]"); t.closest("[data-kvrow]").remove(); readKv(box); return changed(true); }
    if (k === "more") { s.limit[t.dataset.p] = (s.limit[t.dataset.p] ?? 60) + 120; return redrawRows(t.dataset.p); }
    if (k === "add") {
      const p = pathOf(t), f = findField(p);
      s.wizard = { k: t.dataset.p, path: p, step: 0 }; s.wizErr = ""; s.root.w = clone(f.add.defaults ?? {});
      return draw();
    }
    if (k === "wiz-cancel") { s.wizard = null; s.root.w = null; s.wizErr = ""; return draw(); }
    if (k === "wiz-back" || k === "wiz-next") return wizardStep(findField(s.wizard.path), k === "wiz-next" ? 1 : -1);
    if (k === "rm") {
      const p = pathOf(t), key = p[p.length - 1], parent = p.slice(0, -1);
      if (!confirm(`删除「${key}」？保存后才生效。只想暂停的话，用开关就行。`)) return;
      if (typeof key === "number") getIn(s.root, parent).splice(key, 1);
      else if (key in (getIn(JSON.parse(s.base), parent.slice(1)) ?? {})) setIn(s.root, p, null);
      else delete getIn(s.root, parent)[key];
      return changed(true);
    }
  });

  await load();
  return { dirty: () => dirty() || !!s.raw?.dirty() };
}
