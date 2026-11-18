// Config forms (DESIGN §10.6): turn a submitted form into new YAML text. Nothing here writes. The result goes to the
// console's saveConfig, the same function the raw editor uses, so hash check, schema, git, config_changes, the admin-group
// diff and widening() all stay in one place.
//
// A form can only change keys its description names. Everything else in the file (unknown keys, comments, order, spacing)
// comes through as it was, and the result is parsed again and compared before anyone gets to save it.

import { parse as parseYaml, parseDocument, isMap, isSeq, isScalar } from "yaml";
import { z } from "zod";
import { SCHEMAS } from "./schemas.ts";
import { FORM_SPECS } from "./config-form-specs.ts";
import type { FormField, FormFieldError, FormSpec, FormUnknown, FieldCond, FieldWiden } from "../protocol/config-form.ts";

type Obj = Record<string, any>;
type Path = (string | number)[];
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const blank = (v: unknown) => v === undefined || v === null || v === "";
const emptyObj = (v: unknown) => v == null || (isObj(v) && !Object.keys(v).length);

export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && same(a[k], b[k]));
  }
  return false;
}

// ───────── description + zod ─────────

const unwrap = (s: any): any => { const alt = (s?.anyOf ?? s?.oneOf)?.filter((x: any) => x.type !== "null"); return alt?.length === 1 ? unwrap(alt[0]) : s; };
const itemOf = (s: any) => { const a = unwrap(s)?.additionalProperties; return a && typeof a === "object" && Object.keys(a).length ? a : undefined; };
const childOf = (s: any, key: string) => unwrap(s)?.properties?.[key] ?? itemOf(s);
const SAFE = Number.MAX_SAFE_INTEGER;

function enrich(f: FormField, parent: any): FormField {
  const node = f.key === "." ? parent : childOf(parent, f.key), s = unwrap(node), r: FormField = { ...f };
  if (s && !f.extra) {
    if (f.key !== "." && unwrap(parent)?.required?.includes(f.key)) r.required = true;
    if (s.type === "number" || s.type === "integer") {
      r.integer = s.type === "integer";
      if (typeof s.minimum === "number" && s.minimum > -SAFE) r.min = s.minimum;
      if (typeof s.maximum === "number" && s.maximum < SAFE) r.max = s.maximum;
      if (typeof s.exclusiveMinimum === "number") r.exclusiveMin = s.exclusiveMinimum;
    }
    if (s.pattern) r.pattern = s.pattern;
    if (s.enum && !r.options) r.options = s.enum.map((v: string) => ({ value: v, label: v }));
    if (s.type === "array") { r.minItems = s.minItems; r.maxItems = s.maxItems; r.itemPattern = unwrap(s.items)?.pattern; }
    if (f.type === "map" && s.propertyNames?.pattern && r.keyField) r.keyField = { ...r.keyField, pattern: r.keyField.pattern ?? s.propertyNames.pattern };
  }
  if (f.fields) {
    const inner = f.extra ? undefined : f.type === "list" ? unwrap(s?.items) : f.type === "map" ? itemOf(s) : s;
    r.fields = f.fields.map((c) => enrich(f.extra ? { ...c, extra: true } : c, inner));
  }
  return r;
}

const schemaOf = (file: string) => z.toJSONSchema(SCHEMAS[file], { io: "input", unrepresentable: "any" });
const built = new Map<string, FormSpec>();
export function formSpec(file: string): FormSpec | undefined {
  const raw = FORM_SPECS[file];
  if (!raw) return undefined;
  let s = built.get(file);
  if (!s) {
    const root = schemaOf(file);
    s = { ...raw, sections: raw.sections.map((x) => ({ ...x, fields: x.fields.map((f) => enrich(f, root)) })) };
    built.set(file, s);
  }
  return s;
}

const fieldsOf = (spec: FormSpec) => spec.sections.flatMap((s) => s.fields);
const WANT: Partial<Record<FormField["type"], string[]>> = {
  number: ["number", "integer"], bool: ["boolean"], text: ["string"], time: ["string"], duration: ["string"], picker: ["string"],
  tags: ["array"], multiselect: ["array"], list: ["array"], group: ["object"], map: ["object"], kv: ["object"],
};

