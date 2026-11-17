// End-to-end smoke without Feishu: fake inbox rows → Dispatcher → PiRunner → proxy → upstream → outbox rows (not sent).
//
//   SBOT_HOME=/tmp/x node test/smoke.ts
//
// Checks: a reply is queued; the second turn resumes the same session; usage is metered; a tier escalation is refused;
// a run killed mid-way with no side effects is retried by recover().

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { P, PROXY_BASE } from "../src/config.ts";
import { all, one, run } from "../src/db.ts";
import { startProxy, issueToken, revokeToken } from "../src/proxy.ts";
import { ensureAgentHome } from "../src/memory.ts";
import { PiRunner } from "../src/runner.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import { OWNER_DM_LANE } from "../src/feishu.ts";

const here = dirname(fileURLToPath(import.meta.url));
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));
const proxy = await startProxy();

let seq = 0;
function say(text: string) {
  const id = `om_smoke_${Date.now()}_${seq++}`;
  const turn = { channel: "feishu", chat_id: "oc_smoke", message_id: id, surface: "feishu:dm" };
  run(`INSERT INTO inbox(lane, kind, source, source_msg_id, turn_ctx_json, payload_json, status, ts) VALUES(?,?,?,?,?,?,?,?)`,
    OWNER_DM_LANE, "user", "feishu", id, JSON.stringify(turn), JSON.stringify({ text, ts: Date.now() }), "received", Date.now());
  run(`INSERT INTO messages(id, surface, chat_id, sender_id, sender_kind, ts, text, lane) VALUES(?,?,?,?,?,?,?,?)`,
    id, "feishu:dm", "oc_smoke", "owner", "owner", Date.now(), text, OWNER_DM_LANE);
}
const d = new Dispatcher(new PiRunner(), () => {});
async function settle() {
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    if (!d.busyLanes.length && !one("SELECT 1 FROM inbox WHERE status IN ('received','processing')")) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("timeout");
}
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };

// 1. first turn
say("你好，这是一次冒烟测试。请用一句话回答：1+1 等于几？另外记住暗号「青松」。");
d.kick(); await settle();
let r1 = one("SELECT * FROM runs ORDER BY started DESC LIMIT 1")!;
let o1 = all("SELECT * FROM outbox WHERE run_id=?", r1.id);
ok(r1.status === "done", `run 1 done (${r1.status} ${r1.error ?? ""})`);
ok(o1.length >= 1, `run 1 queued ${o1.length} reply`);
console.log("  reply:", String(o1.at(-1)?.payload ?? "").slice(0, 160).replace(/\n/g, " "));

// 2. second turn resumes
say("刚才的暗号是什么？只回答暗号。");
d.kick(); await settle();
const r2 = one("SELECT * FROM runs ORDER BY started DESC LIMIT 1")!;
const o2 = all("SELECT * FROM outbox WHERE run_id=?", r2.id);
ok(r2.session_ref && r2.session_ref === r1.session_ref, "run 2 resumed the same session");
ok(/青松/.test(String(o2.at(-1)?.payload ?? "")), `run 2 remembers: ${String(o2.at(-1)?.payload ?? "").slice(0, 60)}`);

// 3. usage metered
const u = one("SELECT COUNT(*) n, SUM(output_tokens) o, SUM(cost) c FROM usage")!;
ok(u.n >= 2 && u.o > 0, `usage rows ${u.n}, out ${u.o}, $${Number(u.c ?? 0).toFixed(4)}`);

// 4. tier escalation refused
const tok = issueToken({ runId: "smoke_esc", tier: "light", requester: "system", budgetOutput: 100, ttlMs: 60_000 });
const esc = await fetch(`${PROXY_BASE}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}`, "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: "sbot-expert", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }) });
ok(esc.status === 403, `light token asking for expert → ${esc.status}`);
revokeToken(tok);
const bad = await fetch(`${PROXY_BASE}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body: "{}" });
ok(bad.status === 401 || bad.status === 403, `revoked token → ${bad.status}`);

// 5. crash recovery without side effects: fake a `running` run holding a processing row, then recover()
say("恢复测试：回答「收到」两个字。");
const row = one("SELECT id FROM inbox WHERE status='received' ORDER BY id DESC LIMIT 1")!;
run("INSERT INTO runs(id, lane, session_key, role, tier, model, status, started, side_effects) VALUES('r_fake', ?, ?, 'main', 'chat', 'x', 'running', ?, 0)", OWNER_DM_LANE, OWNER_DM_LANE, Date.now());
run("UPDATE inbox SET status='processing', run_id='r_fake' WHERE id=?", row.id);
d.recover();
ok(one("SELECT status FROM inbox WHERE id=?", row.id)!.status === "received", "recover(): no side effects → back to received");
d.kick(); await settle();
ok(one("SELECT status FROM inbox WHERE id=?", row.id)!.status === "done", "retried run finished");
// each run also writes a streaming-card row (it fails here: no lark-cli); a double send would be two text rows
ok(one("SELECT COUNT(*) n FROM outbox WHERE kind='text' AND run_id IN (SELECT run_id FROM inbox WHERE id=?)", row.id)!.n === 1, "exactly one reply for it");

// 6. with side effects → interrupted + notice, never re-run
say("这条不应该被重跑。");
const row2 = one("SELECT id, turn_ctx_json FROM inbox WHERE status='received' ORDER BY id DESC LIMIT 1")!;
run("INSERT INTO runs(id, lane, session_key, role, tier, model, status, started, side_effects) VALUES('r_fake2', ?, ?, 'main', 'chat', 'x', 'running', ?, 1)", OWNER_DM_LANE, OWNER_DM_LANE, Date.now());
run("UPDATE inbox SET status='processing', run_id='r_fake2' WHERE id=?", row2.id);
d.recover();
ok(one("SELECT status FROM inbox WHERE id=?", row2.id)!.status === "interrupted", "recover(): side effects → interrupted");
ok(one("SELECT COUNT(*) n FROM outbox WHERE run_id='r_fake2'")!.n === 1, "owner notified once");

proxy.close();
console.log(process.exitCode ? "SMOKE FAILED" : "SMOKE OK");
process.exit();
