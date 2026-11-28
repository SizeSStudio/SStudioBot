// The whole path with the real pi: inbox → dispatcher → pi → proxy → fake upstream → tools → outbox → client.
// Covers a tool round, the P10 model switch landing after the tool results, steering into a streaming run, and /stop
// aborting a run whose upstream hangs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { until, w1dHome } from "./w1d-helpers.ts";
import { fakeLlm, fakeModelsYaml, type Step } from "./fake-llm.ts";
import { boot } from "../src/main.ts";
import { ingest, type Ingest } from "../src/inbox.ts";
import type { Db } from "../src/db/db.ts";

let seq = 0;
const mine = (text: string, extra: Partial<Ingest> = {}): Ingest =>
  ({ lane: "client:main", kind: "user", source: "client", source_msg_id: `rc${++seq}`, payload: { text }, turn: { channel: "client", surface: "client" }, device_id: "cli", ...extra });
const sent = (db: Db) => db.all<{ payload: string }>("SELECT payload FROM outbox WHERE kind = 'text' AND status = 'sent' ORDER BY id").map((r) => r.payload);
const userTexts = (body: any): string => JSON.stringify(body.messages?.filter((m: { role: string }) => m.role === "user") ?? []);

test("a tool round, then the model switch lands on the next request (after the tool results)", async () => {
  let home = "";
  const llm = await fakeLlm((_b, n) => {
    if (n === 0) {
      // I change the chat tier's model while the run is between requests
      writeFileSync(join(home, "models.yaml"), fakeModelsYaml(llm.port).replace("model: claude-fake-chat,", "model: claude-fake-chat2,"));
      return { tool: { name: "memory_read", input: { path: "MEMORY.md" } } };
    }
    return { text: "读完了，一切正常。" };
  });
  const h = await w1dHome("runner1", { port: llm.port });
  home = h.config;
  const hub = await boot(h, { proxyPort: 0 });
  try {
    ingest(hub.db, mine("看看记忆"));
    await until(() => sent(hub.db).length === 1, 20_000, "reply");
    assert.deepEqual(sent(hub.db), ["读完了，一切正常。"]);
    assert.deepEqual(llm.seen.map((s) => s.body.model), ["claude-fake-chat", "claude-fake-chat2"]);
    // the second request carries the tool result, so the switch came after it
    assert.match(JSON.stringify(llm.seen[1]!.body.messages), /tool_result/);
    const run = hub.db.one<{ status: string; side_effects: number; session_ref: string }>("SELECT * FROM runs")!;
    assert.equal(run.status, "done");
    assert.equal(run.side_effects, 1, "the reply");
    assert.ok(readFileSync(run.session_ref, "utf8").includes("看看记忆"), "the pi session file has the turn");
    assert.equal(hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM run_tokens WHERE status = 'active'")!.n, 0, "token revoked at the end");
    assert.equal(hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM usage WHERE source = 'proxy'")!.n, 2);
    const items = hub.db.all<{ kind: string; name: string | null }>("SELECT kind, name FROM run_items ORDER BY id");
    assert.deepEqual(items.map((i) => i.kind + (i.name ? `:${i.name}` : "")), ["tool:memory_read", "assistant"]);
    assert.equal(hub.db.one<{ t: string }>("SELECT text AS t FROM messages WHERE sender_kind = 'bot'")!.t, "读完了，一切正常。");
    // the next run in the lane continues the same session
    ingest(hub.db, mine("还在吗"));
    await until(() => sent(hub.db).length === 2, 20_000, "second reply");
    assert.match(JSON.stringify(llm.seen[2]!.body.messages), /看看记忆/);
  } finally { await hub.close(); await llm.close(); }
});

test("steering: what I type while the model streams reaches the same run", async () => {
  let release!: (s: Step) => void;
  const first = new Promise<Step>((r) => { release = r; });
  const llm = await fakeLlm((b, n) => (n === 0 ? { later: first } : { text: userTexts(b).includes("顺便") ? "收到补充" : "没看到" }));
  const h = await w1dHome("runner2", { port: llm.port });
  const hub = await boot(h, { proxyPort: 0 });
  try {
    ingest(hub.db, mine("写个计划"));
    await until(() => llm.seen.length === 1, 20_000, "first request");
    const extra = ingest(hub.db, mine("顺便加上周末"));
    await until(() => hub.db.one<{ s: string }>("SELECT status AS s FROM inbox WHERE id = ?", extra.id)!.s === "processing", 10_000, "steered");
    release({ text: "计划如下" });
    await until(() => hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status != 'running'")!.n === 1, 20_000, "run end");
    await until(() => sent(hub.db).length >= 1, 10_000, "reply");
    assert.equal(hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM runs")!.n, 1, "one run took both");
    assert.deepEqual(sent(hub.db), ["收到补充"]);
    assert.equal(hub.db.one<{ s: string }>("SELECT status AS s FROM inbox WHERE id = ?", extra.id)!.s, "done");
  } finally { await hub.close(); await llm.close(); }
});

test("/stop aborts a run whose upstream hangs", async () => {
  const llm = await fakeLlm(() => ({ hang: true }));
  const h = await w1dHome("runner3", { port: llm.port });
  const hub = await boot(h, { proxyPort: 0 });
  try {
    ingest(hub.db, mine("慢慢想"));
    await until(() => llm.seen.length === 1, 20_000, "request");
    ingest(hub.db, mine("/stop", { kind: "command" }));
    await until(() => sent(hub.db).includes("（已停下）"), 20_000, "stopped");
    const run = hub.db.one<{ status: string }>("SELECT status FROM runs")!;
    assert.equal(run.status, "aborted");
    assert.equal(hub.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM run_tokens WHERE status = 'active'")!.n, 0);
  } finally { await hub.close(); await llm.close(); }
});

test("a tool call that leans on a schema default reaches callTool (send without `as` → an approval)", async () => {
  const llm = await fakeLlm((b, n) => (n === 0 ? { tool: { name: "send", input: { channel: "feishu", to: "oc_fakechat01", text: "周五见" } } } : { text: "已经提交审批了" }));
  const h = await w1dHome("runner4", { port: llm.port });
  const hub = await boot(h, { proxyPort: 0 });
  try {
    ingest(hub.db, mine("跟他说周五见"));
    await until(() => sent(hub.db).length === 1, 20_000, "reply");
    const a = hub.db.one<{ kind: string; status: string; as_identity: string; draft: string }>("SELECT * FROM approvals")!;
    assert.deepEqual([a.kind, a.status, a.as_identity, a.draft], ["send", "pending", "bot", "周五见"]);
    assert.match(JSON.stringify(llm.seen[1]!.body.messages), /已提交审批 #/);
  } finally { await hub.close(); await llm.close(); }
});

test("pi offers the model exactly this round's tools, ours, none of pi's own; others' replies pass the light check", async () => {
  const { toolsFor } = await import("../src/tools/registry.ts");
  const { DEFAULTS } = await import("../src/config/schemas.ts");
  const isCheck = (b: any) => typeof b.system === "string" && b.system.startsWith("检查一条草稿");
  const llm = await fakeLlm((b) => isCheck(b)
    ? { text: '{"promise":true,"stance":false,"private":false,"hits":["周五三点到"]}' }
    : { text: userTexts(b).includes("周五") ? "好的，周五下午三点我一定到。" : "在。" });
  const h = await w1dHome("runner-tools", { port: llm.port });
  const hub = await boot(h, { proxyPort: 0 });
  try {
    ingest(hub.db, mine("你在吗"));
    await until(() => sent(hub.db).includes("在。"), 20_000, "typed reply");
    const names = (b: any) => (b.tools ?? []).map((t: { name: string }) => t.name).sort();
    const typed = llm.seen[0]!.body;
    assert.deepEqual(names(typed), toolsFor("typed").map((t) => t.name).sort());
    for (const builtin of ["read", "edit", "write"]) assert.ok(!names(typed).includes(builtin), builtin);
    assert.match(typed.tools.find((t: { name: string }) => t.name === "bash").description, /本机节点/, "bash is ours, not pi's");

    // someone else, on the built-in client channel (no device id, no owner stamp → others)
    ingest(hub.db, { lane: "client:other", kind: "user", source: "fake", source_msg_id: "ro1", payload: { text: "周五能来吗", sender_name: "阿乙" }, turn: { channel: "client", surface: "fake:dm", chat: "oc_fakeother1" } });
    await until(() => !!hub.db.one("SELECT 1 FROM approvals WHERE kind = 'send'"), 20_000, "held for approval");
    const main = llm.seen.find((s) => !isCheck(s.body) && userTexts(s.body).includes("周五"))!.body;
    assert.deepEqual(names(main), toolsFor("others").map((t) => t.name).sort());
    const check = llm.seen.find((s) => isCheck(s.body))!.body;
    assert.equal(check.model, "claude-fake-light");
    await until(() => sent(hub.db).includes(DEFAULTS.gate.hold_text), 10_000, "holding line");
    assert.ok(!sent(hub.db).includes("好的，周五下午三点我一定到。"), "the draft waits for me");
  } finally { await hub.close(); await llm.close(); }
});