/** every way the descriptions and the zod schemas disagree; empty = in step (run by the smoke test) */
export function specProblems(): string[] {
  const out: string[] = [];
  const walk = (fields: FormField[], parent: any, where: string) => {
    const covered = new Set<string>();
    for (const f of fields) {
      const at = `${where}.${f.key}`;
      covered.add(f.key);
      const node = f.key === "." ? parent : (unwrap(parent)?.properties?.[f.key] ?? itemOf(parent));
      const s = unwrap(node);
      if (f.extra) { if (unwrap(parent)?.properties?.[f.key]) out.push(`${at}: marked extra but the schema names it`); continue; }
      if (!s) { out.push(`${at}: not in the schema`); continue; }
      const want = WANT[f.type];
      if (want && s.type && !want.includes(s.type)) out.push(`${at}: form says ${f.type}, schema says ${s.type}`);
      if (s.enum && f.options) {
        const a = f.options.map((o) => o.value).sort(), b = [...s.enum].sort();
        if (!same(a, b)) out.push(`${at}: options ${a} differ from schema ${b}`);
      }
      if ((f.type === "select" || f.type === "segment") && !s.enum && !f.open && !f.optionsFrom && s.type === "string") out.push(`${at}: fixed choices over a free string`);
      if (f.fields) walk(f.fields, f.type === "list" ? unwrap(s.items) : f.type === "map" ? itemOf(s) : s, at);
    }
    if (!covered.has(".")) for (const k of Object.keys(unwrap(parent)?.properties ?? {})) if (!covered.has(k)) out.push(`${where}.${k}: in the schema, missing from the form`);
  };
  for (const [file, spec] of Object.entries(FORM_SPECS)) { if (!SCHEMAS[file]) out.push(`${file}: no schema`); else walk(fieldsOf(spec), schemaOf(file), file); }
  return out;
}

const visible = (c: FieldCond | undefined, scope: unknown, fields: FormField[]) => {
  if (!c) return true;
  const ctl = fields.find((f) => f.key === c.key), v = isObj(scope) ? scope[c.key] : undefined;
  return c.in.includes((v ?? ctl?.default) as any);
};

// ───────── draft → new values ─────────
// In a draft a missing key means "leave it", null means "clear it" (for a map entry: remove it). A list that is present
// names its whole membership.

export interface FormCtx { chatName?: (id: string) => string | undefined }

function mergeList(f: FormField, before: unknown, draft: unknown[], ctx: FormCtx) {
  const id = f.identity!, old = (Array.isArray(before) ? before : []) as any[];
  const prev = (d: any) => old.find((x) => isObj(x) && x[id] !== undefined && x[id] === d?.[id]);
  const out = draft.filter(isObj).map((d) => { const p = prev(d); return mergeFields(f.fields!, p, d, !p, ctx); });
  for (const x of old) if (!isObj(x) || x[id] === undefined || (!f.removable && !draft.some((d: any) => d?.[id] === x[id]))) out.push(x);
  return out;
}

function mergeMap(f: FormField, before: unknown, draft: Obj, ctx: FormCtx) {
  const old: Obj = isObj(before) ? before : {}, skip = new Set(f.excludeKeys ?? []), out: Obj = {};
  // an entry the draft doesn't mention stays; null removes it, where removing is allowed
  for (const [k, v] of Object.entries(old)) if (skip.has(k) || !(k in draft) || (draft[k] === null && !f.removable)) out[k] = v;
  for (const [k, d] of Object.entries(draft)) {
    if (skip.has(k) || d === null) continue;
    const isNew = !(k in old);
    const item = mergeFields(f.fields!, old[k], d, isNew, ctx);
    if (isNew && f.fillName && !item.name) { const n = ctx.chatName?.(k); if (n) item.name = n; }
    if (f.dropWhenOnly && Object.keys(item).every((x) => f.dropWhenOnly!.includes(x))) continue;
    out[k] = item;
  }
  return out;
}

