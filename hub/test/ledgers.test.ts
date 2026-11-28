// W1e ledgers and memory: paused matters (§寸5), matter ops undo, events, wiki search completeness, page reads, the
// journal line and the raw store. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ambientHome } from "./helpers.ts";
import { all, one, run } from "../src/db/ambient.ts";
import { NAGGING, OPEN_MATTER, RESURFACED, openMatter, listMatters } from "../src/ledgers/matters.ts";
import { closeMatter, pauseMatter, resumeMatter, undoOp, attachMatters } from "../src/ledgers/matter-ops.ts";
import { recordEvent } from "../src/ledgers/events.ts";
import { searchWiki } from "../src/memory/wiki.ts";
import { journalLine, putRaw, readPage, readRaw, safePath } from "../src/memory/pages.ts";

const by = { by: "owner" };
const ids = (where: string) => all(`SELECT id FROM matters WHERE ${where} ORDER BY id`).map((r) => Number(r.id));

test("paused: still open, stops nagging, resurfaces on new activity, undo puts it back", async () => {
  await ambientHome("paused");
  const a = openMatter({ title: "换供应商", domain: "work", lane: "l" }).id;
  const kid = openMatter({ title: "比价", domain: "work", lane: "l" }).id;
  attachMatters([kid], a, by);
  const op = pauseMatter(a, { ...by, why: "等下季度预算" });
  assert.deepEqual(ids(`status='paused'`), [a, kid], "the 主线 and its 子事 pause together");
  assert.deepEqual(ids(OPEN_MATTER), [a, kid], "paused is still open");
  assert.deepEqual(ids(NAGGING), [], "paused doesn't nag");
  assert.deepEqual(ids(RESURFACED), [], "pausing alone is not news");
  assert.ok(listMatters().includes("paused"));
  assert.throws(() => pauseMatter(a, by), /已经搁着/);

  // something lands on the 子事: the trigger bumps it and its 主线
  run("UPDATE matters SET paused_at=paused_at-1000 WHERE id IN (?,?)", a, kid);   // the pause was a moment ago
  recordEvent({ source: "test", ref: "e1", ts: Date.now(), kind: "progress", level: "fyi", summary: "报价来了", matter_id: kid });
  assert.deepEqual(ids(RESURFACED), [a, kid]);

  undoOp(op, "owner");
  assert.deepEqual(ids(NAGGING), [a, kid], "undo restores the old status");
  assert.equal(one("SELECT paused_at FROM matters WHERE id=?", a)!.paused_at, null);
});

test("resume and close: my status change counts as activity; close accepts paused", async () => {
  await ambientHome("resume");
  const a = openMatter({ title: "装修", domain: "personal", lane: "l" }).id;
  pauseMatter(a, by);
  const before = Number(one("SELECT last_activity_at t FROM matters WHERE id=?", a)!.t);
  const r = resumeMatter(a, by);
  const m = one("SELECT status, paused_at, last_activity_at FROM matters WHERE id=?", a)!;
  assert.equal(m.status, "active");
  assert.equal(m.paused_at, null);
  assert.ok(Number(m.last_activity_at) >= before);
  assert.throws(() => resumeMatter(a, by), /没有搁着/);
  undoOp(r, "owner");
  assert.equal(one("SELECT status FROM matters WHERE id=?", a)!.status, "paused");
  closeMatter(a, "done", by);
  assert.equal(one("SELECT status FROM matters WHERE id=?", a)!.status, "done");
});

test("wiki search says how complete it is and pages with offset", async () => {
  const { h } = await ambientHome("wiki");
  mkdirSync(join(h.agentHome, "topics"), { recursive: true });
  for (let i = 0; i < 15; i++) writeFileSync(join(h.agentHome, "topics", `t${String(i).padStart(2, "0")}.md`), `# 话题 ${i}\n\n关于蓝鲸项目的第 ${i} 条笔记\n`);
  const first = searchWiki("蓝鲸项目", "owner");
  assert.match(first.split("\n")[0]!, /^共 15 页命中，显示 12 页（第 1–12 页），每页前 4 行；还有 3 页，用 offset=12 看下一批$/);
  const next = searchWiki("蓝鲸项目", "owner", { offset: 12 });
  assert.match(next.split("\n")[0]!, /显示 3 页（第 13–15 页）.*没有更多了/);
  assert.equal(searchWiki("没有这个词", "owner"), "共 0 页命中。");
});

test("page reads report how far they got; paths can't escape or reach self/ for others", async () => {
  const { h } = await ambientHome("pages");
  writeFileSync(join(h.agentHome, "long.md"), "字".repeat(30));
  assert.equal(readPage("long.md", "owner", { max: 10 }), `${"字".repeat(10)}\n…（读到 10 / 共 30 字；接着读用 offset=10）`);
  assert.equal(readPage("long.md", "owner", { offset: 20, max: 10 }), `${"字".repeat(10)}\n…（读到 30 / 共 30 字）`);
  assert.equal(readPage("long.md", "owner"), "字".repeat(30));
  assert.match(readPage("nope.md", "owner"), /没有这一页/);
  assert.throws(() => safePath("../x.md", "owner"), /bad path/);
  assert.throws(() => safePath("self/a.md", "other"), /not allowed/);
  assert.throws(() => safePath("notes.md", "other"), /not allowed/);
  assert.throws(() => safePath(".git/config.md", "owner"), /not allowed/);
  assert.ok(safePath("shared/a.md", "other").endsWith(join("shared", "a.md")));
});

test("journal lines carry run and source tags; raw store is content-addressed and add-only", async () => {
  await ambientHome("raw");
  const j = journalLine("见了一位\n客户", { run: "r_1", src: "owner@feishu:dm", ms: Date.UTC(2026, 0, 2, 1, 5) });
  assert.equal(j.rel, "journal/2026-01-02.md");
  assert.equal(j.line, "- [09:05][run=r_1][src=owner@feishu:dm] 见了一位 / 客户\n");
  const ref = putRaw(Buffer.from("原始资料"), { src: "test", title: "a" });
  assert.match(ref, /^raw:[0-9a-f]{64}$/);
  assert.equal(putRaw(Buffer.from("原始资料"), { src: "other", title: "b" }), ref);
  assert.equal(readRaw(ref)!.toString(), "原始资料");
  assert.equal(one("SELECT src FROM raw_sources")!.src, "test", "first writer wins");
  assert.equal(readRaw("raw:" + "0".repeat(64)), undefined);
  assert.ok(!existsSync(join(process.env.SBOT_HOME!, "raw", "sha256", "00")));
});
