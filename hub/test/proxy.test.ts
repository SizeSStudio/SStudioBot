// LLM proxy (R7; 03 proxy): bad/revoked token 401, wrong tier 403, over a budget line it alerts once and never refuses;
// metering, request capture, the key swap, and reshaping on a model change. The upstream is a local fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { w1dHome } from "./w1d-helpers.ts";
import { fakeLlm, fakeModelsYaml, FAKE_KEY } from "./fake-llm.ts";
import { openDb, type Db } from "../src/db/db.ts";
import { issueToken, revokeRun, shapeForModel, startProxy } from "../src/proxy.ts";
import { setAdminSink } from "../src/notify.ts";

async function setup(models = (port: number) => fakeModelsYaml(port)) {
  const llm = await fakeLlm();
  const h = await w1dHome("proxy", { models: models(llm.port) });
  const db = openDb(h.db);
  const srv = await startProxy(db, h.blobs, 0);
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/llm`;
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  return {
    h, db, llm, base, notes,
    async done() { await new Promise<void>((r) => srv.close(() => r())); srv.closeAllConnections(); await llm.close(); db.close(); },
  };
}
function run(db: Db, id: string, o: { tier?: string; role?: string; lane?: string; device?: string } = {}) {
  db.run("INSERT INTO runs(id, lane, session_key, role, tier, status, device_id, started) VALUES (?,?,?,?,?, 'running', ?, ?)",
    id, o.lane ?? "client:main", o.lane ?? "client:main", o.role ?? "main", o.tier ?? "chat", o.device ?? null, Date.now());
  return issueToken(db, { run_id: id, tier: (o.tier ?? "chat") as "chat", requester: o.role ?? "main" });
}
const ask = (base: string, token: string | undefined, body: Record<string, unknown>) => fetch(`${base}/v1/messages`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-api-key": token } : {}), "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ max_tokens: 64, stream: true, messages: [{ role: "user", content: "在吗" }], ...body }),
});

test("401: no token, a made-up token, a revoked token; the upstream is never reached", async () => {
  const s = await setup();
  const tok = run(s.db, "r_p1");
  assert.equal((await ask(s.base, undefined, { model: "sbot-chat" })).status, 401);
  assert.equal((await ask(s.base, "run_madeup", { model: "sbot-chat" })).status, 401);
  const ok = await ask(s.base, tok, { model: "sbot-chat" });
  assert.equal(ok.status, 200);
  await ok.text();
  revokeRun(s.db, "r_p1");
  const after = await ask(s.base, tok, { model: "sbot-chat" });
  assert.equal(after.status, 401);
  assert.equal(((await after.json()) as { error: { type: string } }).error.type, "authentication_error");
  assert.equal(s.llm.seen.length, 1);
  await s.done();
});

test("403: another tier is refused; the run's own tier and light pass", async () => {
  const s = await setup();
  const tok = run(s.db, "r_p2", { tier: "chat" });
  const bad = await ask(s.base, tok, { model: "sbot-expert" });
  assert.equal(bad.status, 403);
  assert.equal(((await bad.json()) as { error: { type: string } }).error.type, "permission_error");
  assert.equal((await ask(s.base, tok, { model: "sbot-work" })).status, 403);
  for (const m of ["sbot-chat", "sbot-light"]) { const r = await ask(s.base, tok, { model: m }); assert.equal(r.status, 200, m); await r.text(); }
  assert.deepEqual(s.llm.seen.map((x) => x.body.model), ["claude-fake-chat", "claude-fake-light"], "aliases resolved to real names");
  // the real key goes upstream, the run token never does
  assert.equal(s.llm.seen[0]!.headers["x-api-key"], FAKE_KEY);
  assert.ok(!JSON.stringify(s.llm.seen[0]!.headers).includes(tok));
  await s.done();
});

test("over budget: alerts once per line and keeps answering", async () => {
  // each fake answer spends 7 output tokens: the run line (10) is crossed on the 2nd call, the tier line (2 calls) too
  const s = await setup((port) => fakeModelsYaml(port, "budgets: { run_output_tokens: 10, daily_cost: 0.00001 }")
    .replace("model: claude-fake-chat, price: { in: 1, out: 2 } }", "model: claude-fake-chat, price: { in: 1, out: 2 }, daily_alert: 2 }"));
  const tok = run(s.db, "r_p3");
  for (let i = 0; i < 4; i++) {
    const r = await ask(s.base, tok, { model: "sbot-chat" });
    assert.equal(r.status, 200, `call ${i + 1} is never refused`);
    await r.text();
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.notes.filter((n) => n.includes("单 run 告警线")).length, 1, s.notes.join(" | "));
  assert.equal(s.notes.filter((n) => n.includes("全天告警线")).length, 1);
  assert.equal(s.notes.filter((n) => n.includes("chat 档已调用")).length, 1);
  assert.ok(s.notes.every((n) => n.includes("没拦")));
  assert.equal(s.db.one<{ n: number }>("SELECT spent_output AS n FROM run_tokens WHERE run_id = 'r_p3'")!.n, 28);
  await s.done();
});

test("metering: usage row with source proxy and the run's device; main requests kept gzip'd", async () => {
  const s = await setup();
  const tok = run(s.db, "r_p4", { device: "dev_fake1" });
  const r = await ask(s.base, tok, { model: "sbot-chat" });
  await r.text();
  const u = s.db.one<{ source: string; device_id: string; run_id: string; tier: string; model: string; input_tokens: number; output_tokens: number; cost: number; status: number }>("SELECT * FROM usage")!;
  assert.deepEqual([u.source, u.device_id, u.run_id, u.tier, u.model, u.input_tokens, u.output_tokens, u.status], ["proxy", "dev_fake1", "r_p4", "chat", "claude-fake-chat", 11, 7, 200]);
  assert.ok(Math.abs(u.cost - (11 * 1 + 7 * 2) / 1e6) < 1e-12);
  const req = s.db.one<{ body_ref: string; bytes: number }>("SELECT body_ref, bytes FROM requests WHERE run_id = 'r_p4'")!;
  const f = join(s.h.blobs, req.body_ref.slice(5));
  assert.ok(existsSync(f));
  assert.equal(readFileSync(f).length, req.bytes);
  assert.equal(JSON.parse(gunzipSync(readFileSync(f)).toString()).model, "claude-fake-chat");
  // a light-role run's requests are metered but not kept
  const t2 = run(s.db, "r_p5", { role: "lens" });
  await (await ask(s.base, t2, { model: "sbot-chat" })).text();
  assert.equal(s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE run_id = 'r_p5'")!.n, 0);
  await s.done();
});

test("model change: thinking dropped, tool ids reshaped for the target family, pairs kept", async () => {
  const s = await setup();
  s.db.run("INSERT INTO sessions(key, harness, model, status) VALUES ('client:main', 'pi', 'gpt-fake-old', 'active')");
  const tok = run(s.db, "r_p6");
  const messages = [
    { role: "user", content: "查一下" },
    { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "tool_use", id: "call_abc123", name: "memory_read", input: { path: "x" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_abc123", content: "ok" }] },
  ];
  await (await ask(s.base, tok, { model: "sbot-chat", messages })).text();
  const sent = s.llm.seen[0]!.body.messages;
  assert.ok(!sent[1].content.some((b: { type: string }) => b.type === "thinking"));
  const id = sent[1].content[0].id;
  assert.match(id, /^toolu_/);
  assert.equal(sent[2].content[0].tool_use_id, id);
  assert.equal(s.db.one<{ m: string }>("SELECT model AS m FROM sessions WHERE key = 'client:main'")!.m, "claude-fake-chat", "the lane's last model is remembered");
  // same model next time: thinking stays
  const same = { messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "x" }] }] };
  assert.equal(shapeForModel(structuredClone(same), "claude-fake-chat", "claude-fake-chat"), false);
  const toGpt = { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_x1", name: "a", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x1" }] }] };
  assert.equal(shapeForModel(toGpt, "gpt-fake-expert", "claude-fake-chat"), true);
  assert.match((toGpt.messages[0]!.content[0] as { id: string }).id, /^call_/);
  assert.equal((toGpt.messages[0]!.content[0] as { id: string }).id, (toGpt.messages[1]!.content[0] as { tool_use_id: string }).tool_use_id);
  await s.done();
});
