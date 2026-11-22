// Regrouping and correcting matters (DESIGN §读3.1). Every change goes through here and leaves one row in matter_ops:
// who, when, why, and exactly what it takes to put it back. Only his hand gets here: a card button, the console, or the
// main agent acting on what he just said. The daily review (matter-review.ts) only ever suggests.
//
//   attach  a matter goes under a 主线; nothing moves, its events add up to the 主线
//   main    a new 主线 is opened over several matters
//   merge   true duplicates: events, tasks, keys … move to the survivor, the old row stays as 'merged'
//
// Undo restores the rows it recorded and leaves alone whatever has happened to them since. Ops that touched the same
// matters come back newest first, so a merge can't be pulled out from under a later change.

import { all, one, run, tx, type Row } from "./db.ts";
import { log } from "./config.ts";
import { OPEN_MATTER, deleteMatter, familyIds, inList, liveId, matterInUse, noteMatter, openMatter, rootId, stripMatterLines } from "./matters.ts";
import { addMatterKeys, matterKeys, normTopic, setEventLevel, setEventState } from "./events.ts";
import { commitMemory, rebuildIndex } from "./wiki.ts";
import { markDirty } from "./graph.ts";
import { OWNER_LANE } from "./timers.ts";

export interface Actor { by: string; why?: string; reviewId?: number }
const MOVED = ["events", "tasks", "timers", "approvals", "readings", "outlooks", "life_notes", "reviews"] as const;
const tagOf = (op: number) => `matter_op:${op}`;
const lineTag = (op: number) => `[src=${tagOf(op)}]`;
const label = (m: Row) => `#${m.id}「${m.title ?? ""}」`;

function row(idIn: number): Row {
  const id = liveId(Number(idIn));
  const m = id == null ? undefined : one("SELECT * FROM matters WHERE id=?", id);
  if (!m) throw new Error(`没有事 #${idIn}`);
  return m;
}
function openRow(id: number): Row {
  const m = row(id);
  if (!one(`SELECT 1 FROM matters WHERE id=? AND ${OPEN_MATTER}`, m.id)) throw new Error(`${label(m)} 已经不在办了`);
  return m;
}
function sameDomain(a: Row, b: Row) {
  if (a.domain !== b.domain) throw new Error(`${label(a)} 和 ${label(b)} 一个是工作一个是私事，不放在一起`);
}
const begin = (kind: string, summary: string, a: Actor) =>
  Number(run("INSERT INTO matter_ops(ts, kind, summary, why, by, review_id) VALUES(?,?,?,?,?,?)", Date.now(), kind, summary.slice(0, 300), a.why?.slice(0, 500) ?? null, a.by, a.reviewId ?? null).lastInsertRowid);
const finish = (id: number, touches: string[], undo: unknown) =>
  run("UPDATE matter_ops SET touches=?, undo_json=? WHERE id=?", JSON.stringify([...new Set(touches)]), JSON.stringify(undo), id);
function settled(id: number, pages = false) {
  markDirty();
  try { if (pages) rebuildIndex(); commitMemory(`matter op #${id}`); } catch (e: any) { log("matters", "commit failed", { op: id, err: String(e?.message ?? e).slice(0, 200) }); }
  return id;
}
const idsOf = (sql: string, ...a: any[]) => all(sql, ...a).map((r) => r.id);
const addKeysTracked = (id: number, keys: unknown[]) => {
  const before = matterKeys(id);
  return addMatterKeys(id, keys as string[]).filter((k) => !before.includes(k));
};
const dropKeys = (id: number, keys: string[]) => {
  if (keys.length) run("UPDATE matters SET keys=? WHERE id=?", JSON.stringify(matterKeys(id).filter((k) => !keys.includes(k))), id);
};
const setParent = (ids: unknown[], parent: number | null) => { if (ids.length) run(`UPDATE matters SET parent_id=? WHERE id IN (${inList(ids)})`, parent, ...ids); };

