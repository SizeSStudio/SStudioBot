// Console decide smoke (DESIGN §触5.4) on the VPS, as sbot, on a fresh throwaway home:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh console-decide-smoke.ts 7829
//
// No real Feishu: fetch is replaced, and each card patch takes 1.5 s like the real one. Own secrets file, and hooks in
// place of the outbox and dispatcher, so nothing is sent. Checks that answering early changed only the timing:
//   everything durable is there when the response arrives; the card still comes before the kick; stale clicks still 409;
//   kinds the core executes still answer with their result; a card click still waits for everything.

import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = process.env.SBOT_HOME ?? "";
if (!HOME || HOME === "/srv/sbot" || !/testhomes|tmp/.test(HOME)) { console.error("run on a throwaway SBOT_HOME (see vps-test-home.sh)"); process.exit(2); }
mkdirSync(join(HOME, "socks", "tn"), { recursive: true });
process.env.SBOT_SECRETS = join(HOME, "secrets-test.env");
process.env.SBOT_CONSOLE_SOCK = join(HOME, "socks", "tn", "console.sock");
process.env.SBOT_CONSOLE_WEB_SOCK = join(HOME, "socks", "none", "console.sock");
delete process.env.SBOT_CONSOLE_PORT;
writeFileSync(process.env.SBOT_SECRETS, "FEISHU_APP_ID=cli_test\nFEISHU_APP_SECRET=test\n", { mode: 0o600 });

const realLog = console.log;
console.log = () => {};
const ok = (cond: unknown, what: string) => { realLog(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// what happened, in order
let trace: string[] = [], failPatch = false;
const PATCH_MS = 1500;
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url), reply = (j: unknown) => new Response(JSON.stringify(j), { headers: { "content-type": "application/json" } });
  if (u.includes("tenant_access_token")) return reply({ code: 0, tenant_access_token: "t", expire: 7200 });
  if (init?.method === "PATCH") {
    trace.push("patch:start"); await sleep(PATCH_MS); trace.push("patch:end");
    return reply(failPatch ? { code: 230001, msg: "nope" } : { code: 0, data: {} });
  }
  return reply({ code: 0, data: {} });
}) as typeof fetch;

const here = dirname(fileURLToPath(import.meta.url));
const { P, ownerFeishu } = await import("../src/config.ts");
const { one, run } = await import("../src/db.ts");
const { ensureAgentHome } = await import("../src/memory.ts");
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const { hooks, submitApproval, onApprovalClick, getApproval } = await import("../src/approvals.ts");
const { startConsole } = await import("../src/console.ts");
hooks.kickOutbox = () => { trace.push("kick:outbox"); };
hooks.kickDispatcher = () => { trace.push("kick:dispatcher"); };
hooks.onDeferred = async () => { trace.push("deferred"); return "pushed abc"; };

writeFileSync(join(P.config, "console.yaml"), "owners: [owner@localhost]\n");
const srv = startConsole({ startedAt: Date.now() });
await sleep(300);

function decide(id: number, d: string, v: number, note?: string) {
  const send = JSON.stringify({ d, v, note }), t0 = Date.now();
  return new Promise<{ status: number; ms: number; a: any }>((resolve, reject) => {
    const r = http.request({ socketPath: process.env.SBOT_CONSOLE_SOCK, method: "POST", path: `/api/approval/${id}/decide`,
      headers: { "tailscale-user-login": "owner@localhost", "x-sbot-console": "1", "content-type": "application/json", "content-length": String(Buffer.byteLength(send)) } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (c) => { t += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, ms: Date.now() - t0, a: JSON.parse(t) }));
    });
    r.on("error", reject); r.end(send);
  });
}
function make(kind: "send" | "plan" | "deferred_tool", extra: Record<string, unknown> = {}) {
  const id = submitApproval({ kind, title: `t-${kind}`, requester: "main", draft: "草稿正文", origin_lane: "feishu:dm:owner", channel: "feishu", target: { chat_id: "oc_test" }, ...extra } as any);
  run("UPDATE approvals SET card_msg_id=? WHERE id=?", `om_${id}`, id);
  return id;
}
const settle = () => sleep(PATCH_MS + 400);
ok(!!ownerFeishu(), "the test home has an owner");

