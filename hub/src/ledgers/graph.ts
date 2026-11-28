// 因缘 (DESIGN §读4): who is around him, how they connect to each other and to matters, places and pages, and how each
// connection began. Borrowed from graphify: every edge says why it exists and how sure it is (EXTRACTED = straight from
// a record or confirmed by him, INFERRED = matched by name or someone's claim), the build is code only (no model), and
// queries are neighbours / shortest path / a small report.
//
// persons (his merges, splits, circles, notes, confirmed relations) are durable. graph_edges / graph_nodes are a view:
// dropped and rebuilt from messages, events, matters, pages and raw sources at most every 15 minutes.
// people.yaml (identity + trust, §读4.2) is only read here: being in persons gives nobody any permission.
// self/ and readings never enter the graph (§读5.1).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { all, one, run, tx, kvSet } from "../db/ambient.ts";
import { home, TZ } from "../home.ts";
import { log } from "../log.ts";
import { peopleConf } from "../config/load.ts";
import { ownerName, ownerFeishu } from "./conf.ts";
import { localStamp } from "../time.ts";

export type Conf = "EXTRACTED" | "INFERRED";
export const CIRCLES = ["家人", "朋友", "同事", "合作方", "同学", "邻里", "其他"] as const;
export const REL_PRESETS = ["夫妻", "家人", "同事", "上级", "下属", "朋友", "合作方", "同学", "介绍人"] as const;
const DAY = 86400_000, GAP = 10 * 60_000, WINDOW = 400 * DAY, MAX_AGE = 15 * 60_000;

// ───────── names and the registry ─────────