/** the duplicates become part of `into`: everything hanging on them moves over, their keys and loose topics with it */
export function mergeMatters(sourceIds: number[], into: number, a: Actor): number {
  const op = tx(() => {
    const T = openRow(into);
    const src = [...new Set(sourceIds.map((s) => row(s)))].filter((m, i, xs) => m.id !== T.id && xs.findIndex((x) => x.id === m.id) === i);
    if (!src.length) throw new Error("没有要合并的事");
    for (const S of src) sameDomain(S, T);
    const id = begin("merge", `${src.map(label).join("、")} 并进 ${label(T)}`, a);
    const tag = tagOf(id);
    const undo: Row = { into: T.id, into_status: T.status, into_parent: T.parent_id ?? null, sources: [] };
    for (const S of src) {
      // keep it two levels: if the survivor sat under this matter it moves up, and this matter's other 子事 follow it
      const tNow = one("SELECT parent_id FROM matters WHERE id=?", T.id)!;
      if (tNow.parent_id === S.id) run("UPDATE matters SET parent_id=? WHERE id=?", S.parent_id ?? null, T.id);
      const home = one("SELECT parent_id FROM matters WHERE id=?", T.id)!.parent_id ?? T.id;
      const children = idsOf("SELECT id FROM matters WHERE parent_id=? AND id<>?", S.id, T.id);
      setParent(children, home);
      const moved: Record<string, unknown[]> = {};
      for (const t of MOVED) {
        const ids = idsOf(`SELECT id FROM ${t} WHERE matter_id=?`, S.id);
        if (ids.length) { run(`UPDATE ${t} SET matter_id=? WHERE matter_id=?`, T.id, S.id); moved[t] = ids; }
      }
      const outlooks = idsOf("SELECT id FROM outlooks WHERE horizon='matter' AND period=?", `matter:${S.id}`);
      if (outlooks.length) run("UPDATE outlooks SET period=? WHERE horizon='matter' AND period=?", `matter:${T.id}`, `matter:${S.id}`);
      const names = [...matterKeys(S.id), S.title].map(normTopic).filter((k): k is string => !!k);
      const keys = addKeysTracked(T.id, names);
      const loose = names.length ? idsOf(`SELECT id FROM events WHERE matter_id IS NULL AND topic IN (${inList(names)})`, ...names) : [];
      if (loose.length) run(`UPDATE events SET matter_id=? WHERE id IN (${inList(loose)})`, T.id, ...loose);
      noteMatter(T.id, "过程", `并入了事 #${S.id}「${S.title ?? ""}」，原页面 matters/${S.id}.md`, tag);
      noteMatter(S.id, "收", `并进了事 #${T.id}「${T.title ?? ""}」`, tag);
      run("UPDATE matters SET status='merged', merged_into=?, closed_at=?, parent_id=NULL WHERE id=?", T.id, Date.now(), S.id);
      undo.sources.push({ id: S.id, status: S.status, closed_at: S.closed_at ?? null, parent_id: S.parent_id ?? null, children, moved, outlooks, keys, loose });
    }
    finish(id, [`m${T.id}`, ...src.flatMap((S) => [`m${S.id}`]), ...undo.sources.flatMap((s: Row) => s.children.map((c: number) => `m${c}`))], undo);
    return id;
  });
  return settled(op);
}

function attachInner(parent: Row, ids: number[]) {
  const out: Row[] = [];
  for (const raw of ids) {
    const C = row(raw);
    if (C.id === parent.id) continue;
    sameDomain(C, parent);
    if (C.parent_id === parent.id) continue;
    const children = idsOf("SELECT id FROM matters WHERE parent_id=?", C.id);   // two levels: its own 子事 come along, directly under the 主线
    setParent(children, parent.id);
    run("UPDATE matters SET parent_id=? WHERE id=?", parent.id, C.id);
    out.push({ id: C.id, parent_id: C.parent_id ?? null, children });
  }
  return out;
}
const touchesOf = (items: Row[]) => items.flatMap((c) => [`m${c.id}`, ...c.children.map((x: number) => `m${x}`)]);

