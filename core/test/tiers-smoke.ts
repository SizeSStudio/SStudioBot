// Four tiers through the real proxy, on a throwaway home (live: a few tiny upstream calls):
//
//   ssh <server> 'bash -s tiers-smoke.ts 7829' < test/vps-test-home.sh
//
// Each sbot-<tier> alias reaches tierConf(tier).model; a run token may use its own tier and light, nothing else.

import { TIERS, tierConf, P } from "../src/config.ts";
import { mkdirSync } from "node:fs";
import { issueToken, startProxy } from "../src/proxy.ts";
import { one } from "../src/db.ts";

const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
const proxy = await startProxy();
const port = Number(process.env.SBOT_PROXY_PORT);

const call = async (tokenTier: string, model: string) => {
  const runId = `tiers_${tokenTier}_${model}_${Date.now().toString(36)}`;
  const token = issueToken({ runId, tier: tokenTier as any, requester: "system", budgetOutput: 200, ttlMs: 60_000 });
  const r = await fetch(`http://127.0.0.1:${port}/llm/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] }),
  });
  const j: any = await r.json().catch(() => ({}));
  const u = one("SELECT model, tier FROM usage WHERE run_id=? ORDER BY rowid DESC", runId);
  return { status: r.status, model: j.model, usage: u };
};

ok(TIERS.join() === "chat,work,light,expert", "four tiers");
for (const t of TIERS) {
  const r = await call(t, `sbot-${t}`);
  console.log(`  ${t}: ${tierConf(t).model} → HTTP ${r.status}, upstream says ${r.model}, ledger ${r.usage?.tier}/${r.usage?.model}`);
  ok(r.status === 200 && r.usage?.tier === t, `${t} token on sbot-${t} → ${tierConf(t).model}`);
}
ok((await call("work", "sbot-light")).status === 200, "work token may use light");
ok((await call("work", "sbot-chat")).status === 403, "work token may not use chat");
ok((await call("work", "sbot-expert")).status === 403, "work token may not use expert");
ok((await call("chat", "sbot-work")).status === 403, "chat token may not use work");

proxy.close();
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