function mergeFields(fields: FormField[], before: unknown, draft: unknown, isNew: boolean, ctx: FormCtx): Obj {
  const was: Obj = isObj(before) ? before : {}, out: Obj = structuredClone(was);
  if (!isObj(draft)) return out;
  for (const f of fields) {
    if (f.key === ".") {
      const merged = mergeMap(f, was, draft, ctx), own = new Set(fields.map((x) => x.key));
      for (const k of Object.keys(out)) if (!own.has(k) && !(f.excludeKeys ?? []).includes(k)) delete out[k];
      for (const [k, v] of Object.entries(merged)) if (!own.has(k)) out[k] = v;
      continue;
    }
    if (!(f.key in draft) || f.readonly || (f.createOnly && !isNew)) continue;
    const d = draft[f.key], b = was[f.key];
    let v: unknown;
    if (f.type === "group") {
      if (d !== null) { v = mergeFields(f.fields!, b, d, isNew, ctx); if (emptyObj(v)) v = emptyObj(b) ? b : undefined; }
    } else if (f.type === "list") v = d === null ? undefined : Array.isArray(d) ? mergeList(f, b, d, ctx) : b;
    else if (f.type === "map") v = d === null ? undefined : isObj(d) ? mergeMap(f, b, d, ctx) : b;
    else v = blank(d) ? undefined : d;
    if (v === undefined) delete out[f.key]; else out[f.key] = v;
  }
  // a field that just stopped applying (a weekly job turned daily) goes; one that never applied is left alone
  for (const f of fields) if (f.showIf && f.key !== "." && !visible(f.showIf, out, fields)) {
    if (visible(f.showIf, was, fields)) delete out[f.key];
    else if (f.key in was) out[f.key] = was[f.key]; else delete out[f.key];
  }
  return out;
}

export function mergeDraft(spec: FormSpec, before: unknown, draft: unknown, ctx: FormCtx = {}) { return mergeFields(fieldsOf(spec), before, draft, false, ctx); }

// ───────── what the form doesn't know ─────────

export function unknownFields(spec: FormSpec, values: unknown): FormUnknown[] {
  const out: FormUnknown[] = [];
  const add = (path: Path, v: unknown) => out.push({ path: path.join("."), value: (JSON.stringify(v) ?? "").slice(0, 120) });
  const walk = (fields: FormField[], v: unknown, path: Path) => {
    if (!isObj(v)) return;
    const map = fields.find((f) => f.key === "."), known = new Set(fields.map((f) => f.key));
    for (const [k, x] of Object.entries(v)) {
      if (known.has(k)) continue;
      if (map && !(map.excludeKeys ?? []).includes(k)) walk(map.fields!, x, [...path, k]); else add([...path, k], x);
    }
    for (const f of fields) {
      if (f.key === "." || !(f.key in v)) continue;
      const x = v[f.key], at = [...path, f.key];
      if (f.type === "group") { if (x != null && !isObj(x)) add(at, x); else walk(f.fields!, x, at); }
      else if (f.type === "map" && isObj(x)) for (const [k, y] of Object.entries(x)) walk(f.fields!, y, [...at, k]);
      else if (f.type === "list" && Array.isArray(x)) x.forEach((y, i) => walk(f.fields!, y, [...at, isObj(y) ? (y[f.identity!] ?? i) : i]));
    }
  };
  walk(fieldsOf(spec), values, []);
  return out;
}

// ───────── readable errors ─────────

function fieldAt(spec: FormSpec, path: Path): { field?: FormField; label: string } {
  let fields = fieldsOf(spec), field: FormField | undefined;
  const labels: string[] = [];
  for (let i = 0; i < path.length; i++) {
    const k = String(path[i]);
    let f = fields.find((x) => x.key === k);
    if (!f) { const m = fields.find((x) => x.key === "."); if (m && !(m.excludeKeys ?? []).includes(k)) { labels.push(k); field = m; fields = m.fields!; continue; } break; }
    labels.push(f.label); field = f; fields = f.fields ?? [];
    if ((f.type === "list" || f.type === "map") && i + 1 < path.length) { i++; labels.push(String(path[i])); }
  }
  return { field, label: labels.join(" › ") || "整个文件" };
}