/** these matters become 子事 of a 主线 (given a 子事, its 主线) */
export function attachMatters(ids: number[], parentId: number, a: Actor): number {
  const op = tx(() => {
    const P = openRow(rootId(parentId) ?? parentId);
    const id = begin("attach", `挂到 ${label(P)} 下：${ids.map((i) => `#${i}`).join("、")}`, a);
    const items = attachInner(P, ids);
    if (!items.length) throw new Error("没有要挂的事");
    finish(id, [`m${P.id}`, ...touchesOf(items)], { parent: P.id, items });
    return id;
  });
  return settled(op);
}

/** a new 主线 over matters that have none yet */
export function createMainline(title: string, ids: number[], a: Actor): { op: number; id: number } {
  const clean = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!clean) throw new Error("主线要有个名字");
  const r = tx(() => {
    const members = ids.map(row);
    if (members.length < 2) throw new Error("至少两件事才值得起一条主线");
    const first = members[0];
    const m = openMatter({ title: clean, domain: first.domain, lane: first.lane && first.lane !== "import" ? first.lane : OWNER_LANE });
    run("UPDATE matters SET status='active', opened_at=? WHERE id=?", Math.min(...members.map((x) => Number(x.opened_at ?? Date.now()))), m.id);
    const P = row(m.id);
    const id = begin("main", `新主线 ${label(P)}：${members.map(label).join("、")}`, a);
    const items = attachInner(P, ids);
    finish(id, [`m${P.id}`, ...touchesOf(items)], { parent: P.id, items, created: true });
    return { op: id, id: P.id };
  });
  settled(r.op, true);
  return r;
}

export function detachMatter(idIn: number, a: Actor): number {
  const op = tx(() => {
    const C = row(idIn);
    if (!C.parent_id) throw new Error(`${label(C)} 本来就是主线`);
    const id = begin("detach", `${label(C)} 从 #${C.parent_id} 下拆出来`, a);
    run("UPDATE matters SET parent_id=NULL WHERE id=?", C.id);
    finish(id, [`m${C.id}`, `m${C.parent_id}`], { id: C.id, parent_id: C.parent_id });
    return id;
  });
  return settled(op);
}

/** close a matter and whatever is still open under it */
export function closeMatter(idIn: number, status: "closing" | "done" | "dropped", a: Actor): number {
  const op = tx(() => {
    const M = row(idIn);
    const rows = familyIds(M.id).map((i) => one("SELECT id, status, closed_at FROM matters WHERE id=?", i)!)
      .filter((m) => ["open", "active", "closing"].includes(m.status));
    if (!rows.length) throw new Error(`${label(M)} 已经不在办了`);
    const id = begin("status", `${label(M)} → ${status}`, a);
    const now = Date.now();
    for (const m of rows) run("UPDATE matters SET status=?, closed_at=? WHERE id=?", m.id === M.id ? status : status === "dropped" ? "dropped" : "done", now, m.id);
    if (a.why) { const before = one("SELECT status FROM matters WHERE id=?", M.id)!.status; noteMatter(M.id, "收", a.why, tagOf(id)); run("UPDATE matters SET status=? WHERE id=?", before, M.id); }
    finish(id, rows.map((m) => `m${m.id}`), { rows, page: M.id });
    return id;
  });
  return settled(op);
}

export function eventAction(id: number, o: { state?: string; level?: string }, a: Actor): number {
  const op = tx(() => {
    const e = one("SELECT * FROM events WHERE id=?", id);
    if (!e) throw new Error(`没有事件 #${id}`);
    const n = begin("event", `事件 #${id}：${[o.level && `级别 ${e.level} → ${o.level}`, o.state && `状态 ${e.state} → ${o.state}`].filter(Boolean).join("，")}`, a);
    if (o.level) setEventLevel(id, o.level);
    if (o.state) setEventState(id, o.state, a.by);
    const now = one("SELECT state, level FROM events WHERE id=?", id)!;
    finish(n, [`e${id}`], { id, state: e.state, level: e.level, done_at: e.done_at ?? null, done_by: e.done_by ?? null, after: now });
    return n;
  });
  return settled(op);
}

