// Tools (03 tools): the three columns, callTool's order, the self/ guard per source, commandGuard, redaction, the
// source labels. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { w1dHome } from "./w1d-helpers.ts";
import { openDb, type Db, type Row } from "../src/db/db.ts";
import type { Home } from "../src/home.ts";
import { registerBuiltinTools } from "../src/tools/builtin.ts";
import { callTool, toolNamed, toolsFor, type ToolCtx } from "../src/tools/registry.ts";
import { commandGuard, selfGuard } from "../src/tools/guard.ts";
import { redact, StreamRedactor } from "../src/tools/redact.ts";
import { colOf, ownerTyped, sourceLabel, type Col } from "../src/turn.ts";

registerBuiltinTools();

async function setup() {
  const h = await w1dHome("tools");
  const db = openDb(h.db);
  mkdirSync(join(h.agentHome, "self"), { recursive: true });
  mkdirSync(join(h.agentHome, "journal"), { recursive: true });
  writeFileSync(join(h.agentHome, "self", "rhythm.md"), "虚构：早起，晚上不看屏幕。\n");
  writeFileSync(join(h.agentHome, "journal", "2026-11-01.md"), "虚构的一天。\n".repeat(3));
  return { h, db };
}

let n = 0;
function ctxFor(db: Db, h: Home, src: string): ToolCtx {
  const run_id = `r_test_${++n}`;
  db.run("INSERT INTO runs(id, lane, session_key, role, tier, status, started) VALUES (?, 'client:main', 'client:main', 'main', 'chat', 'running', ?)", run_id, Date.now());
  return { db, h, run_id, lane: "client:main", src, col: colOf(src), turn: { channel: "client", surface: "client", src }, replies: 0 };
}
const sideEffects = (db: Db, run_id: string) => db.one<{ n: number }>("SELECT side_effects AS n FROM runs WHERE id = ?", run_id)!.n;

test("source labels follow ownerTyped (owner@ / job@ / system@ / other@)", () => {
  const row = (o: Partial<Row>): Row => ({ kind: "user", source: "feishu", payload_json: "{}", turn_ctx_json: null, device_id: null, ...o });
  const dev = row({ source: "client", device_id: "dev_fake1", turn_ctx_json: JSON.stringify({ channel: "client", surface: "client" }) });
  const mine = row({ payload_json: JSON.stringify({ owner: true, text: "x" }), turn_ctx_json: JSON.stringify({ channel: "feishu", surface: "feishu:dm" }) });
  const theirs = row({ payload_json: JSON.stringify({ text: "x" }), turn_ctx_json: JSON.stringify({ channel: "feishu", surface: "feishu:chat" }) });
  const timer = row({ kind: "timer", source: "timer", payload_json: JSON.stringify({ job: "morning" }) });
  assert.ok(ownerTyped(dev) && ownerTyped(mine) && !ownerTyped(theirs) && !ownerTyped(timer));
  // a timer row claiming owner is still not typed: only user/command rows can be
  assert.ok(!ownerTyped(row({ kind: "timer", payload_json: JSON.stringify({ owner: true }) })));
  assert.equal(sourceLabel([dev]), "owner@client");
  assert.equal(sourceLabel([dev, mine]), "owner@feishu:dm");
  assert.equal(sourceLabel([timer]), "job@morning");
  assert.equal(sourceLabel([row({ kind: "approval", source: "approval" })]), "system@approval");
  assert.equal(sourceLabel([row({ kind: "card", source: "card" })]), "system@approval");
  assert.equal(sourceLabel([row({ kind: "task", source: "task" })]), "system@task");
  assert.equal(sourceLabel([row({ kind: "system", source: "system" })]), "system@system");
  // one row that isn't mine decides the whole batch
  assert.equal(sourceLabel([mine, theirs]), "other@feishu:chat");
  assert.equal(sourceLabel([dev, timer]), "job@morning");
  assert.deepEqual(["owner@client", "job@x", "system@task", "other@feishu:chat"].map(colOf), ["typed", "system", "system", "others"]);
});

test("columns: what each source sees", () => {
  const names = (c: Col) => toolsFor(c).map((t) => t.name).sort();
  assert.deepEqual(names("typed"), ["bash", "memory_read", "read_file", "reply", "send", "write_file"]);
  assert.deepEqual(names("system"), ["memory_read", "reply", "send"]);
  assert.deepEqual(names("others"), ["memory_read", "reply"]);
});