function readable(i: any, f?: FormField): string {
  const m = String(i.message ?? ""), plain = !/^Invalid|^Too (small|big)|^Unrecognized/.test(m);
  switch (i.code) {
    case "invalid_type":
      if (/received undefined/.test(m)) return "这项必填";
      return ({ number: "要填数字", int: "要填整数", boolean: "要选是或否", string: "要填文字", array: "要是一个列表", object: "内容结构不对", record: "内容结构不对" } as Obj)[i.expected] ?? "类型不对";
    case "too_small":
      if (i.origin === "array") return `至少要有 ${i.minimum} 项`;
      if (i.origin === "string") return i.minimum === 1 ? "这项必填" : `至少 ${i.minimum} 个字符`;
      return i.inclusive === false ? `要大于 ${i.minimum}` : `不能小于 ${i.minimum}`;
    case "too_big":
      if (i.origin === "array") return `最多 ${i.maximum} 项`;
      if (i.origin === "string") return `最多 ${i.maximum} 个字符`;
      return i.inclusive === false ? `要小于 ${i.maximum}` : `不能大于 ${i.maximum}`;
    case "invalid_format": return f?.patternHint ?? (plain ? m : "格式不对");
    case "invalid_value": return `只能选：${(f?.options?.map((o) => o.label) ?? i.values ?? []).join("、")}`;
    case "invalid_key": return f?.keyField?.patternHint ?? "名字格式不对";
    case "custom": {
      const e = /^no endpoint named (.+)$/.exec(m);
      if (e) return `没有叫 ${e[1]} 的端点`;
      return / 要写 /.test(m) ? "这项必填" : m;
    }
    default: return plain ? m : "不符合要求";
  }
}

function checkValue(f: FormField, v: unknown): string | undefined {
  const re = (p?: string) => (p ? new RegExp(p) : undefined);
  switch (f.type) {
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return "要填数字";
      if (f.integer && !Number.isInteger(v)) return "要填整数";
      if (f.exclusiveMin !== undefined && v <= f.exclusiveMin) return `要大于 ${f.exclusiveMin}`;
      if (f.min !== undefined && v < f.min) return `不能小于 ${f.min}`;
      if (f.max !== undefined && v > f.max) return `不能大于 ${f.max}`;
      return;
    }
    case "bool": return typeof v === "boolean" ? undefined : "要选是或否";
    case "time": {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(v));
      return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? undefined : "要是 00:00 到 23:59 之间的时间";
    }
    case "duration": return /^[1-9]\d*[mhd]$/.test(String(v)) ? undefined : "要写成数字加单位，比如 15m、2h、1d";
    case "tags": case "multiselect": {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x)) return "要是一组文字";
      if (f.maxItems !== undefined && v.length > f.maxItems) return `最多 ${f.maxItems} 项`;
      if (f.minItems !== undefined && v.length < f.minItems) return `至少要有 ${f.minItems} 项`;
      const p = re(f.itemPattern), bad = p && v.find((x) => !p.test(x));
      return bad ? `「${bad}」${f.patternHint ?? "格式不对"}` : undefined;
    }
    case "select": case "segment":
      if (!f.open && f.options && !f.options.some((o) => o.value === v)) return `只能选：${f.options.map((o) => o.label).join("、")}`;
      return;
    case "kv": return isObj(v) ? undefined : "内容结构不对";
    default: {
      if (typeof v !== "string") return "要填文字";
      const p = re(f.pattern);
      return p && !p.test(v) ? (f.patternHint ?? "格式不对") : undefined;
    }
  }
}

function fires(w: FieldWiden, b: unknown, a: unknown): boolean {
  if (a === undefined && w.clearing) return b !== undefined;
  const at = (v: unknown) => (w.rank ? (w.rank.includes(String(v)) ? w.rank.indexOf(String(v)) : NaN) : Number(v));
  switch (w.when) {
    case "up": return at(a) > at(b);
    case "down": return at(a) < at(b);
    case "on": return a === true && b !== true;
    case "change": return !same(a, b);
    case "add": return ((a ?? []) as unknown[]).some((x) => !((b ?? []) as unknown[]).includes(x));
    case "remove": return ((b ?? []) as unknown[]).some((x) => !((a ?? []) as unknown[]).includes(x));
  }
}