/** hang an event on another matter, or take it off (null) */
export function moveEvent(id: number, matterId: number | null, a: Actor): number {
  const op = tx(() => {
    const e = one("SELECT id, matter_id FROM events WHERE id=?", id);
    if (!e) throw new Error(`没有事件 #${id}`);
    const to = matterId == null ? null : openRow(matterId);
    const n = begin("move", `事件 #${id}：${e.matter_id ? `#${e.matter_id}` : "没挂"} → ${to ? label(to) : "摘下来"}`, a);
    run("UPDATE events SET matter_id=? WHERE id=?", to?.id ?? null, id);
    finish(n, [`e${id}`, ...(e.matter_id ? [`m${e.matter_id}`] : []), ...(to ? [`m${to.id}`] : [])], { id, from: e.matter_id ?? null, to: to?.id ?? null });
    return n;
  });
  return settled(op);
}

/** a 话头 becomes a key of a matter (an existing one, or a new one named after it), and its loose events go there */
export function topicToMatter(topicIn: string, o: { matterId?: number; domain?: string }, a: Actor): { op: number; id: number } {
  const topic = normTopic(topicIn);
  if (!topic) throw new Error("话头是空的");
  const r = tx(() => {
    const created = !o.matterId;
    const domain = o.domain ?? one("SELECT domain FROM events WHERE topic=? AND domain IS NOT NULL ORDER BY ts DESC LIMIT 1", topic)?.domain ?? "work";
    const M = created ? row(openMatter({ title: topic, domain: domain === "personal" ? "personal" : "work", lane: OWNER_LANE }).id) : openRow(o.matterId!);
    if (created) run("UPDATE matters SET status='active' WHERE id=?", M.id);
    const id = begin("topic", `话头「${topic}」→ ${label(M)}`, a);
    const events = idsOf("SELECT id FROM events WHERE topic=? AND matter_id IS NULL", topic);
    if (events.length) run(`UPDATE events SET matter_id=? WHERE id IN (${inList(events)})`, M.id, ...events);
    const keys = addKeysTracked(M.id, [topic]);
    finish(id, [`m${M.id}`], { matter: M.id, events, keys, created });
    return { op: id, id: M.id, created };
  });
  settled(r.op, r.created);
  return { op: r.op, id: r.id };
}

/** a better title; the old one stays as a key, so what people call it still links */
export function renameMatter(idIn: number, title: string, a: Actor): number {
  const clean = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!clean) throw new Error("标题是空的");
  const op = tx(() => {
    const M = row(idIn);
    const id = begin("rename", `${label(M)} 改名「${clean}」`, a);
    const keys = addKeysTracked(M.id, [M.title]);
    run("UPDATE matters SET title=? WHERE id=?", clean, M.id);
    finish(id, [`m${M.id}`], { id: M.id, title: M.title, keys });
    return id;
  });
  return settled(op);
}