test("self/ whole: typed reads it; timer, approval, task and system runs are refused; others never", async () => {
  const { h, db } = await setup();
  const read = toolNamed("memory_read")!;
  const typed = await callTool(read, { path: "self/rhythm.md" }, ctxFor(db, h, "owner@client"));
  assert.match(typed, /早起/);
  for (const src of ["job@morning", "system@approval", "system@task", "system@system"]) {
    const ctx = ctxFor(db, h, src);
    const out = await callTool(read, { path: "self/rhythm.md" }, ctx);
    assert.match(out, /^error: .*self_list/, src);
    // the absolute path and a ../ detour are the same file
    assert.match(await callTool(read, { path: join(h.agentHome, "self/rhythm.md") }, ctx), /^error: /, `${src} abs`);
    assert.match(await callTool(read, { path: "journal/../self/rhythm.md" }, ctx), /^error: .*self_list/, `${src} ../`);
    // other pages are fine
    assert.match(await callTool(read, { path: "journal/2026-11-01.md" }, ctx), /虚构的一天/);
  }
  const other = await callTool(read, { path: "self/rhythm.md" }, ctxFor(db, h, "other@feishu:chat"));
  assert.match(other, /^error: 这里不是我的对话/);
  for (const p of ["body/x.md", "timeline.md", "people/timeline/a.md", "birth.txt"]) assert.ok(selfGuard(p, "system"), p);
  assert.equal(selfGuard("journal/self-notes.md", "system"), undefined);
  // every refusal is a run item, so the journal shows it
  assert.ok(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM run_items WHERE status = 'error' AND name = 'memory_read'")!.n >= 9);
  db.close();
});

test("callTool order: column, then schema, then guards, then gate; readOnly never counts", async () => {
  const { h, db } = await setup();
  // column first: bash in a timer run is refused before its args are even looked at
  const sys = ctxFor(db, h, "job@morning");
  assert.match(await callTool(toolNamed("bash")!, { nope: 1 }, sys), /^error: bash 在这一轮不可用/);
  const me = ctxFor(db, h, "owner@client");
  assert.match(await callTool(toolNamed("bash")!, { cmd: 3 }, me), /^error: 参数不对/);
  assert.match(await callTool(toolNamed("bash")!, { cmd: `cat ${h.root}/secrets.env` }, me), /^error: /);
  assert.match(await callTool(toolNamed("bash")!, { cmd: "cat /proc/1/environ" }, me), /^error: /);
  assert.equal(sideEffects(db, me.run_id), 0, "refusals change nothing");
  // no node connected: the write tool fails, but it was counted before exec (a crash mid-exec still counts)
  assert.match(await callTool(toolNamed("write_file")!, { path: "/tmp/sbot-test-x", text: "x" }, me), /^error: 本机节点没连上/);
  assert.equal(sideEffects(db, me.run_id), 1);
  await callTool(toolNamed("memory_read")!, { path: "journal/2026-11-01.md" }, me);
  assert.equal(sideEffects(db, me.run_id), 1, "readOnly does not count");
  db.close();
});

test("L2 send files an approval and returns at once; it counts as a side effect", async () => {
  const { h, db } = await setup();
  const ctx = ctxFor(db, h, "owner@client");
  const out = await callTool(toolNamed("send")!, { channel: "feishu", to: "oc_fakechat01", text: "周五见" }, ctx);
  const m = /^已提交审批 #(\d+)/.exec(out);
  assert.ok(m, out);
  const a = db.one<{ kind: string; status: string; draft: string; run_id: string; channel: string }>("SELECT kind, status, draft, run_id, channel FROM approvals WHERE id = ?", Number(m![1]))!;
  assert.deepEqual([a.kind, a.status, a.draft, a.run_id, a.channel], ["send", "pending", "周五见", ctx.run_id, "feishu"]);
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'text'")!.n, 0, "nothing goes out before I decide");
  assert.equal(sideEffects(db, ctx.run_id), 1);
  // others can't send at all
  assert.match(await callTool(toolNamed("send")!, { channel: "feishu", to: "oc_x", text: "x" }, ctxFor(db, h, "other@feishu:chat")), /^error: send 在这一轮不可用/);
  db.close();
});

test("commandGuard: where, not what", () => {
  const env = { sbotHome: "/home/fake/sbot" };
  for (const c of ["cat $SBOT_HOME/db/sbot.db", "echo $SBOT_SECRETS", "cat secrets.env", "ls /run/sbot", "cat /proc/self/environ",
    "cat /home/fake/sbot/config/models.yaml", "ls /home/fake/sbot/keys"]) assert.ok(commandGuard(c, env), c);
  for (const c of ["ls -la", "git status", "echo secrets are fine to talk about"]) assert.equal(commandGuard(c, env), undefined, c);
});

test("redaction: known values, patterns, and a stream that splits a secret", async () => {
  await w1dHome("redact");
  assert.equal(redact("key=fake-upstream-key-not-real-0001."), "key=[已打码].");
  // fake shapes, built from parts so leak-guard doesn't take the test for a real key
  assert.match(redact(`token ${"sk-" + "ant-"}abcdefghijklmnopqrstuvwx`), /\[已打码\]/);
  const pem = (w: string) => `-----${w} ${"PRIVATE"} KEY-----`;
  assert.match(redact(`${pem("BEGIN")}\nAAAA\n${pem("END")}`), /^\[已打码\]$/);
  assert.equal(redact("nothing here"), "nothing here");
  const got: string[] = [];
  const s = new StreamRedactor((t) => got.push(t), 1_000_000);
  s.push("前面 fake-upstream-");
  s.push("key-not-real-0001 后面\n");
  s.flush();
  assert.ok(!got.join("").includes("fake-upstream-key"), got.join(""));
  assert.match(got.join(""), /前面 \[已打码\] 后面/);
});

test("stream redaction: Chinese goes out as it comes; a key between Chinese characters or a key block cut anywhere stays masked", async () => {
  await w1dHome("redact-cjk");
  const tick = () => new Promise((r) => setTimeout(r, 15));
  const feed = async (parts: string[]) => {
    const got: string[] = [];
    const s = new StreamRedactor((t) => got.push(t), 5, 4096);
    for (const p of parts) { s.push(p); await tick(); }
    s.flush();
    return got;
  };
  // no spaces at all: still several pieces before the end of the message (before: one piece, at flush)
  const zh = await feed(["好的，", "我先", "看一下", "样稿的", "第二版。"]);
  assert.ok(zh.length >= 4, `pieces: ${JSON.stringify(zh)}`);
  assert.equal(zh.join(""), "好的，我先看一下样稿的第二版。");
  // a known value split right after a Chinese character
  const k = await feed(["密钥是fake-upstream-", "key-not-real-0001，", "别外传"]);
  assert.ok(!k.join("").includes("fake-upstream"), k.join(""));
  assert.match(k.join(""), /密钥是\[已打码\]，别外传/);
  // a private key block arriving line by line, its markers split at the spaces: nothing of the body ever goes out
  const pem = (w: string) => `-----${w} ${"PRIVATE"} KEY-----`;
  const body = "QUJDREVGR0hJSktMTU5PUA";
  const p = await feed(["看这个：\n", pem("BEGIN").slice(0, 11), pem("BEGIN").slice(11) + "\n", body + "\n", body + "\n", pem("END").slice(0, 9), pem("END").slice(9), "\n完了"]);
  assert.ok(!p.join("").includes(body), p.join(""));
  assert.match(p.join(""), /^看这个：\n\[已打码\]\n完了$/);
  // longer than `hold`: it goes out masked, what follows is dropped up to END
  const got: string[] = [];
  const s = new StreamRedactor((t) => got.push(t), 5, 64);
  for (const x of [pem("BEGIN") + "\n", `${body}\n`.repeat(6), `${body}\n`.repeat(6), pem("END"), "\n之后"]) { s.push(x); await tick(); }
  s.flush();
  assert.ok(!got.join("").includes(body), got.join(""));
  assert.match(got.join(""), /\[已打码\][\s\S]*之后$/);
});

test("run_items: tool args and results are cut to 2 KB and marked", async () => {
  const { h, db } = await setup();
  writeFileSync(join(h.agentHome, "journal", "long.md"), "长".repeat(5000));
  const ctx = ctxFor(db, h, "owner@client");
  const out = await callTool(toolNamed("memory_read")!, { path: "journal/long.md" }, ctx);
  assert.equal(out.length, 5000, "the model gets it all");
  const it = db.one<{ truncated: number; body_json: string }>("SELECT truncated, body_json FROM run_items WHERE run_id = ?", ctx.run_id)!;
  assert.equal(it.truncated, 1);
  assert.ok(Buffer.byteLength(it.body_json) < 2600);
  db.close();
});

test("node paths are made absolute on the hub before the guard: a relative path into $SBOT_HOME/keys is refused", async () => {
  const { h, db } = await setup();
  const { basename, dirname, join: j } = await import("node:path");
  const asked: string[] = [];
  const node = {
    connected: () => true,
    // the worst default for the guard: the directory that holds $SBOT_HOME
    defaultCwd: () => dirname(h.root),
    async exec(o: { cmd: string; cwd: string }) { asked.push(`exec ${o.cwd}`); return { code: 0, signal: null, stdout: "", stderr: "" }; },
    async readFile(p: string) { asked.push(`read ${p}`); return { data: Buffer.from("x"), total: 1 }; },
    async writeFile(p: string) { asked.push(`write ${p}`); },
  };
  const ctx = { ...ctxFor(db, h, "owner@client"), node };
  const home = basename(h.root);
  for (const [tool, args] of [["read_file", { path: `${home}/keys/hub.key` }], ["write_file", { path: `./${home}/config/x.yaml`, text: "a" }], ["bash", { cmd: "ls", cwd: `${home}/keys` }]] as const) {
    assert.match(await callTool(toolNamed(tool)!, args, ctx), /^error: 拒绝/, tool);
  }
  assert.deepEqual(asked, [], "nothing reached the node");
  // allowed paths reach the node absolute, resolved against its default directory
  await callTool(toolNamed("read_file")!, { path: "notes/a.txt" }, ctx);
  await callTool(toolNamed("bash")!, { cmd: "ls" }, ctx);
  assert.deepEqual(asked, [`read ${j(dirname(h.root), "notes", "a.txt")}`, `exec ${dirname(h.root)}`]);
  // no node, no default directory: a relative path can't be placed, so it's refused, not guessed
  const offline = { ...ctxFor(db, h, "owner@client") };
  assert.match(await callTool(toolNamed("read_file")!, { path: "notes/a.txt" }, offline), /^error: .*相对路径定不了位/);
});