/** check only what this save changes: a hand-written value the form wouldn't have allowed must not block an unrelated edit */
function checkChanged(fields: FormField[], before: unknown, after: unknown, path: Path, labels: string[], isNew: boolean, errors: FormFieldError[], notes: string[]) {
  const b: Obj = isObj(before) ? before : {}, a: Obj = isObj(after) ? after : {};
  const fail = (p: Path, l: string[], message: string) => errors.push({ path: p, label: l.join(" › "), message });
  for (const f of fields) {
    if (f.readonly) continue;
    if (f.key === ".") {
      for (const [k, v] of Object.entries(a)) {
        if ((f.excludeKeys ?? []).includes(k) || fields.some((x) => x.key === k)) continue;
        const fresh = !(k in b), p = [...path, k], l = [...labels, k];
        if (fresh && f.keyField?.pattern && !new RegExp(f.keyField.pattern).test(k)) fail(p, l, f.keyField.patternHint ?? "名字格式不对");
        if (fresh || !same(b[k], v)) checkChanged(f.fields!, b[k], v, p, l, fresh, errors, notes);
      }
      continue;
    }
    if (!visible(f.showIf, a, fields) || (f.createOnly && !isNew)) continue;
    const x = b[f.key], y = a[f.key], p = [...path, f.key], l = [...labels, f.label];
    if (same(x, y) && !isNew) continue;
    if (f.type === "group") { if (y !== undefined) checkChanged(f.fields!, x, y, p, l, isNew, errors, notes); continue; }
    if (f.type === "list" && Array.isArray(y)) {
      y.forEach((item, i) => {
        const prev = (Array.isArray(x) ? x : []).find((o: any) => isObj(o) && o[f.identity!] === item?.[f.identity!]);
        if (!prev || !same(prev, item)) checkChanged(f.fields!, prev, item, [...p, i], [...l, String(item?.[f.identity!] ?? i + 1)], !prev, errors, notes);
      });
      continue;
    }
    if (f.type === "map" && isObj(y)) {
      for (const [k, v] of Object.entries(y)) {
        const old = isObj(x) ? x[k] : undefined;
        if (old === undefined && f.keyField?.pattern && !new RegExp(f.keyField.pattern).test(k)) fail([...p, k], [...l, k], f.keyField.patternHint ?? "名字格式不对");
        if (!same(old, v)) checkChanged(f.fields!, old, v, [...p, k], [...l, k], old === undefined, errors, notes);
      }
      continue;
    }
    if (blank(y)) { if (f.required) fail(p, l, "这项必填"); }
    else { const m = checkValue(f, y); if (m) { fail(p, l, m); continue; } }
    if (f.widen && fires(f.widen, x ?? f.default, y ?? f.default)) notes.push(`${l.join(" › ")}：${f.widen.note}`);
  }
}

// ───────── new values → YAML, keeping the file as it was ─────────

function patch(doc: any, path: Path, b: unknown, a: unknown) {
  if (same(b, a)) return;
  if (a === undefined) { doc.deleteIn(path); return; }
  const node = path.length ? doc.getIn(path, true) : doc.contents;
  if (isMap(node) && isObj(a) && isObj(b)) {
    for (const k of Object.keys(b)) if (!(k in a)) doc.deleteIn([...path, k]);
    for (const k of Object.keys(a)) patch(doc, [...path, k], b[k], a[k]);
    if (!Object.keys(b).length) (node as any).flow = false;
    return;
  }
  if (isSeq(node) && Array.isArray(a) && Array.isArray(b)) {
    // keep each surviving item's node (and so its comments), matched by id or by value
    const key = (x: any) => (isObj(x) && x.id !== undefined ? `id:${x.id}` : JSON.stringify(x));
    const was = new Map(b.map((x, i) => [key(x), i]));
    const old = (node as any).items as unknown[], from: (number | undefined)[] = a.map((x) => was.get(key(x)));
    (node as any).items = a.map((x, i) => (from[i] !== undefined ? old[from[i]!] : doc.createNode(x)));
    if (!b.length) (node as any).flow = false;
    a.forEach((x, i) => { if (from[i] !== undefined) patch(doc, [...path, i], b[from[i]!], x); });
    return;
  }
  if (!path.length) { doc.contents = doc.createNode(a); return; }
  const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
  if (isScalar(node) && (a === null || typeof a !== "object")) { node.value = a; return; }
  if (isMap(parent) || isSeq(parent)) (parent as any).set(path[path.length - 1], doc.createNode(a));
  else doc.setIn(path, doc.createNode(a));
}

