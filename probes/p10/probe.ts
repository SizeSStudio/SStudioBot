// P10（IC-11）：最后一条 assistant 带 tool_use、结果还没回来时换模型。
//   A  换模型照调 setModel，等工具结果回来，下一次请求才到新模型
//   B  立刻换：abort，未完的调用补一条「已取消」结果，换模型后继续
// pi 嵌入照旧 PiRunner。请求路径：pi → 本进程里的记录器 → 代理 → 上游。本进程只拿 run 令牌。
//
//   node probe.ts list        经代理列出端点上的模型名
//   node probe.ts smoke       每种做法跨家、同家各 1 次
//   node probe.ts [每格次数]   默认 10

import http from "node:http";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parse } from "yaml";
import * as pi from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const HOME = process.env.SBOT_HOME!;
const PROXY = process.env.P10_PROXY!;                       // http://127.0.0.1:<port>/llm
const MAX_CALLS = Number(process.env.P10_MAX_CALLS ?? 110); // 花费上限：超了记录器直接拒
const tokens: Record<"work" | "expert", string> = JSON.parse(readFileSync(join(HOME, "run", "tokens.json"), "utf8"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CANCELLED = "已取消：换模型时这次调用还没返回，没有拿到结果。";

if (process.argv[2] === "list") {
  const r = await fetch(`${PROXY}/v1/models?limit=1000`, { headers: { authorization: `Bearer ${tokens.work}`, "anthropic-version": "2023-06-01" } });
  const j: any = await r.json().catch(() => ({}));
  console.log(r.status, (j.data ?? []).map((m: any) => m.id).sort().join("\n"));
  process.exit(0);
}

// ---------- 记录器：记请求体和响应，不记请求头 ----------
interface Rec { trial: string; body: any; status: number; res: string }
const recs: Rec[] = [];
let current = "";
const recorder = http.createServer(async (req, res) => {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  const raw = Buffer.concat(parts);
  if (recs.length >= MAX_CALLS) return void res.writeHead(403).end('{"type":"error","error":{"type":"permission_error","message":"probe call cap"}}');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers))
    if (typeof v === "string" && !["host", "content-length", "connection", "accept-encoding"].includes(k)) headers[k] = v;
  const rec: Rec = { trial: current, body: raw.length ? JSON.parse(raw.toString("utf8")) : undefined, status: 0, res: "" };
  recs.push(rec);
  try {
    const up = await fetch(PROXY + req.url!.replace(/^\/llm/, ""), { method: req.method, headers, body: raw.length ? raw : undefined });
    rec.status = up.status;
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!["content-encoding", "content-length", "transfer-encoding"].includes(k)) out[k] = v; });
    res.writeHead(up.status, out);
    const dec = new TextDecoder();
    if (up.body) for await (const c of up.body as any) { rec.res += dec.decode(c, { stream: true }); res.write(c); }
    res.end();
  } catch (e: any) {
    rec.status = -1; rec.res = String(e?.message ?? e); res.destroy();
  }
});
await new Promise<void>((ok) => recorder.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${(recorder.address() as any).port}/llm`;

// ---------- pi，配置照旧 PiRunner ----------
const agentDir = join(HOME, "sessions", ".pi-agent"), cwd = join(HOME, "sessions", "pi-cwd"), sessionsDir = join(HOME, "sessions", "pi");
for (const d of [agentDir, cwd, sessionsDir]) mkdirSync(d, { recursive: true });
const cfg = parse(readFileSync(join(HOME, "config", "models.yaml"), "utf8"));
type Tier = "light" | "work" | "expert";
const TIERS: Tier[] = ["light", "work", "expert"];
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { sbot: {
  baseUrl: base, api: "anthropic-messages",
  models: TIERS.map((t) => ({ id: `sbot-${t}`, name: `sbot-${t}`, reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 600,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
} } }, null, 2));

async function makeSession(token: string, tier: Tier, tool: any) {
  const runtime = await pi.ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  await runtime.setRuntimeApiKey("sbot", token);
  const model = (t: Tier) => { const m = runtime.getModel("sbot", `sbot-${t}`); if (!m) throw new Error(`no model ${t}`); return m; };
  const settingsManager = pi.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 }, cacheWarming: "off" } as any);
  const resourceLoader = new pi.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    systemPrompt: "你是测试助手。要查代码就调用 lookup 工具，不要编造。回复尽量短。",
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } as any);
  await resourceLoader.reload();
  const { session } = await pi.createAgentSession({ cwd, agentDir, model: model(tier), thinkingLevel: "off", modelRuntime: runtime, resourceLoader,
    settingsManager, sessionManager: pi.SessionManager.create(cwd, sessionsDir), noTools: "builtin", customTools: [tool] } as any);
  return { session, model };
}

// ---------- 一次试验 ----------
interface Spec { approach: "A" | "B"; kind: "same" | "cross"; from: Tier; to: Tier; calls: 1 | 2; id: string }
const norm = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);   // 同 pi 的 normalizeToolCallId
const textOf = (c: any): string => typeof c === "string" ? c : (c ?? []).map((b: any) => b.text ?? "").join("");
const blocks = (m: any): any[] => Array.isArray(m?.content) ? m.content : [];
const strip = (s: string) => s.replace(/https?:\/\/\S+/g, "<url>").replace(/\b(req|msg|toolu|call|resp|chatcmpl|fc)[_-][A-Za-z0-9_-]{6,}/g, "$1_<id>")
  .replace(/"request_?id"\s*:\s*"[^"]*"/gi, '"request_id":"<id>"').slice(0, 400);
const errorIn = (r: Rec) => r.status !== 200 || /(^|\n)event:\s*error|"type"\s*:\s*"error"/.test(r.res);

async function trial(s: Spec) {
  current = s.id;
  const calls: { id: string; key: string; code: string; done: boolean }[] = [];
  let switched = false;
  const recalled: string[] = [];
  let release!: () => void, opened!: () => void;
  const gate = new Promise<void>((ok) => (release = ok)), open = new Promise<void>((ok) => (opened = ok));
  const tool = {
    name: "lookup", label: "lookup", description: "按 key 查一个代码", parameters: Type.Object({ key: Type.String() }),
    execute: async (id: string, p: any, signal?: AbortSignal) => {
      const code = "C" + randomBytes(5).toString("hex");
      const real = { content: [{ type: "text" as const, text: `key=${p.key} code=${code}` }], details: {} };
      if (switched) { recalled.push(String(p.key)); return { ...real, terminate: true }; }   // 换完又调一次：记下，就地收尾省钱
      const c = { id, key: String(p.key), code, done: false };
      calls.push(c);
      if (c.key === "fast") { c.done = true; return real; }
      const work = gate.then(() => { c.done = true; return real; });       // 和旧 piTools 一样不理 abort，活照干
      opened();
      if (s.approach === "A") return work;
      const cancel = new Promise<any>((ok) => signal!.addEventListener("abort", () => ok({ content: [{ type: "text", text: CANCELLED }], details: {}, isError: true }), { once: true }));
      return Promise.race([work, cancel]);
    },
  };
  const { session, model } = await makeSession(s.kind === "same" ? tokens.work : tokens.expert, s.from, tool);
  const ask = s.calls === 1
    ? "调用 lookup 查 key=slow，拿到结果后只回复查到的代码。"
    : "在同一条回复里同时发起两个 lookup 调用：key=fast 和 key=slow。都拿到后只回复两个代码。";
  const guard = setTimeout(() => { release(); void session.abort(); }, 120_000);
  const out: any = { ...s };
  try {
    const first = session.prompt(ask);
    const state = await Promise.race([open.then(() => "open"), first.then(() => "done")]);
    if (state !== "open") return { ...out, valid: false, why: "模型没有发起要等的调用", errors: recs.filter((r) => r.trial === s.id && errorIn(r)).map((r) => `${r.status} ${strip(r.res)}`) };
    await sleep(300);
    const mark = recs.length;
    switched = true;
    const t0 = Date.now();
    if (s.approach === "A") {
      await session.setModel(model(s.to));
      await sleep(300);
      out.sentBeforeResult = recs.length - mark;   // 结果没回来时不该发请求
      release();
      await first;
    } else {
      await session.abort();
      await first.catch(() => {});
      await session.setModel(model(s.to));
      release();                                   // 被取消的工具随后还是跑完了
      await sleep(100);
      await session.prompt("（已换模型，接着做。）");
    }
    out.ms = Date.now() - t0;

    const mine = recs.filter((r) => r.trial === s.id);
    const after = recs.slice(mark).filter((r) => r.trial === s.id);
    const r2 = after[0];
    const msgs: any[] = r2?.body?.messages ?? [];
    const results = new Map<string, any[]>();
    let paired = !!r2;
    msgs.forEach((m, i) => {
      const uses = blocks(m).filter((b) => b.type === "tool_use").map((b) => b.id);
      if (!uses.length) return;
      const got = blocks(msgs[i + 1]).filter((b) => b.type === "tool_result");
      if (msgs[i + 1]?.role !== "user" || got.length !== uses.length || uses.some((u) => got.filter((g) => g.tool_use_id === u).length !== 1)) paired = false;
      for (const g of got) results.set(g.tool_use_id, [...(results.get(g.tool_use_id) ?? []), g]);
    });
    const open_ = calls.filter((c) => c.key !== "fast"), done = calls.filter((c) => c.key === "fast");
    const has = (c: { id: string }, needle: string, isError: boolean) => {
      const g = results.get(norm(c.id));
      return g?.length === 1 && textOf(g[0].content).includes(needle) && !!g[0].is_error === isError;
    };
    const reply = session.getLastAssistantText() ?? "";
    Object.assign(out, {
      valid: true,
      callsMade: calls.length, openCalls: open_.length,
      idPrefix: [...new Set(calls.map((c) => c.id.split("_")[0].slice(0, 8)))],
      requests: mine.length,
      status400: mine.filter((r) => r.status === 400).length,
      errors: mine.filter(errorIn).map((r) => `${r.status} ${strip(r.res)}`),
      newModel: r2?.body?.model === `sbot-${s.to}`,
      paired,
      doneKept: done.every((c) => has(c, c.code, false)),
      openAsExpected: open_.every((c) => s.approach === "A" ? has(c, c.code, false) : has(c, CANCELLED, true)),
      placeholder: JSON.stringify(msgs).includes("No result provided"),
      // 工具跑完产出的真结果，有没有进过任何一次上游请求
      openRealDelivered: open_.filter((c) => after.some((r) => JSON.stringify(r.body).includes(c.code))).length,
      openFinished: open_.filter((c) => c.done).length,
      recalls: recalled.length, recalledKeys: recalled,
      replyHasCodes: (s.approach === "A" ? calls : done).filter((c) => reply.includes(c.code)).length,
      replyExpected: (s.approach === "A" ? calls : done).length,
      thinkingBefore: recs.slice(0, mark).filter((r) => r.trial === s.id && /"type"\s*:\s*"(redacted_)?thinking"/.test(r.res)).length,
      thinkingSentAfter: msgs.flatMap(blocks).filter((b) => /thinking/.test(b.type)).length,
    });
    return out;
  } catch (e: any) {
    return { ...out, valid: true, threw: strip(String(e?.message ?? e)) };
  } finally {
    clearTimeout(guard);
    release();
    session.dispose();
  }
}

// ---------- 排程 ----------
const smoke = process.argv[2] === "smoke";
const N = smoke ? 1 : Number(process.argv[2] ?? 10);
const specs: Spec[] = [];
for (const approach of ["A", "B"] as const)
  for (const kind of ["same", "cross"] as const)
    for (let i = 0; i < N; i++) {
      const other: Tier = kind === "same" ? "work" : "expert";
      const [from, to] = i < Math.ceil(N / 2) ? ["light", other] as const : [other, "light"] as const;
      specs.push({ approach, kind, from, to, calls: smoke || i % 2 ? 2 : 1, id: `${approach}-${kind}-${i}` });
    }

const results: any[] = [];
for (const s of specs) {
  let r = await trial(s);
  if (!r.valid) { results.push(r); console.log(JSON.stringify(r)); r = await trial({ ...s, id: s.id + "-retry" }); }
  results.push(r);
  console.log(JSON.stringify(r));
}

const passed = (r: any) => r.valid && !r.threw && !r.status400 && !r.errors.length && r.newModel && r.paired && r.doneKept && r.openAsExpected && !r.placeholder && !r.sentBeforeResult;
const table = ["A", "B"].flatMap((a) => ["same", "cross"].map((k) => {
  const c = results.filter((r) => r.valid && r.approach === a && r.kind === k);
  const sum = (f: string) => c.reduce((n, r) => n + (r[f] ?? 0), 0);
  return { approach: a, kind: k, trials: c.length, historyOk: c.filter(passed).length, status400: sum("status400"), errors: c.reduce((n, r) => n + (r.errors?.length ?? 0), 0),
    parallel: c.filter((r) => r.callsMade > 1).length, openCalls: sum("openCalls"), openFinished: sum("openFinished"), openRealDelivered: sum("openRealDelivered"),
    recalls: sum("recalls"), trialsRecalled: c.filter((r) => r.recalls).length, thinkingBefore: sum("thinkingBefore"), thinkingSentAfter: sum("thinkingSentAfter"), replyHasCodes: `${sum("replyHasCodes")}/${sum("replyExpected")}`, msMedian: c.map((r) => r.ms ?? 0).sort((x, y) => x - y)[c.length >> 1] };
}));
await sleep(1500);   // 等代理记完账
const db = new DatabaseSync(join(HOME, "db", "sbot.db"), { readOnly: true });
const usage = db.prepare(`SELECT tier, model, status, COUNT(*) n, SUM(input_tokens) input, SUM(output_tokens) output,
  SUM(cache_read) cache_read, SUM(cache_write) cache_write, ROUND(SUM(cost), 5) cost FROM usage GROUP BY tier, model, status`).all();
console.table(table);
console.table(usage);
console.log("invalid:", results.filter((r) => !r.valid).length, "upstream requests:", recs.length);
writeFileSync(join(HOME, "p10-results.json"), JSON.stringify({ table, usage, results }, null, 2));
for (const r of recs) appendFileSync(join(HOME, "p10-requests.jsonl"), JSON.stringify(r) + "\n");
recorder.close();
process.exit(0);
