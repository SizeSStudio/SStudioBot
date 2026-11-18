// §18 因缘 smoke on the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh graph-smoke.ts 7830
//
// No model. Scripted messages / events / pages → the registry (ids, names, people pages, event actors, ambiguous names),
// edges (talks, @, in, dm, matter by sender id vs by name, 关键人, page links and mentions, raw sources, relations),
// circles, first sight + who was there, merges / splits / hiding, relations from the console vs the agent, paths that
// never go through him, the owner-only tools, and people.yaml left byte-for-byte untouched.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P, ownerFeishu } from "../src/config.ts";
import { one, all, run } from "../src/db.ts";
import { ensureAgentHome } from "../src/memory.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const G = await import("../src/graph.ts");
const { openMatter } = await import("../src/matters.ts");
const { toolsFor, callTool } = await import("../src/tools.ts");
await import("../src/console.ts");   // the routes module loads

const peopleYaml = join(P.config, "people.yaml"), before = readFileSync(peopleYaml, "utf8");
const owner = ownerFeishu()!;
const now = Date.now(), MIN = 60_000, DAY = 86400_000;
let n = 0;
const msg = (chat: string, sid: string | null, name: string, ts: number, o: { surface?: string; chatName?: string; men?: string[] } = {}) =>
  run("INSERT INTO messages(id, surface, chat_id, sender_id, sender_kind, ts, text, raw_json, triage_status) VALUES(?,?,?,?,?,?,?,?,?)",
    `gm${++n}`, o.surface ?? "feishu:group", chat, sid, sid === owner ? "owner" : "other", ts, "…",
    JSON.stringify({ chat_name: o.chatName ?? "项目群", sender_name: name, mentions: o.men ?? [] }), "done") && `gm${n}`;

// 项目群: 小王 and 小李 talk back and forth, he joins; 小王 @ 小李
const t0 = now - 20 * DAY;
const m1 = msg("oc_proj", "ou_wang", "小王", t0);
const m2 = msg("oc_proj", "ou_li", "小李", t0 + MIN, { men: ["ou_wang"] });
msg("oc_proj", owner, "我", t0 + 2 * MIN);
for (let i = 0; i < 6; i++) { msg("oc_proj", "ou_wang", "小王", t0 + DAY + i * 4 * MIN); msg("oc_proj", "ou_li", "小李", t0 + DAY + i * 4 * MIN + MIN); }
// 家里群: 老婆 and 岳母; a private chat with 老婆; a far-apart message that must not count as talking
msg("oc_home", "ou_wife", "小张", t0 + 2 * DAY, { chatName: "家里" });
msg("oc_home", "ou_mom", "岳母", t0 + 2 * DAY + MIN, { chatName: "家里" });
msg("oc_wife_p2p", "ou_wife", "小张", t0 + 3 * DAY, { surface: "feishu:p2p", chatName: "小张" });
msg("oc_home", "ou_mom", "岳母", t0 + 5 * DAY, { chatName: "家里" });
msg("oc_proj", "ou_li", "小李", t0 + 6 * DAY);   // 小李 also bridges: talks with 小张 in a third group
msg("oc_mix", "ou_li", "小李", t0 + 7 * DAY, { chatName: "饭局" });
msg("oc_mix", "ou_wife", "小张", t0 + 7 * DAY + MIN, { chatName: "饭局" });
// a second 小王 (another person, same name) and a bot-ish sender to hide
msg("oc_other", "ou_wang2", "小王", t0 + 8 * DAY, { chatName: "隔壁群" });
msg("oc_proj", "ou_bot", "提醒小助手", t0 + 9 * DAY);
msg("oc_proj", "ou_wang", "小王", t0 + 9 * DAY + MIN);