/** pairs (i, j) of equal lines in order: common ends first, then longest common subsequence over what is left */
function matchLines(a: string[], b: string[], key: (s: string) => string = (s) => s): [number, number][] {
  let head = 0, tail = 0;
  while (head < a.length && head < b.length && key(a[head]) === key(b[head])) head++;
  while (tail < a.length - head && tail < b.length - head && key(a[a.length - 1 - tail]) === key(b[b.length - 1 - tail])) tail++;
  const n = a.length - head - tail, m = b.length - head - tail, out: [number, number][] = [];
  for (let i = 0; i < head; i++) out.push([i, i]);
  if (n > 0 && m > 0 && n * m <= 4_000_000) {
    const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      t[i][j] = key(a[head + i]) === key(b[head + j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (key(a[head + i]) === key(b[head + j])) { out.push([head + i, head + j]); i++; j++; }
      else if (t[i + 1][j] >= t[i][j + 1]) i++; else j++;
    }
  }
  for (let i = tail; i > 0; i--) out.push([a.length - i, b.length - i]);
  return out;
}

/**
 * yaml's printer normalises spacing (aligned values and comments, repeated blank lines). Put the edits on the original
 * text instead, so a one-value change is a one-line diff in git and in the admin-group notice.
 */
function keepFormatting(orig: string, base: string, next: string): string {
  const O = orig.split("\n"), B = base.split("\n"), N = next.split("\n");
  const toNext = new Map(matchLines(B, N)), out: string[] = [];
  const anchors = matchLines(B, O, (s) => s.replace(/\s+/g, "")).filter(([i]) => toNext.has(i)).map(([i, k]) => ({ i, j: toNext.get(i)!, k }));
  let p = { i: -1, j: -1, k: -1 };
  for (const t of [...anchors, { i: B.length, j: N.length, k: O.length }]) {
    const was = B.slice(p.i + 1, t.i), now = N.slice(p.j + 1, t.j);
    out.push(...(same(was, now) ? O.slice(p.k + 1, t.k) : now));
    if (t.k < O.length) out.push(O[t.k]);
    p = t;
  }
  return out.join("\n");
}

const parsesTo = (text: string, want: unknown) => { try { const v = parseYaml(text); return same(v ?? {}, want ?? {}); } catch { return false; } };

export function renderYaml(text: string, before: unknown, after: unknown): string {
  const P = { lineWidth: 0 };
  const doc: any = parseDocument(text);
  const base = String(parseDocument(text).toString(P));
  if (!doc.contents) doc.contents = doc.createNode({});
  else if (!isMap(doc.contents) && isObj(after)) doc.contents = doc.createNode({});
  patch(doc, [], isObj(before) ? before : {}, after);
  const next = String(doc.toString(P));
  const kept = text.trim() ? keepFormatting(text, base, next) : next;
  if (parsesTo(kept, after)) return kept;
  if (parsesTo(next, after)) return next;
  throw new Error("表单没法把改动写进这个文件现在的结构。请在「高级 › 查看原文」里改。");
}

export function changedLines(a: string, b: string): string {
  const A = a.split("\n"), B = b.split("\n"), out: string[] = [];
  let i = 0, j = 0;
  for (const [x, y] of [...matchLines(A, B), [A.length, B.length] as [number, number]]) {
    for (; i < x; i++) out.push(`-${A[i]}`);
    for (; j < y; j++) out.push(`+${B[j]}`);
    i = x + 1; j = y + 1;
  }
  return out.join("\n");
}

// ───────── one evaluation ─────────

export interface FormResult { before: unknown; after: Obj; text: string; changed: boolean; errors: FormFieldError[]; notes: string[]; diff: string }

export function evaluateForm(file: string, text: string, draft: unknown, ctx: FormCtx = {}): FormResult {
  const spec = formSpec(file)!, before = parseYaml(text) ?? undefined;
  const after = mergeDraft(spec, before, draft, ctx), errors: FormFieldError[] = [], notes: string[] = [];
  const result = { before, after, text, changed: false, errors, notes, diff: "" };
  if (same(before ?? {}, after)) return result;
  checkChanged(fieldsOf(spec), before, after, [], [], false, errors, notes);
  const seen = new Set(errors.map((e) => JSON.stringify(e.path)));
  const res = SCHEMAS[file].safeParse(after);
  if (!res.success) for (const i of res.error.issues as any[]) {
    const k = JSON.stringify(i.path);
    if (seen.has(k)) continue;
    seen.add(k);
    const at = fieldAt(spec, i.path);
    errors.push({ path: i.path, label: at.label, message: readable(i, at.field) });
  }
  result.changed = true;
  try { result.text = renderYaml(text, before, after); result.diff = changedLines(text, result.text); }
  catch (e: any) { errors.push({ path: [], label: "整个文件", message: String(e?.message ?? e) }); }
  return result;
}

// ───────── widenings the file-level check can't see ─────────
// schemas.ts widening() compares two files. These need more than that (what a group gets by default, which words apply
// when the key is absent) or cover keys it doesn't watch. They add a notice; they never replace one.

const DEFAULT_WORDS = ["HR", "人事", "薪酬", "绩效", "财务", "法务", "董事会"];
export interface WidenCtx { activation?: (chat: string, conf: Obj) => string; chatName?: (id: string) => string | undefined }

export function formWidening(file: string, before: any, after: any, ctx: WidenCtx = {}): string[] {
  const out: string[] = [];
  before ??= {}; after ??= {};
  const name = (id: string) => ctx.chatName?.(id) || id;
  if (file === "groups.yaml" && ctx.activation) {
    const rank: Obj = { disabled: 0, digest: 1, when_mentioned: 2, always: 3 };
    for (const id of new Set([...Object.keys(before.groups ?? {}), ...Object.keys(after.groups ?? {})])) {
      const was = before.groups?.[id]?.activation, now = after.groups?.[id]?.activation;
      if (was === now || (was && now)) continue;   // both set: widening() already compares them
      const a = ctx.activation(id, before), b = ctx.activation(id, after);
      if (rank[b] > rank[a]) out.push(`${name(id)}：${a} → ${b}`);
    }
  }
  if (file === "gate.yaml" && !before.sensitive_words && after.sensitive_words) {
    const gone = DEFAULT_WORDS.filter((w) => !after.sensitive_words.includes(w));
    if (gone.length) out.push(`去掉了默认敏感词：${gone.join("、")}`);
  }
  if (file === "models.yaml") {
    for (const [k, e] of Object.entries(after.endpoints ?? {}) as [string, any][]) {
      const o = before.endpoints?.[k];
      if (!o) out.push(`新端点 ${k}（密钥 ${e?.key_ref}）`);
      else if (o.base_url !== e?.base_url) out.push(`端点 ${k} 换了地址，请求和密钥 ${e?.key_ref} 都会发到新地址`);
      else if (o.key_ref !== e?.key_ref) out.push(`端点 ${k} 改用密钥 ${e?.key_ref}`);
    }
    for (const [k, t] of Object.entries(after.tiers ?? {}) as [string, any][]) {
      const o = before.tiers?.[k];
      if (o && o.endpoint !== t?.endpoint) out.push(`${k} 档换到端点 ${t?.endpoint}`);
      if (t?.fallback?.model && !same(o?.fallback, t.fallback)) out.push(`${k} 档的备用模型 → ${t.fallback.model}，可能走另一个计费端点`);
    }
  }
  if (file === "feishu.yaml") {
    if (before.admin_chat !== after.admin_chat) out.push(`管理群换了：${before.admin_chat ? name(before.admin_chat) : "（没有）"} → ${after.admin_chat ? name(after.admin_chat) : "（没有）"}。审批卡片和这类通知以后都发到新群`);
    if (before.workbench_chat !== after.workbench_chat) out.push(`工作台换了 → ${after.workbench_chat ? name(after.workbench_chat) : "（没有）"}。你在这个群发的话题会开工作会话`);
  }
  if (file === "people.yaml") {
    for (const [k, p] of Object.entries(after) as [string, any][]) {
      if (k === "owner" || !isObj(p)) continue;
      const o: any = before[k];
      for (const c of ["feishu", "wechat"]) if (p.ids?.[c] && p.ids[c] !== o?.ids?.[c]) out.push(`${p.name ?? k} 的${c === "feishu" ? "飞书" : "微信"} ID ${o?.ids?.[c] ? "换了" : "登记了"}`);
    }
  }
  if (file === "jobs.yaml") {
    for (const [k, j] of Object.entries(after ?? {}) as [string, any][])
      if (j?.do === "event" && j.quota === false && before?.[k]?.quota !== false) out.push(`定时提醒 ${k} 不再占每日主动消息额度`);
  }
  return out;
}