// ── approve a send ──
let id = make("send"); trace = [];
let r = await decide(id, "approve", 1);
realLog(`     approve send answered in ${r.ms} ms (card patch takes ${PATCH_MS} ms)`);
ok(r.status === 200 && r.ms < 500, "approve send: answers without waiting for the card");
ok(r.a.status === "approved" && r.a.final_text === "草稿正文" && /控制台/.test(r.a.decide_note ?? ""), "the response is the decided approval, marked as from the console");
let row = getApproval(id)!, out = one("SELECT * FROM outbox WHERE approval_id=?", id);
ok(row.status === "approved" && row.decided_by === ownerFeishu() && !!row.decided_at, "decision is in the database when the response arrives");
ok(out?.status === "queued" && out.idem_key === `sbot-ap-${id}` && out.payload === "草稿正文", "outbox row is in the database when the response arrives");
ok(!trace.includes("kick:outbox"), "outbox not kicked yet: the card goes first");
await settle();
ok(trace.join() === "patch:start,patch:end,kick:outbox", "then card, then kick, once each");

// ── repeats and stale versions ──
trace = [];
ok((await decide(id, "approve", 1)).status === 409, "a repeated click: 409");
ok((await decide(id, "reject", 1)).status === 409 && getApproval(id)!.status === "approved", "a late reject changes nothing");
const old = make("send"); run("UPDATE approvals SET draft_version=2 WHERE id=?", old);
ok((await decide(old, "approve", 1)).status === 409 && getApproval(old)!.status === "pending" && !one("SELECT 1 x FROM outbox WHERE approval_id=?", old), "an old draft version: 409, still pending, nothing queued");
r = await decide(old, "maybe", 2);
ok(r.status === 400 && getApproval(old)!.status === "pending", "a bad decision: 400");
await settle();
ok(trace.length === 0, "none of those touched the card or woke anything");

// ── reject ──
id = make("send"); trace = [];
r = await decide(id, "reject", 1, "不合适");
ok(r.status === 200 && r.ms < 500 && r.a.status === "rejected" && /不合适/.test(r.a.decide_note), "reject: quick, with the note");
ok(!one("SELECT 1 x FROM outbox WHERE approval_id=?", id), "reject queues nothing");
await settle();
ok(trace.join() === "patch:start,patch:end,kick:outbox", "reject: card, then the same outbox kick a send always gets");

// ── plan ──
id = make("plan"); trace = [];
r = await decide(id, "approve", 1);
const ev = one("SELECT * FROM inbox WHERE source='approval' AND source_msg_id=?", `${id}:approved`);
ok(r.status === 200 && r.ms < 500 && ev?.status === "received", "plan: the lane event is in the database when the response arrives");
await settle();
ok(trace.join() === "patch:start,patch:end,kick:dispatcher", "plan: card, then dispatcher");

// ── a failed card patch ──
id = make("send"); trace = []; failPatch = true;
r = await decide(id, "approve", 1);
await settle(); failPatch = false;
ok(r.status === 200 && trace.join() === "patch:start,patch:end,kick:outbox", "card patch fails: decision stands, outbox still kicked");

// ── kinds the core carries out ──
id = make("deferred_tool"); trace = [];
r = await decide(id, "approve", 1);
ok(r.status === 200 && r.a.result === "pushed abc", "deferred_tool: the response carries the result");
ok(r.ms >= PATCH_MS * 2 && trace.join() === "patch:start,patch:end,deferred,patch:start,patch:end", "deferred_tool: still fully inline, same order");

// ── the card path ──
id = make("send"); trace = [];
const t0 = Date.now(), a = await onApprovalClick({ id, v: 1, d: "approve" }, ownerFeishu()!);
ok(a?.status === "approved" && Date.now() - t0 >= PATCH_MS && trace.join() === "patch:start,patch:end,kick:outbox", "card click: still waits for everything");
id = make("send"); trace = [];
ok(await onApprovalClick({ id, v: 1, d: "approve" }, "ou_someone_else") === undefined && getApproval(id)!.status === "pending" && !trace.length, "someone else's click: ignored");

srv.close();
realLog(process.exitCode ? "SOME FAILED" : "ALL PASSED");
process.exit(process.exitCode ?? 0);