function reverse(o: Row) {
  const u = JSON.parse(o.undo_json ?? "null");
  if (!u) throw new Error(`操作 #${o.id} 没有可撤销的内容`);
  let pages = false;
  switch (o.kind) {
    case "merge":
      for (const s of [...u.sources].reverse()) {
        run("UPDATE matters SET status=?, closed_at=?, parent_id=?, merged_into=NULL WHERE id=?", s.status, s.closed_at, s.parent_id, s.id);
        for (const [t, ids] of Object.entries(s.moved) as [string, unknown[]][]) run(`UPDATE ${t} SET matter_id=? WHERE matter_id=? AND id IN (${inList(ids)})`, s.id, u.into, ...ids);
        if (s.outlooks.length) run(`UPDATE outlooks SET period=? WHERE id IN (${inList(s.outlooks)})`, `matter:${s.id}`, ...s.outlooks);
        if (s.loose.length) run(`UPDATE events SET matter_id=NULL WHERE matter_id=? AND id IN (${inList(s.loose)})`, u.into, ...s.loose);
        setParent(s.children, s.id);
        dropKeys(u.into, s.keys);
        stripMatterLines(s.id, lineTag(o.id));
      }
      run("UPDATE matters SET parent_id=? WHERE id=?", u.into_parent, u.into);
      stripMatterLines(u.into, lineTag(o.id));
      if (u.into_status === "open") run("UPDATE matters SET status='open' WHERE id=? AND status='active'", u.into);
      break;
    case "attach": case "main":
      for (const c of u.items) { run("UPDATE matters SET parent_id=? WHERE id=?", c.parent_id, c.id); setParent(c.children, c.id); }
      if (u.created) { pages = true; if (matterInUse(u.parent)) run("UPDATE matters SET status='dropped', closed_at=? WHERE id=?", Date.now(), u.parent); else deleteMatter(u.parent); }
      break;
    case "detach":
      run("UPDATE matters SET parent_id=? WHERE id=?", u.parent_id, u.id);
      break;
    case "status":
      for (const m of u.rows) run("UPDATE matters SET status=?, closed_at=? WHERE id=?", m.status, m.closed_at ?? null, m.id);
      stripMatterLines(u.page, lineTag(o.id));
      run("DELETE FROM inbox WHERE source='matter' AND source_msg_id=? AND status='received'", `${u.page}:review`);
      break;
    case "event":
      run("UPDATE events SET state=?, level=?, done_at=?, done_by=? WHERE id=? AND state=? AND level=?", u.state, u.level, u.done_at, u.done_by, u.id, u.after.state, u.after.level);
      break;
    case "move":
      run("UPDATE events SET matter_id=? WHERE id=? AND matter_id IS ?", u.from, u.id, u.to);
      break;
    case "topic":
      if (u.events.length) run(`UPDATE events SET matter_id=NULL WHERE matter_id=? AND id IN (${inList(u.events)})`, u.matter, ...u.events);
      dropKeys(u.matter, u.keys);
      if (u.created) { pages = true; if (matterInUse(u.matter)) run("UPDATE matters SET status='dropped', closed_at=? WHERE id=?", Date.now(), u.matter); else deleteMatter(u.matter); }
      break;
    case "rename":
      run("UPDATE matters SET title=? WHERE id=?", u.title, u.id);
      dropKeys(u.id, u.keys);
      break;
    default: throw new Error(`不认识的操作 ${o.kind}`);
  }
  return pages;
}

export function undoOp(id: number, by: string, o: { force?: boolean } = {}) {
  const op = one("SELECT * FROM matter_ops WHERE id=?", id);
  if (!op) throw new Error(`没有操作 #${id}`);
  if (op.undone_at) throw new Error(`操作 #${id} 已经撤销过了`);
  const mine = new Set(JSON.parse(op.touches) as string[]);
  if (!o.force) {
    const later = all("SELECT id, touches FROM matter_ops WHERE id>? AND undone_at IS NULL ORDER BY id DESC", id)
      .find((x) => (JSON.parse(x.touches) as string[]).some((t) => mine.has(t)));
    if (later) throw new Error(`后面的操作 #${later.id} 动过同样的事，先撤销它`);
  }
  const pages = tx(() => {
    const p = reverse(op);
    run("UPDATE matter_ops SET undone_at=?, undone_by=? WHERE id=?", Date.now(), by, id);
    // changed his mind about this one: it goes back in the queue, but not straight back in front of him
    run("UPDATE matter_reviews SET status='pending', action=NULL, op_id=NULL, decided_at=NULL, decided_by=NULL, snooze_until=? WHERE op_id=?", Date.now() + 30 * 86400_000, id);
    return p;
  });
  settled(id, pages);
  return { id, undone: true };
}

/** before an import is taken back out: undo what was done to its matters, newest first */
export function undoOpsTouching(matterIds: number[], by: string): number {
  const want = new Set(matterIds.map((m) => `m${m}`));
  let n = 0;
  for (const o of all("SELECT id, touches FROM matter_ops WHERE undone_at IS NULL ORDER BY id DESC"))
    if ((JSON.parse(o.touches) as string[]).some((t) => want.has(t))) { undoOp(Number(o.id), by, { force: true }); n++; }
  return n;
}

export function listOps(o: { matter?: number; limit?: number } = {}) {
  const rows = all("SELECT id, ts, kind, summary, why, by, review_id, touches, undone_at, undone_by FROM matter_ops ORDER BY id DESC LIMIT ?", o.matter ? 500 : Math.min(o.limit ?? 30, 200));
  const hit = (r: Row) => !o.matter || (JSON.parse(r.touches) as string[]).includes(`m${o.matter}`);
  return rows.filter(hit).slice(0, o.limit ?? 30).map((r) => ({ ...r, touches: undefined }));
}