export const normName = (s: unknown) => String(s ?? "").replace(/[（(]他本人[)）]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
const skipName = (n: string) => !n || n.length < 2 && !/[\u4e00-\u9fff]/.test(n) || ["我", "?", "？", "bot", ownerName()].includes(n);
const now = () => Date.now();

function root(id: number): number {
  for (let i = 0; i < 10; i++) {
    const p = one("SELECT merged_into FROM persons WHERE id=?", id);
    if (!p?.merged_into) return id;
    id = p.merged_into;
  }
  return id;
}
export const byId = (kind: string, alias: string): number | null => {
  const r = one("SELECT person_id FROM person_aliases WHERE kind=? AND alias=?", kind, alias);
  return r ? root(r.person_id) : null;
};
/** a name → the one active person it names; "ambiguous" when two people share it (like graphify, never guess) */
export function byName(name: string): number | null | "ambiguous" {
  const n = normName(name);
  if (!n) return null;
  const ids = [...new Set(all("SELECT a.person_id id FROM person_aliases a JOIN persons p ON p.id=a.person_id WHERE a.kind='name' AND a.alias=? AND p.status='active'", n).map((r) => r.id as number))];
  return ids.length === 1 ? ids[0]! : ids.length ? "ambiguous" : null;
}
export const candidates = (name: string) =>
  all("SELECT DISTINCT p.id, p.name, p.circle FROM person_aliases a JOIN persons p ON p.id=a.person_id WHERE a.kind='name' AND a.alias LIKE ? AND p.status='active' LIMIT 8", `%${normName(name)}%`);

const addAlias = (kind: string, alias: string, pid: number, src: string) => {
  if (alias) run("INSERT OR IGNORE INTO person_aliases(kind, alias, person_id, src, ts) VALUES(?,?,?,?,?)", kind, kind === "name" ? normName(alias) : alias, pid, src, now());
};
function createPerson(name: string, src: string): number {
  const id = Number(run("INSERT INTO persons(name, status, created_at) VALUES(?, 'active', ?)", normName(name) || "（没名字）", now()).lastInsertRowid);
  if (!skipName(normName(name))) addAlias("name", name, id, src);
  return id;
}
const hasTable = (t: string) => !!one("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=?", t);
const hasKind = (pid: number, kind: string) => !!one("SELECT 1 FROM person_aliases WHERE person_id=? AND kind=?", pid, kind);

function titleOf(text: string, fallback: string) {
  const fm = /^---\n[\s\S]*?\btitle:\s*(.+)\n[\s\S]*?---/.exec(text)?.[1];
  return normName(fm?.replace(/^["']|["']$/g, "") || /^#\s+(.+)$/m.exec(text)?.[1] || fallback);
}

/** Make sure everyone we can see has a person row: people.yaml (read only), people pages, message senders, event actors. */
function register(since: number) {
  const cfg = peopleConf() as Record<string, any>;
  for (const [key, v] of Object.entries(cfg)) {
    if (key === "owner" || !v || typeof v !== "object") continue;
    const name = normName(v.name ?? key), ids = v.ids ?? {};
    let pid = one("SELECT id FROM persons WHERE config_key=? AND status='active'", key)?.id as number | undefined;
    pid ??= (ids.feishu && byId("feishu", ids.feishu)) || (ids.wechat && byId("wechat", ids.wechat)) || undefined;
    if (!pid) { const n = byName(name); pid = typeof n === "number" ? n : createPerson(name, "config"); }
    run("UPDATE persons SET config_key=? WHERE id=?", key, pid);
    if (ids.feishu) addAlias("feishu", String(ids.feishu), pid, "config");
    if (ids.wechat) addAlias("wechat", String(ids.wechat), pid, "config");
    addAlias("name", name, pid, "config");
  }
  const dir = join(home().agentHome, "people");
  if (existsSync(dir)) for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    const slug = f.slice(0, -3), title = titleOf(readFileSync(join(dir, f), "utf8").slice(0, 4000), slug);
    let pid = one("SELECT id FROM persons WHERE slug=? AND status='active'", slug)?.id as number | undefined;
    if (!pid) {
      const n = byName(title);
      pid = typeof n === "number" && !one("SELECT slug FROM persons WHERE id=?", n)?.slug ? n : createPerson(title, "page");
      run("UPDATE persons SET slug=? WHERE id=?", slug, pid);
    }
    addAlias("name", title, pid, "page");
    if (slug !== title) addAlias("name", slug, pid, "page");
  }
  // bare column with MAX(ts): SQLite takes it from the newest row, so a renamed sender gets the current name
  for (const s of all(`SELECT surface, sender_id, json_extract(raw_json,'$.sender_name') name, MIN(ts) f, MAX(ts) l FROM messages
      WHERE sender_kind='other' AND sender_id IS NOT NULL AND (surface LIKE 'feishu:%' OR surface LIKE 'wechat:%') AND ts>=? GROUP BY sender_id`, since)) {
    const kind = String(s.surface).startsWith("wechat") ? "wechat" : "feishu", name = normName(s.name);
    let pid = byId(kind, s.sender_id);
    if (!pid) {
      const n = name ? byName(name) : null;
      pid = typeof n === "number" && !hasKind(n, kind) ? n : createPerson(name, "seen");
      addAlias(kind, s.sender_id, pid, "seen");
    }
    if (name && !skipName(name)) { addAlias("name", name, pid, "seen"); run("UPDATE persons SET name=? WHERE id=? AND name=config_key", name, pid); }
  }
  for (const r of all("SELECT DISTINCT actor FROM events WHERE actor IS NOT NULL AND ts>=?", since))
    for (const n of String(r.actor).split("、").map(normName)) if (!skipName(n) && byName(n) === null) createPerson(n, "event");
}

// ───────── the build ─────────

interface Edge { a: string; b: string; rel: string; conf: Conf; w: number; f: number; l: number; ev: string[] }
interface Node { kind: string; label: string; ts: number }
const SYM = new Set(["talks", "rel"]);

/** where a person first showed up in his world; `with` = who else was talking there then */
interface Via { kind: "chat" | "matter" | "page"; id?: string | number; label: string; with?: string[]; me?: boolean }

function build() {
  const since = now() - WINDOW;
  const nodes = new Map<string, Node>(), edges = new Map<string, Edge>();
  const first = new Map<number, { ts: number; via: Via; chat?: string }>(), last = new Map<number, number>();
  const node = (id: string, kind: string, label: string, ts = 0) => { const n = nodes.get(id); if (!n) nodes.set(id, { kind, label, ts }); else if (label && ts >= n.ts) { n.label = label; n.ts = ts; } return id; };
  const add = (a: string | null, b: string | null, rel: string, conf: Conf, ts: number, ev?: string, w = 1) => {
    if (!a || !b || a === b) return;
    if (SYM.has(rel) && a > b) [a, b] = [b, a];
    const k = `${a}\u0000${b}\u0000${rel}`;
    const e = edges.get(k);
    // an edge backed by at least one explicit record is EXTRACTED (graphify's weakest-hop rule is for paths, below)
    if (!e) edges.set(k, { a, b, rel, conf, w, f: ts, l: ts, ev: ev ? [ev] : [] });
    else { e.w += w; e.f = Math.min(e.f, ts); e.l = Math.max(e.l, ts); if (conf === "EXTRACTED") e.conf = conf; if (ev && e.ev.length < 5 && !e.ev.includes(ev)) e.ev.push(ev); }
  };
  const seen = (pid: number, ts: number, via: Via, chat?: string) => {
    const f = first.get(pid);
    if (!f || ts < f.ts) first.set(pid, { ts, via, chat });
    if (ts > (last.get(pid) ?? 0)) last.set(pid, ts);
  };

  const persons = all("SELECT id, name FROM persons WHERE status='active'");
  const hidden = new Set(all("SELECT id FROM persons WHERE status='hidden'").map((r) => r.id as number));
  for (const p of persons) node(`p:${p.id}`, "person", p.name);
  node("me", "me", ownerName());
  const pidCache = new Map<string, number | null>();
  const pidOf = (kind: string, id: string | null) => {
    if (!id) return null;
    const k = `${kind}:${id}`;
    if (!pidCache.has(k)) { const p = byId(kind, id); pidCache.set(k, p && !hidden.has(p) ? p : null); }
    return pidCache.get(k)!;
  };
  const owner = ownerFeishu();
  const keyOf = (sk: string, sid: string | null, surface: string) => sk === "owner" ? "me" : (() => { const p = pidOf(String(surface).startsWith("wechat") ? "wechat" : "feishu", sid); return p ? `p:${p}` : null; })();
  const pnum = (k: string) => Number(k.slice(2));

  // 1. messages: who talks where, who talks right after whom (10 min), @-mentions, private chats with him
  for (const r of all(`SELECT chat_id, surface, ts, sk, sid, chat, men, LAG(sk) OVER w psk, LAG(sid) OVER w psid, LAG(ts) OVER w pts FROM (
        SELECT chat_id, surface, ts, sender_kind sk, sender_id sid, json_extract(raw_json,'$.chat_name') chat, json_extract(raw_json,'$.mentions') men
        FROM messages WHERE ts>=? AND sender_kind IN ('owner','other') AND (surface LIKE 'feishu:%' OR surface LIKE 'wechat:%') AND surface<>'feishu:dm')
      WINDOW w AS (PARTITION BY chat_id ORDER BY ts)`, since)) {
    const k = keyOf(r.sk, r.sid, r.surface);
    if (!k) continue;
    const priv = /:(p2p|dm|private)$/.test(r.surface), chat = String(r.chat ?? r.chat_id);
    if (k !== "me") {
      if (priv) { add("me", k, "dm", "EXTRACTED", r.ts, "私聊"); seen(pnum(k), r.ts, { kind: "chat", label: "私聊", me: true }); }
      else { add(k, node(`c:${r.chat_id}`, "place", chat, r.ts), "in", "EXTRACTED", r.ts, chat); seen(pnum(k), r.ts, { kind: "chat", id: r.chat_id, label: chat }, r.chat_id); }
    }
    if (!priv && r.psk && r.ts - r.pts <= GAP) add(k, keyOf(r.psk, r.psid, r.surface), "talks", "EXTRACTED", r.ts, chat);
    if (r.men) {
      let men: unknown = []; try { men = JSON.parse(r.men); } catch { /* */ }
      if (Array.isArray(men)) for (const id of men.slice(0, 10)) add(k, id === owner ? "me" : (() => { const p = pidOf("feishu", String(id)); return p ? `p:${p}` : null; })(), "talks", "EXTRACTED", r.ts, `@ · ${chat}`);
    }
  }

  // 2. events → person ↔ matter (by the messages' sender ids; by name only for imports = INFERRED), matter ↔ place
  // one node per 主线: 子事 and merged matters count towards it, so the graph follows every regrouping (and its undo)
  const matters = all("SELECT id, title, opened_at, file_path, status, parent_id, merged_into FROM matters");
  const mById = new Map(matters.map((m) => [Number(m.id), m]));
  const mRoot = (id: number) => {
    let m = mById.get(id);
    for (let i = 0; m?.merged_into && i < 20; i++) m = mById.get(Number(m.merged_into));
    const p = m?.parent_id ? mById.get(Number(m.parent_id)) : undefined;
    return Number((p ?? m)?.id ?? id);
  };
  for (const m of matters) if (mRoot(Number(m.id)) === Number(m.id)) node(`m:${m.id}`, "matter", m.title ?? `事 #${m.id}`, m.opened_at ?? 0);
  for (const e of all("SELECT id, ts, actor, matter_id, place, place_id, msg_ids_json AS msg_ids, source FROM events WHERE ts>=?", since)) {
    const who = new Map<number, Conf>();
    let ids: unknown = []; try { ids = JSON.parse(e.msg_ids ?? "[]"); } catch { /* */ }
    if (Array.isArray(ids) && ids.length) {
      const q = ids.slice(0, 30).map(String);
      for (const s of all(`SELECT DISTINCT sender_id, surface FROM messages WHERE sender_kind='other' AND id IN (${q.map(() => "?").join(",")})`, ...q)) {
        const p = pidOf(String(s.surface).startsWith("wechat") ? "wechat" : "feishu", s.sender_id);
        if (p) who.set(p, "EXTRACTED");
      }
    }
    if (!who.size && e.actor) for (const n of String(e.actor).split("、")) { const p = byName(n); if (typeof p === "number" && !hidden.has(p)) who.set(p, "INFERRED"); }
    const mid = e.matter_id ? mRoot(Number(e.matter_id)) : null, m = mid ? `m:${mid}` : null;
    for (const [p, conf] of who) {
      if (m && nodes.has(m)) add(`p:${p}`, m, "matter", conf, e.ts, `事件 #${e.id}`);
      seen(p, e.ts, m && nodes.has(m) ? { kind: "matter", id: mid!, label: nodes.get(m)!.label } : { kind: "chat", label: e.place ?? "事件" });
    }
    if (m && nodes.has(m) && e.place_id && nodes.has(`c:${e.place_id}`)) add(m, `c:${e.place_id}`, "at", "EXTRACTED", e.ts, e.place ?? undefined);
  }

  // 3. pages: wiki links and links in markdown are EXTRACTED; a known person's name in a page is INFERRED.
  //    people/<slug>.md stands for the person, matters/<id>.md for the matter, anything else is a page node.
  const slugMap = new Map(all("SELECT id, slug FROM persons WHERE slug IS NOT NULL").map((r) => [r.slug as string, root(r.id)]));
  const titles = new Map((hasTable("pages") ? all("SELECT path, title FROM pages") : []).map((r) => [r.path as string, r.title as string]));
  const pageNode = (rel: string, ts = 0): string | null => {
    if (rel.startsWith("self/")) return null;
    const pm = /^people\/(.+)\.md$/.exec(rel);
    if (pm) { const p = slugMap.get(pm[1]!); return p && !hidden.has(p) ? `p:${p}` : null; }
    const mm = /^matters\/(\d+)\.md$/.exec(rel);
    if (mm) { const k = `m:${mRoot(Number(mm[1]))}`; return nodes.has(k) ? k : null; }
    return node(`g:${rel}`, "page", titles.get(rel) ?? rel.replace(/\.md$/, ""), ts);
  };
  const known = all(`SELECT DISTINCT a.alias name, p.id FROM persons p JOIN person_aliases a ON a.person_id=p.id
      WHERE p.status='active' AND (p.slug IS NOT NULL OR p.config_key IS NOT NULL) AND a.kind='name' AND length(a.alias)>=2`)
    .filter((r) => !skipName(r.name) && byName(r.name) === r.id);
  for (const rel of walk(home().agentHome)) {
    let text: string, mt: number;
    try { const f = join(home().agentHome, rel); if (statSync(f).size > 400_000) continue; text = readFileSync(f, "utf8"); mt = statSync(f).mtimeMs; } catch { continue; }
    const links = new Set<string>();
    for (const x of text.matchAll(/\[\[([^\]|#\n]+)(?:[|#][^\]\n]*)?\]\]/g)) links.add(posix.normalize(x[1]!.trim().replace(/\.md$/, "") + ".md"));
    for (const x of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) if (!/^[a-z]+:/i.test(x[1]!)) links.add(posix.normalize(posix.join(posix.dirname(rel), x[1]!)));
    let src: string | null | undefined;
    const me = () => (src === undefined ? (src = pageNode(rel, mt)) : src);
    for (const to of links) if (to !== rel && existsSync(join(home().agentHome, to))) add(me(), pageNode(to), "link", "EXTRACTED", mt, rel);
    if (/^(people|matters|topics|projects|sources|groups)\/|^(USER|MEMORY)\.md$/.test(rel))
      for (const k of known) if (text.includes(k.name)) add(me(), `p:${k.id}`, "mentions", "INFERRED", mt, rel);
  }
  for (const m of matters) {   // 关键人 a matter page lists, by name
    if (!m.file_path) continue;
    let text = ""; try { text = readFileSync(join(home().agentHome, m.file_path), "utf8"); } catch { continue; }
    const sec = /\n## 关键人\n([\s\S]*?)(?=\n## |$)/.exec(text)?.[1] ?? "";
    for (const line of sec.split("\n")) for (const tok of line.replace(/^[-*]\s*(\[[^\]]*\]\s*)*/, "").split(/[、，,；;\/]/)) {
      const n = normName(tok.replace(/[（(].*$/, "").replace(/[:：].*$/, ""));
      const p = n.length >= 2 ? byName(n) : null;
      if (typeof p === "number" && !hidden.has(p)) add(`p:${p}`, `m:${mRoot(Number(m.id))}`, "key", "INFERRED", m.opened_at ?? 0, "关键人");
    }
  }
  // 4. raw sources (§读1.5): a document links the pages it fed (the table comes with ingest; until then there is none)
  if (hasTable("raw_sources")) for (const r of all("SELECT sha256, title, pages_json, received_at FROM raw_sources WHERE pages_json IS NOT NULL")) {
    let pages: unknown = []; try { pages = JSON.parse(r.pages_json); } catch { /* */ }
    if (!Array.isArray(pages)) continue;
    for (const pg of pages.slice(0, 20)) add(node(`r:${r.sha256}`, "raw", r.title ?? String(r.sha256).slice(0, 8), r.received_at ?? 0), pageNode(String(pg)), "source", "EXTRACTED", r.received_at ?? 0, r.title ?? undefined);
  }
  // 5. relations he confirmed or someone stated
  for (const r of all("SELECT * FROM relations WHERE status='active'")) {
    const a = root(r.a), b = root(r.b);
    if (hidden.has(a) || hidden.has(b)) continue;
    add(`p:${a}`, `p:${b}`, "rel", r.conf, r.ts, r.rel);
  }
  // first sight for people only known from pages
  for (const [slug, p] of slugMap) if (!first.has(p)) { try { seen(p, statSync(join(home().agentHome, "people", `${slug}.md`)).birthtimeMs || 0, { kind: "page", label: `people/${slug}.md` }); } catch { /* */ } }
  // only nodes that carry an edge (plus me and every matter) are worth drawing
  const used = new Set<string>(["me"]);
  for (const e of edges.values()) { used.add(e.a); used.add(e.b); }
  for (const id of [...nodes.keys()]) if (!used.has(id) && !id.startsWith("m:")) nodes.delete(id);
  return { nodes, edges, first, last };
}

function walk(base: string, d = base, out: string[] = []): string[] {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const full = join(d, e.name), rel = full.slice(base.length + 1).split("\\").join("/");
    if (e.isDirectory()) { if (!["self", "journal", "skills"].includes(rel)) walk(base, full, out); }
    else if (e.name.endsWith(".md") && !["AGENTS.md", "SOUL.md", "index.md", "log.md"].includes(rel)) out.push(rel);
  }
  return out;
}

/** circles: weighted label propagation over person ↔ person ties; deterministic (fixed order, ties → smaller label) */
function clusters(edges: Map<string, Edge>) {
  const adj = new Map<number, Map<number, number>>();
  const tie = (a: number, b: number, w: number) => {
    for (const [x, y] of [[a, b], [b, a]] as [number, number][]) { const m = adj.get(x) ?? new Map(); m.set(y, (m.get(y) ?? 0) + w); adj.set(x, m); }
  };
  const byMatter = new Map<string, number[]>();
  for (const e of edges.values()) {
    const pa = e.a.startsWith("p:"), pb = e.b.startsWith("p:");
    if (pa && pb) tie(Number(e.a.slice(2)), Number(e.b.slice(2)), e.rel === "rel" ? 8 : e.rel === "mentions" ? 1 : Math.log2(1 + e.w));
    else if (pa && e.b.startsWith("m:")) byMatter.set(e.b, [...(byMatter.get(e.b) ?? []), Number(e.a.slice(2))]);
  }
  for (const ps of byMatter.values()) if (ps.length <= 15) for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) tie(ps[i]!, ps[j]!, 1);
  const ids = [...adj.keys()].sort((a, b) => a - b), label = new Map(ids.map((i) => [i, i]));
  for (let round = 0; round < 20; round++) {
    let moved = 0;
    for (const i of ids) {
      const score = new Map<number, number>();
      for (const [j, w] of adj.get(i)!) score.set(label.get(j)!, (score.get(label.get(j)!) ?? 0) + w);
      let best = label.get(i)!, bw = score.get(best) ?? 0;
      for (const [l, w] of score) if (w > bw || (w === bw && l < best)) { best = l; bw = w; }
      if (best !== label.get(i)) { label.set(i, best); moved++; }
    }
    if (!moved) break;
  }
  return label;
}

let builtAt = 0;
export const markDirty = () => { builtAt = 0; };

export function rebuildGraph() {
  const t0 = now();
  tx(() => register(t0 - WINDOW));
  const { nodes, edges, first, last } = build();
  const label = clusters(edges);
  tx(() => {
    run("DELETE FROM graph_edges"); run("DELETE FROM graph_nodes");
    const ni = (id: string, n: Node) => run("INSERT INTO graph_nodes(id, kind, label, ts) VALUES(?,?,?,?)", id, n.kind, n.label, n.ts || null);
    for (const [id, n] of nodes) ni(id, n);
    for (const e of edges.values()) run("INSERT INTO graph_edges(a, b, rel, conf, weight, first_ts, last_ts, evidence_json) VALUES(?,?,?,?,?,?,?,?)",
      e.a, e.b, e.rel, e.conf, +e.w.toFixed(2), e.f || null, e.l || null, JSON.stringify(e.ev));
    run("UPDATE persons SET cluster=NULL WHERE cluster IS NOT NULL");
    for (const [p, l] of label) run("UPDATE persons SET cluster=? WHERE id=?", l, p);
    for (const [p, f] of first) {
      const cur = one("SELECT first_seen FROM persons WHERE id=?", p);
      if (cur?.first_seen && cur.first_seen <= f.ts) continue;   // first sight only moves earlier (old messages may be pruned)
      const via = { ...f.via };
      if (f.chat) {   // who else was there, ±30 minutes around the first message
        const around = all("SELECT DISTINCT sender_kind sk, sender_id sid FROM messages WHERE chat_id=? AND ts BETWEEN ? AND ? AND sender_kind IN ('owner','other') LIMIT 30", f.chat, f.ts - 1800_000, f.ts + 1800_000);
        via.me = around.some((r) => r.sk === "owner");
        via.with = [...new Set(around.filter((r) => r.sk === "other").map((r) => byId("feishu", r.sid)).filter((x): x is number => !!x && x !== p))]
          .slice(0, 4).map((x) => one("SELECT name FROM persons WHERE id=?", x)?.name).filter(Boolean);
      }
      run("UPDATE persons SET first_seen=?, first_via_json=? WHERE id=?", f.ts || null, JSON.stringify(via), p);
    }
    for (const [p, ts] of last) run("UPDATE persons SET last_seen=MAX(COALESCE(last_seen,0), ?) WHERE id=?", ts, p);
  });
  builtAt = now();
  kvSet("graph.built", String(builtAt));
  log("graph", "rebuilt", { nodes: nodes.size, edges: edges.size, ms: builtAt - t0 });
  return { nodes: nodes.size, edges: edges.size, ms: builtAt - t0 };
}
export function ensureGraph() { if (now() - builtAt > MAX_AGE) rebuildGraph(); }

// ───────── his corrections ─────────

export function setPerson(id: number, b: { name?: unknown; circle?: unknown; note?: unknown; hidden?: unknown }) {
  const p = one("SELECT * FROM persons WHERE id=?", id);
  if (!p || p.status === "merged") throw new Error("没有这个人");
  if (typeof b.name === "string" && normName(b.name)) { run("UPDATE persons SET name=? WHERE id=?", normName(b.name), id); addAlias("name", b.name, id, "owner"); }
  if (b.circle !== undefined) run("UPDATE persons SET circle=? WHERE id=?", CIRCLES.includes(b.circle as any) ? b.circle : null, id);
  if (typeof b.note === "string") run("UPDATE persons SET note=? WHERE id=?", b.note.trim().slice(0, 300) || null, id);
  if (typeof b.hidden === "boolean") run("UPDATE persons SET status=? WHERE id=?", b.hidden ? "hidden" : "active", id);
  markDirty();
  return one("SELECT * FROM persons WHERE id=?", id);
}

/** two rows are one person: aliases and relations move to `into`; `from` stays as a pointer (merged_into) */
export function mergePersons(from: number, into: number) {
  const a = one("SELECT * FROM persons WHERE id=?", from), b = one("SELECT * FROM persons WHERE id=?", into);
  if (!a || !b || from === into || a.status === "merged" || b.status === "merged") throw new Error("合并不了：人不对");
  if (a.config_key && b.config_key) throw new Error("这两个在 people.yaml 里是两个人，要合并先改 people.yaml");
  tx(() => {
    run("INSERT OR IGNORE INTO person_aliases(kind, alias, person_id, src, ts) SELECT kind, alias, ?, src, ts FROM person_aliases WHERE person_id=?", into, from);
    run("DELETE FROM person_aliases WHERE person_id=?", from);
    run("UPDATE relations SET a=? WHERE a=?", into, from); run("UPDATE relations SET b=? WHERE b=?", into, from);
    run("UPDATE relations SET status='dropped' WHERE a=b");
    run(`UPDATE persons SET slug=COALESCE(slug, ?), config_key=COALESCE(config_key, ?), circle=COALESCE(circle, ?), note=COALESCE(note, ?),
         first_seen=MIN(COALESCE(first_seen, ?), COALESCE(?, first_seen)), first_via_json=CASE WHEN ? < COALESCE(first_seen, 9e15) THEN ? ELSE first_via_json END WHERE id=?`,
      a.slug, a.config_key, a.circle, a.note, a.first_seen, a.first_seen, a.first_seen ?? 9e15, a.first_via_json, into);
    run("UPDATE persons SET status='merged', merged_into=? WHERE id=?", into, from);
  });
  markDirty();
  return { into };
}

/** one alias was matched to the wrong person: it becomes its own person */
export function splitAlias(from: number, kind: string, alias: string) {
  if (!one("SELECT 1 FROM person_aliases WHERE person_id=? AND kind=? AND alias=?", from, kind, alias)) throw new Error("这个人没有这个叫法");
  const name = kind === "name" ? alias
    : normName(one("SELECT json_extract(raw_json,'$.sender_name') n FROM messages WHERE sender_id=? ORDER BY ts DESC LIMIT 1", alias)?.n) || "（拆出来的）";
  return tx(() => {
    const id = Number(run("INSERT INTO persons(name, status, created_at) VALUES(?, 'active', ?)", name, now()).lastInsertRowid);
    run("UPDATE person_aliases SET person_id=?, src='owner' WHERE person_id=? AND kind=? AND alias=?", id, from, kind, alias);
    if (kind !== "name") addAlias("name", name, id, "owner");
    markDirty();
    return { id };
  });
}

/** a relation between two people. Only his own click in the console is EXTRACTED; anything relayed by the agent is INFERRED. */
export function addRelation(a: number, b: number, rel: string, o: { conf: Conf; src: string; evidence?: string }) {
  rel = String(rel ?? "").trim().slice(0, 12);
  a = root(a); b = root(b);
  if (!rel || a === b || !one("SELECT 1 FROM persons WHERE id=?", a) || !one("SELECT 1 FROM persons WHERE id=?", b)) throw new Error("关系记不了：人或关系不对");
  const same = one("SELECT * FROM relations WHERE status='active' AND rel=? AND ((a=? AND b=?) OR (a=? AND b=?))", rel, a, b, b, a);
  if (same) {
    if (o.conf === "EXTRACTED" && same.conf !== "EXTRACTED") run("UPDATE relations SET conf='EXTRACTED', src=? WHERE id=?", o.src, same.id);
    markDirty();
    return { id: same.id as number };
  }
  const id = Number(run("INSERT INTO relations(a, b, rel, conf, src, evidence, ts) VALUES(?,?,?,?,?,?,?)", a, b, rel, o.conf, o.src, o.evidence?.slice(0, 300) ?? null, now()).lastInsertRowid);
  markDirty();
  return { id };
}
export function setRelation(id: number, act: "confirm" | "drop") {
  if (!run(act === "confirm" ? "UPDATE relations SET conf='EXTRACTED', src='owner@console' WHERE id=?" : "UPDATE relations SET status='dropped' WHERE id=?", id).changes) throw new Error("没有这条关系");
  markDirty();
  return { ok: true };
}

// ───────── reading the graph ─────────

const pj = (s: unknown) => { try { return JSON.parse(String(s ?? "null")); } catch { return null; } };
const REL_ZH: Record<string, string> = { talks: "常说话", in: "在群里", dm: "私聊", matter: "一起的事", key: "关键人", at: "在这儿说", link: "页面链接", mentions: "页面提到", source: "资料", rel: "关系" };
export interface GEdge { a: string; b: string; rel: string; conf: Conf; weight: number; first_ts: number | null; last_ts: number | null; evidence: string[]; label: string }
const edgeView = (e: Record<string, any>): GEdge => ({ a: e.a, b: e.b, rel: e.rel, conf: e.conf, weight: e.weight, first_ts: e.first_ts, last_ts: e.last_ts,
  evidence: pj(e.evidence_json) ?? [], label: e.rel === "rel" ? (pj(e.evidence_json) ?? []).join("、") : REL_ZH[e.rel] ?? e.rel });
const edgesOf = (id: string) => all("SELECT * FROM graph_edges WHERE a=? OR b=?", id, id).map(edgeView);
const other = (e: GEdge, id: string) => (e.a === id ? e.b : e.a);
const nodeRow = (id: string) => one("SELECT * FROM graph_nodes WHERE id=?", id);

/** circle names without a model (like graphify's LLM-free labels): the group most of them share, else two names */
function clusterNames() {
  const members = new Map<number, Record<string, any>[]>();
  for (const p of all("SELECT id, name, cluster FROM persons WHERE status='active' AND cluster IS NOT NULL")) members.set(p.cluster, [...(members.get(p.cluster) ?? []), p]);
  const out = new Map<number, { label: string; size: number }>();
  for (const [c, ps] of members) {
    if (ps.length < 2) continue;
    const places = all(`SELECT b, COUNT(DISTINCT a) n, SUM(weight) w FROM graph_edges WHERE rel='in' AND a IN (${ps.map(() => "?").join(",")}) GROUP BY b ORDER BY n DESC, w DESC LIMIT 1`, ...ps.map((p) => `p:${p.id}`))[0];
    const label = places && places.n >= Math.max(2, ps.length / 2) ? `「${nodeRow(places.b)?.label ?? "群"}」那拨人` : `${ps.slice(0, 2).map((p) => p.name).join("、")}${ps.length > 2 ? " 等" : ""}`;
    out.set(c, { label, size: ps.length });
  }
  return out;
}
const meWeight = (pid: number) => one("SELECT COALESCE(SUM(weight),0) w FROM graph_edges WHERE (a='me' AND b=?) OR (b='me' AND a=?)", `p:${pid}`, `p:${pid}`)!.w as number;
const configOf = (key: string | null) => {
  if (!key) return null;
  const v = (peopleConf() as Record<string, any>)[key];
  return v && typeof v === "object" ? { key, relation: v.relation ?? null, importance: v.importance ?? null } : null;
};

export function peopleList(q = "", circle = "") {
  ensureGraph();
  const names = clusterNames();
  const rows = all(`SELECT p.*, (SELECT COUNT(*) FROM graph_edges g WHERE g.a='p:'||p.id AND g.rel IN ('matter','key')) matters,
      (SELECT COUNT(*) FROM person_aliases a WHERE a.person_id=p.id AND a.kind<>'name') ids
    FROM persons p WHERE p.status IN ('active','hidden') ${q ? "AND (p.name LIKE ? OR p.id IN (SELECT person_id FROM person_aliases WHERE alias LIKE ?))" : ""}`, ...(q ? [`%${q}%`, `%${q}%`] : []));
  return rows.map((p) => ({ id: p.id, name: p.name, circle: p.circle, auto_circle: p.cluster != null ? names.get(p.cluster)?.label ?? null : null, cluster: p.cluster,
    config: configOf(p.config_key), slug: p.slug, note: p.note, first_seen: p.first_seen, last_seen: p.last_seen, matters: p.matters, hidden: p.status === "hidden",
    name_only: !p.ids && !p.slug && !p.config_key, me: meWeight(p.id) }))
    .filter((p) => !circle || p.circle === circle || (circle === "未分" && !p.circle))
    .sort((a, b) => Number(a.hidden) - Number(b.hidden) || (b.last_seen ?? 0) - (a.last_seen ?? 0) || b.me - a.me);
}

export function personDetail(id: number) {
  ensureGraph();
  id = root(id);
  const p = one("SELECT * FROM persons WHERE id=?", id);
  if (!p) throw new Error("没有这个人");
  const self = `p:${id}`, es = edgesOf(self);
  const label = (n: string) => n === "me" ? "你" : nodeRow(n)?.label ?? n;
  const near = (rels: string[]) => es.filter((e) => rels.includes(e.rel)).map((e) => ({ ...e, id: other(e, self), name: label(other(e, self)) })).sort((x, y) => y.weight - x.weight);
  const ids = all("SELECT kind, alias FROM person_aliases WHERE person_id=? AND kind<>'name'", id).map((r) => r.alias as string);
  const month = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit" });
  const byMonth = new Map<string, number>();
  if (ids.length) for (const r of all(`SELECT ts FROM messages WHERE sender_id IN (${ids.map(() => "?").join(",")}) AND ts>=?`, ...ids, now() - 365 * DAY)) { const m = month.format(new Date(r.ts)); byMonth.set(m, (byMonth.get(m) ?? 0) + 1); }
  const monthly = [...byMonth].sort((a, b) => a[0].localeCompare(b[0])).map(([m, n]) => ({ m, n }));
  return {
    id, name: p.name, circle: p.circle, note: p.note, hidden: p.status === "hidden", slug: p.slug, config: configOf(p.config_key),
    auto_circle: p.cluster != null ? clusterNames().get(p.cluster)?.label ?? null : null,
    first_seen: p.first_seen, first_via: pj(p.first_via_json), last_seen: p.last_seen,
    aliases: all("SELECT kind, alias, src FROM person_aliases WHERE person_id=? ORDER BY kind, ts", id).map((a) => ({ ...a, alias: a.kind === "name" ? a.alias : `${String(a.alias).slice(0, 6)}…`, raw: a.alias })),
    people: near(["talks", "rel", "mentions"]).filter((e) => e.id.startsWith("p:") || e.id === "me"),
    matters: near(["matter", "key"]), places: near(["in"]), pages: near(["link", "mentions", "source"]).filter((e) => !e.id.startsWith("p:")),
    relations: all("SELECT * FROM relations WHERE status='active' AND (a=? OR b=?) ORDER BY ts DESC", id, id).map((r) => ({ ...r, other: r.a === id ? r.b : r.a, other_name: one("SELECT name FROM persons WHERE id=?", r.a === id ? r.b : r.a)?.name, dir: r.a === id ? "out" : "in" })),
    monthly, page: p.slug && existsSync(join(home().agentHome, "people", `${p.slug}.md`)) ? readFileSync(join(home().agentHome, "people", `${p.slug}.md`), "utf8").slice(0, 60_000) : "",
  };
}

interface View { nodes: { id: string; kind: string; label: string; weight: number; cluster?: number | null; focus?: boolean }[]; edges: GEdge[] }
function viewOf(ids: Set<string>, focus?: string, keep = (_e: GEdge) => true): View {
  const list = [...ids];
  const edges = list.length ? all(`SELECT * FROM graph_edges WHERE a IN (${list.map(() => "?").join(",")}) AND b IN (${list.map(() => "?").join(",")})`, ...list, ...list).map(edgeView).filter(keep) : [];
  const w = new Map<string, number>();
  for (const e of edges) { w.set(e.a, (w.get(e.a) ?? 0) + e.weight); w.set(e.b, (w.get(e.b) ?? 0) + e.weight); }
  const cl = new Map(all("SELECT id, cluster FROM persons WHERE cluster IS NOT NULL").map((r) => [`p:${r.id}`, r.cluster]));
  return { nodes: list.map((id) => { const n = id === "me" ? { kind: "me", label: ownerName() } : nodeRow(id); return { id, kind: n?.kind ?? "page", label: n?.label ?? id, weight: w.get(id) ?? 0, cluster: cl.get(id) ?? null, focus: id === focus }; }), edges };
}

/** the circle view: him in the middle, the people with the most ties around, their ties to each other (and shared matters) */
export function circleView(limit = 60, withMatters = false): View & { circles: { id: number; label: string; size: number }[] } {
  ensureGraph();
  const top = all(`SELECT n.id, COALESCE((SELECT SUM(weight) FROM graph_edges WHERE a=n.id OR b=n.id), 0) w FROM graph_nodes n WHERE n.kind='person' ORDER BY w DESC LIMIT ?`, Math.min(limit, 200));
  const ids = new Set<string>(["me", ...top.map((r) => r.id as string)]);
  if (withMatters) for (const m of all(`SELECT b, COUNT(*) n FROM graph_edges WHERE rel IN ('matter','key') AND a IN (${[...ids].map(() => "?").join(",")}) GROUP BY b HAVING n>=2 ORDER BY n DESC LIMIT 20`, ...ids)) ids.add(m.b);
  const v = viewOf(ids, "me", (e) => ["talks", "rel", "dm", "matter", "key", "mentions"].includes(e.rel));
  return { ...v, circles: [...clusterNames()].map(([id, c]) => ({ id, ...c })).sort((a, b) => b.size - a.size) };
}

/** one node and its neighbourhood: depth 1 (top 40 by weight), plus people two steps away when depth is 2 */
export function egoView(focus: string, depth = 1): View {
  ensureGraph();
  if (focus.startsWith("p:")) focus = `p:${root(Number(focus.slice(2)))}`;
  if (focus !== "me" && !nodeRow(focus)) throw new Error("图里没有这个节点");
  const ids = new Set([focus]);
  const ring = edgesOf(focus).filter((e) => focus === "me" || other(e, focus) !== "me").sort((a, b) => b.weight - a.weight).slice(0, 40).map((e) => other(e, focus));
  for (const n of ring) ids.add(n);
  if (depth >= 2) {
    const more = new Map<string, number>();
    for (const n of ring.slice(0, 15)) for (const e of edgesOf(n)) { const o = other(e, n); if (o !== "me" && !ids.has(o) && o.startsWith("p:")) more.set(o, (more.get(o) ?? 0) + e.weight); }
    for (const [o] of [...more].sort((a, b) => b[1] - a[1]).slice(0, 25)) ids.add(o);
  }
  return viewOf(ids, focus);
}

/** shortest path between two nodes, never through him (he is next to everyone); confidence = the weakest hop */
export function pathBetween(from: string, to: string, maxDepth = 4) {
  ensureGraph();
  const prev = new Map<string, { n: string; e: GEdge }>([[from, null as any]]);
  let layer = [from];
  for (let d = 0; d < maxDepth && layer.length && !prev.has(to); d++) {
    const next: string[] = [];
    for (const n of layer) for (const e of edgesOf(n).sort((a, b) => b.weight - a.weight)) {
      const o = other(e, n);
      if (prev.has(o) || (o === "me" && to !== "me")) continue;
      prev.set(o, { n, e }); next.push(o);
    }
    layer = next.slice(0, 2000);
  }
  if (!prev.has(to)) return null;
  const hops: { from: string; to: string; edge: GEdge }[] = [];
  for (let n = to; n !== from; n = prev.get(n)!.n) hops.unshift({ from: prev.get(n)!.n, to: n, edge: prev.get(n)!.e });
  return { hops, conf: (hops.some((h) => h.edge.conf === "INFERRED") ? "INFERRED" : "EXTRACTED") as Conf };
}

/** 借机观察: facts to look at, not judgements. Shown in the console only; nothing here is sent anywhere. */
export function observations() {
  ensureGraph();
  const t = now(), names = clusterNames();
  const pr = (r: Record<string, any>) => ({ id: r.id as number, name: r.name as string, first_seen: r.first_seen, first_via: pj(r.first_via_json), last_seen: r.last_seen });
  const fresh = all("SELECT * FROM persons WHERE status='active' AND first_seen>=? ORDER BY first_seen DESC LIMIT 20", t - 30 * DAY).map(pr);
  const fading = all(`SELECT p.*, (SELECT SUM(weight) FROM graph_edges g WHERE g.a='p:'||p.id OR g.b='p:'||p.id) w FROM persons p
      WHERE p.status='active' AND p.last_seen BETWEEN ? AND ? ORDER BY w DESC LIMIT 40`, t - 365 * DAY, t - 60 * DAY).filter((r) => (r.w ?? 0) >= 15).slice(0, 15).map((r) => ({ ...pr(r), weight: r.w }));
  // bridges: people whose ties reach beyond their own circle (own + every other circle they talk into)
  const cl = new Map(all("SELECT id, cluster FROM persons WHERE status='active'").map((r) => [`p:${r.id}`, r.cluster]));
  const reach = new Map<string, Set<number>>();
  for (const e of all("SELECT a, b FROM graph_edges WHERE rel IN ('talks','rel') AND a LIKE 'p:%' AND b LIKE 'p:%'")) {
    const ca = cl.get(e.a), cb = cl.get(e.b);
    if (ca == null || cb == null || ca === cb) continue;
    for (const [x, c] of [[e.a, cb], [e.b, ca]] as const) { const s = reach.get(x) ?? new Set(); s.add(c); reach.set(x, s); }
  }
  const bridges = [...reach].map(([id, s]) => [id, new Set([cl.get(id), ...s])] as const).sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([id, s]) => ({
    id: Number(id.slice(2)), name: nodeRow(id)?.label ?? id, circles: [...s].map((c) => names.get(c as number)?.label ?? "（自己一个）") }));
  // often together, relation unknown → a question for him, never a guess
  const pairs = all(`SELECT g.a, g.b, g.weight, g.evidence_json AS evidence, g.last_ts FROM graph_edges g WHERE g.rel='talks' AND g.a LIKE 'p:%' AND g.b LIKE 'p:%'
      AND NOT EXISTS (SELECT 1 FROM graph_edges r WHERE r.rel='rel' AND r.a=g.a AND r.b=g.b) ORDER BY g.weight DESC LIMIT 10`)
    .map((r) => ({ a: Number(r.a.slice(2)), b: Number(r.b.slice(2)), a_name: nodeRow(r.a)?.label, b_name: nodeRow(r.b)?.label, weight: r.weight, where: pj(r.evidence) ?? [], last_ts: r.last_ts }));
  const nameOnly = one(`SELECT COUNT(*) n FROM persons p WHERE status='active' AND slug IS NULL AND config_key IS NULL
      AND NOT EXISTS (SELECT 1 FROM person_aliases a WHERE a.person_id=p.id AND a.kind<>'name')`)!.n;
  const ambiguous = all(`SELECT a.alias name, COUNT(DISTINCT a.person_id) n FROM person_aliases a JOIN persons p ON p.id=a.person_id
      WHERE a.kind='name' AND p.status='active' GROUP BY a.alias HAVING n>1 ORDER BY n DESC LIMIT 20`);
  return { fresh, fading, bridges, pairs, name_only: nameOnly, ambiguous, built: Number(one("SELECT v FROM kv WHERE k='graph.built'")?.v ?? 0) };
}

// ───────── for the main agent (owner sessions only, tools.ts) ─────────

/** name → person id, or a sentence listing candidates (graphify: an ambiguous name is refused, never guessed) */
export function resolveForTool(name: string): number | string {
  const n = byName(name);
  if (typeof n === "number") return n;
  const c = candidates(name);
  if (n === "ambiguous" || c.length) return `「${name}」${n === "ambiguous" ? "有重名" : "没有完全对上"}，候选：${c.map((x) => `#${x.id} ${x.name}${x.circle ? `（${x.circle}）` : ""}`).join("、") || "（无）"}。用编号再问。`;
  return `不认识「${name}」。`;
}

export function personCard(id: number): string {
  const d = personDetail(id);
  const day = (ms: number | null) => ms ? localStamp(ms).slice(0, 10) : "?";
  const via = d.first_via ? `${day(d.first_seen)} ${d.first_via.kind === "matter" ? `因为事「${d.first_via.label}」` : d.first_via.kind === "page" ? "从页面" : `在「${d.first_via.label}」`}${d.first_via.with?.length ? `，同场有 ${d.first_via.with.join("、")}` : ""}` : "（不详）";
  const tag = (c: Conf) => (c === "INFERRED" ? "（推测）" : "");
  return [
    `#${d.id} ${d.name}${d.circle ? ` · ${d.circle}` : d.auto_circle ? ` · 圈子：${d.auto_circle}` : ""}${d.config ? ` · people.yaml：${d.config.relation ?? d.config.key}` : ""}${d.note ? ` · 备注：${d.note}` : ""}`,
    `初见：${via}；最近：${day(d.last_seen)}`,
    d.relations.length ? `关系：${d.relations.map((r) => `${r.dir === "out" ? `${r.other_name} 是 TA 的${r.rel}` : `TA 是 ${r.other_name} 的${r.rel}`}${tag(r.conf)}`).join("；")}` : "",
    d.people.length ? `身边的人：${d.people.slice(0, 10).map((e) => `${e.name}（${e.label}${e.rel === "rel" ? "" : ` ×${Math.round(e.weight)}`}${tag(e.conf)}）`).join("、")}` : "",
    d.matters.length ? `一起的事：${d.matters.slice(0, 8).map((e) => `${e.name}${tag(e.conf)}`).join("、")}` : "",
    d.places.length ? `常在：${d.places.slice(0, 5).map((e) => e.name).join("、")}` : "",
    d.slug ? `人物页：people/${d.slug}.md（memory_read 看）` : "",
  ].filter(Boolean).join("\n");
}