// a matter with events: one by message ids (EXTRACTED), one imported by name only (INFERRED)
const { id: M, rel: mrel } = openMatter({ title: "新版上线", domain: "work", lane: "test" });
run("INSERT INTO events(ts, source, ref, place, place_id, actor, kind, level, summary, matter_id, state, msg_ids, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  t0 + MIN, "feishu", "e1", "项目群", "oc_proj", "小王、小李", "ask", "reply", "上线时间", M, "done", JSON.stringify([m1, m2]), now);
run("INSERT INTO events(ts, source, ref, place, place_id, actor, kind, level, summary, matter_id, state, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  t0 - 40 * DAY, "import", "i1", "邮件", null, "张三", "decision", "fyi", "去年定的方案", M, "done", now);
writeFileSync(join(P.agentHome, mrel), readFileSync(join(P.agentHome, mrel), "utf8").replace("## 关键人\n", "## 关键人\n- [11-01 10:00][src=owner] 张三（甲方，拍板的人）、小李\n"));
// people pages: 张三 (imported) links 小李's page and mentions 小张 by name; 小李 has a page; self/ must stay out
writeFileSync(join(P.agentHome, "people", "小李.md"), "# 小李\n\n- 同事，后端\n");
writeFileSync(join(P.agentHome, "people", "zhangsan.md"), "---\ntitle: 张三\n---\n# 张三\n\n- 甲方，介绍我认识了 [[people/小李]]\n- 小张 的老同学\n");
writeFileSync(join(P.agentHome, "topics", "上线复盘.md"), "# 上线复盘\n\n见 [新版上线](../matters/" + M + ".md)，[[people/zhangsan]] 拍的板\n");
mkdirSync(join(P.agentHome, "self"), { recursive: true });
writeFileSync(join(P.agentHome, "self", "secret.md"), "# 不该进图\n\n[[people/小李]] 小李\n");
// raw_sources arrives with ingest (§8.5, §11); create it as designed so this path runs
run(`CREATE TABLE IF NOT EXISTS raw_sources(sha256 TEXT PRIMARY KEY, s3_key TEXT, mime TEXT, bytes INTEGER, title TEXT, origin_url TEXT, src TEXT, visibility TEXT,
  received_at INTEGER, inbox_id INTEGER, ingested_at INTEGER, pages_json TEXT)`);
run("INSERT INTO raw_sources(sha256, s3_key, mime, bytes, title, src, visibility, received_at, pages_json) VALUES(?,?,?,?,?,?,?,?,?)",
  "abc123", "k", "text/plain", 1, "上线会议纪要", "owner", "owner", t0, JSON.stringify(["topics/上线复盘.md", "people/小李.md"]));
// people.yaml gives 老婆 an id: the registry must pick that up without writing the file
const yaml = before.trimEnd() + "\nwife:\n  ids: { feishu: ou_wife }\n  relation: 老婆\n  importance: high\n";
writeFileSync(peopleYaml, yaml);

const r1 = G.rebuildGraph();
ok(r1.nodes > 0 && r1.edges > 0, `graph built (${r1.nodes} nodes, ${r1.edges} edges, ${r1.ms} ms)`);
const pid = (kind: string, a: string) => G.byId(kind, a)!;
const wang = pid("feishu", "ou_wang"), li = pid("feishu", "ou_li"), wife = pid("feishu", "ou_wife"), mom = pid("feishu", "ou_mom"), wang2 = pid("feishu", "ou_wang2");
const zs = G.byName("张三") as number;
ok(wang && li && wife && mom && wang2 && typeof zs === "number", "registry: every sender and the imported person has a row");
ok(one("SELECT slug FROM persons WHERE id=?", li)?.slug === "小李", "people page matched to the sender by name (小李)");
ok(one("SELECT config_key FROM persons WHERE id=?", wife)?.config_key === "wife", "people.yaml entry matched by feishu id (read only)");
ok(G.byName("小王") === "ambiguous", "two senders named 小王 → the name is ambiguous, never guessed");
ok(!one("SELECT 1 FROM person_aliases WHERE alias=?", "我"), "owner's own name is not an alias");
const E = (a: string, b: string, rel: string) => one("SELECT * FROM graph_edges WHERE ((a=? AND b=?) OR (a=? AND b=?)) AND rel=?", a, b, b, a, rel);
const tw = E(`p:${wang}`, `p:${li}`, "talks");
ok(tw && tw.weight >= 12 && tw.conf === "EXTRACTED", `小王 ↔ 小李 talk (weight ${tw?.weight}, incl. the @)`);
ok(E("me", `p:${li}`, "talks"), "he talks right after 小李 → an edge to me");
ok(!E(`p:${wife}`, `p:${mom}`, "talks") || E(`p:${wife}`, `p:${mom}`, "talks").weight === 1, "a message days later is not talking (only the adjacent pair counts)");
ok(E("me", `p:${wife}`, "dm"), "private chat with 小张 → dm edge to me");
ok(E(`p:${wang}`, "c:oc_proj", "in")?.weight >= 8, "小王 is in 项目群");
const em = E(`p:${wang}`, `m:${M}`, "matter"), ez = E(`p:${zs}`, `m:${M}`, "matter");
ok(em?.conf === "EXTRACTED" && ez?.conf === "INFERRED", "matter tie: by message sender = EXTRACTED, imported by name = INFERRED");
ok(E(`p:${li}`, `m:${M}`, "key")?.conf === "INFERRED" && E(`p:${zs}`, `m:${M}`, "key"), "关键人 on the matter page → key ties (INFERRED)");
ok(E(`m:${M}`, "c:oc_proj", "at"), "the matter is discussed in 项目群");
ok(E(`p:${zs}`, `p:${li}`, "link")?.conf === "EXTRACTED", "wiki link from 张三's page to 小李's page");
ok(E("g:topics/上线复盘.md", `m:${M}`, "link") && E("g:topics/上线复盘.md", `p:${zs}`, "link"), "markdown + wiki links from a topic page to the matter and a person");
ok(E(`p:${zs}`, `p:${wife}`, "mentions")?.conf === "INFERRED", "a known person's name in a page → mentions (INFERRED)");
ok(E("r:abc123", "g:topics/上线复盘.md", "source") && E("r:abc123", `p:${li}`, "source"), "a raw source links the pages it fed");
ok(!one("SELECT 1 FROM graph_edges WHERE evidence LIKE '%self/%' OR a LIKE 'g:self/%' OR b LIKE 'g:self/%'"), "self/ never enters the graph");
const cw = one("SELECT cluster FROM persons WHERE id=?", wang)?.cluster, cl = one("SELECT cluster FROM persons WHERE id=?", li)?.cluster;
ok(cw != null && cw === cl, "小王 and 小李 land in the same circle");
const fw = JSON.parse(one("SELECT first_via FROM persons WHERE id=?", wang)!.first_via);
ok(one("SELECT first_seen FROM persons WHERE id=?", wang)!.first_seen === t0 && fw.label === "项目群" && fw.with.includes("小李") && fw.me, "first sight: 项目群, with 小李, he was there");
ok(one("SELECT first_seen FROM persons WHERE id=?", zs)!.first_seen === t0 - 40 * DAY, "张三 first seen at the imported event, before any message");

// views
const cv = G.circleView(50, true);
ok(cv.nodes.some((x) => x.id === "me") && cv.nodes.some((x) => x.id === `m:${M}`) && cv.circles.length >= 1, "circle view: me, people, shared matters, named circles");
ok(cv.circles.some((c) => c.label.includes("项目群")), `circles are named after their group (${cv.circles.map((c) => c.label).join(" / ")})`);
const ev = G.egoView(`p:${li}`, 2);
ok(ev.nodes.some((x) => x.focus && x.id === `p:${li}`) && ev.nodes.some((x) => x.id === `p:${wang}`), "ego view around 小李");
const path = G.pathBetween(`p:${zs}`, `p:${wang}`);
ok(path && path.hops.every((h) => h.from !== "me" && h.to !== "me") && path.hops.length >= 2, `path 张三 → 小王 never through me (${path?.hops.map((h) => h.edge.rel).join(" → ")}, ${path?.conf})`);
const pl = G.peopleList();
ok(pl.find((p) => p.id === wife)?.config?.relation === "老婆" && pl.find((p) => p.id === zs)?.name_only === false, "people list: people.yaml relation shown; 张三 has a page so is not name-only");
const pd = G.personDetail(li);
ok(pd.people.some((e) => e.id === `p:${wang}`) && pd.matters.length && pd.places.length && pd.pages.length && pd.monthly.length, "person detail: people, matters, places, pages, monthly");
const obs = G.observations();
ok(obs.fresh.some((p) => p.id === wang) && obs.pairs.some((x) => [x.a, x.b].includes(wang) && [x.a, x.b].includes(li)), "observations: new ties, often-together pairs");
ok(obs.ambiguous.some((a) => a.name === "小王"), "observations: the duplicate name is listed to sort out");

// his corrections
const bot = pid("feishu", "ou_bot");
G.setPerson(bot, { hidden: true });
G.rebuildGraph();
ok(!one("SELECT 1 FROM graph_edges WHERE a=? OR b=?", `p:${bot}`, `p:${bot}`), "a hidden person leaves the graph");
G.setPerson(wang2, { name: "隔壁小王" });
ok(G.byName("隔壁小王") === wang2 && G.byName("小王") === "ambiguous", "renaming adds a name; the shared one stays ambiguous");
const extra = Number(run("INSERT INTO persons(name, status, created_at) VALUES('王小二','active',?)", now).lastInsertRowid);
run("INSERT INTO person_aliases(kind, alias, person_id, src, ts) VALUES('name','王小二',?, 'event', ?)", extra, now);
G.mergePersons(extra, wang);
ok(G.byName("王小二") === wang && one("SELECT merged_into FROM persons WHERE id=?", extra)?.merged_into === wang, "merge: the alias moves, the old row points at the new one");
const sp = G.splitAlias(wang, "name", "王小二");
ok(G.byName("王小二") === sp.id && sp.id !== wang, "split: the alias becomes its own person again");
let threw = ""; try { G.mergePersons(wife, Number(run("INSERT INTO persons(name, config_key, status, created_at) VALUES('x','other_key','active',?)", now).lastInsertRowid)); } catch (e: any) { threw = e.message; }
ok(/people\.yaml/.test(threw), "two people.yaml entries cannot be merged here");

// relations: the console click is EXTRACTED, the agent's is INFERRED until confirmed
const ctx = { runId: "r_g", lane: "test", principal: "owner", turn: { channel: "feishu", chat_id: "oc_dm", surface: "feishu:dm" }, src: "owner@test", token: "", replies: 0 } as any;
const tool = (name: string) => toolsFor("owner").find((t) => t.name === name)!;
ok(["person_lookup", "person_path", "person_relate"].every((x) => tool(x)) && !toolsFor("known").some((t) => t.name.startsWith("person_")) && !toolsFor("other").some((t) => t.name.startsWith("person_")), "person tools are owner-only");
const out = await callTool(tool("person_relate"), { a: "小李", b: "张三", rel: "介绍人", evidence: "他说的" }, ctx);
const rr = one("SELECT * FROM relations WHERE rel='介绍人'");
ok(out.includes("推测") && rr?.conf === "INFERRED" && rr.src === "owner@test", "person_relate records an INFERRED relation with the run's source");
ok((await callTool(tool("person_relate"), { a: "小王", b: "小李", rel: "同事", evidence: "群里说的" }, ctx)).includes("有重名"), "an ambiguous name is refused with candidates");
G.setRelation(rr!.id, "confirm");
ok(one("SELECT conf FROM relations WHERE id=?", rr!.id)?.conf === "EXTRACTED", "confirming makes it EXTRACTED");
G.addRelation(wife, mom, "妈妈", { conf: "EXTRACTED", src: "owner@console" });
G.rebuildGraph();
ok(E(`p:${wife}`, `p:${mom}`, "rel")?.evidence.includes("妈妈"), "relation shows as a rel edge");
const card = await callTool(tool("person_lookup"), { who: "小李" }, ctx);
ok(card.includes("小李") && card.includes("初见") && card.includes("张三 是 TA 的介绍人") && card.includes("新版上线"), "person_lookup card: first sight, relation, matters");
ok((await callTool(tool("person_lookup"), { who: `#${wife}` }, ctx)).includes("people.yaml：老婆"), "lookup by #id shows the people.yaml relation");
ok((await callTool(tool("person_path"), { a: "张三", b: "岳母" }, ctx)).includes("→"), "person_path explains the chain");
ok(readFileSync(peopleYaml, "utf8") === yaml, "people.yaml was never written");
writeFileSync(peopleYaml, before);
console.log(process.exitCode ? "SOME FAILED" : "ALL PASSED");
