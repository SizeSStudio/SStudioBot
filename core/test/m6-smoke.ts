// M6 smoke on the VPS, as sbot, on a throwaway home (a fresh dir per run):
//
//   sudo -n -u sbot env SBOT_HOME=/srv/data/sbot/m6test-N SBOT_SECRETS=/srv/sbot/secrets.env SBOT_PROXY_PORT=7829 \
//     SBOT_LARK_CLI=/bin/false sh -c 'cd /srv/data/sbot/m6test-N/app && node test/m6-smoke.ts [--live]'
//
// Port 7829 because sbot-w may only reach 127.0.0.1:7811 and 7820-7829 (the live core's proxy is on 7811).
// Offline: request checks (unknown lens / method, birth missing, month frozen, 渎则不告 per matter), revisit only from
// the owner and only valid claims, ledger text in reviews. --live: one real 六爻 reading through the sealed worker.

import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { P } from "../src/config.ts";
import { one, run } from "../src/db.ts";
import { ensureAgentHome } from "../src/memory.ts";
import { requestReading, revisitReading, readingsForReview, readingsQuery, profileVersion, LensEngine, getReading } from "../src/lens.ts";
import { TOOLS } from "../src/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const throws = (f: () => unknown, re: RegExp, what: string) => {
  try { f(); ok(false, `${what} (was accepted)`); } catch (e: any) { ok(re.test(String(e?.message)), `${what} → ${String(e?.message).slice(0, 80)}`); }
};
for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(here, "..", "seed", "agent-home"));

throws(() => requestReading({ lens: "bazi", method: "x", question: "q", requestedBy: "t" }), /没有这门镜头/, "unknown lens");
throws(() => requestReading({ lens: "ziwei", method: "x", question: "q", requestedBy: "t" }), /没有 x/, "unknown method");
throws(() => requestReading({ lens: "ziwei", method: "month", question: "q", period: "2026-12", requestedBy: "t" }), /出生信息/, "birth missing → told to use the console");
run("INSERT INTO matters(id, title, lane, status, file_path, opened_at) VALUES(?,?,?,?,?,?)", 7, "换工作", "feishu:dm:owner", "open", "matters/7.md", Date.now());
const a = requestReading({ lens: "liuyao", method: "cast", question: "这次换工作能不能谈成", matterId: 7, requestedBy: "owner@feishu:dm" });
ok(one("SELECT status FROM readings WHERE id=?", a)!.status === "queued" && profileVersion("liuyao", "cast").startsWith("liuyao-"), "queued with a profile version");
throws(() => requestReading({ lens: "liuyao", method: "cast", question: "再看一次", matterId: 7, requestedBy: "t" }), /渎则不告/, "second cast on the same matter refused");
const b = requestReading({ lens: "liuyao", method: "cast", question: "对方换了一家公司", matterId: 7, changedBecause: "换了对象", requestedBy: "t" });
ok(b > a, "allowed again when the matter itself changed");

// fake a finished reading to test revisits and the review text
run("UPDATE readings SET status='done', reading='火风鼎，九二动……', notice_json=?, claims_json=?, period='2026-11', horizon='month' WHERE id=?",
  JSON.stringify(["别急着答应"]), JSON.stringify([{ claim: "月底前有回音", revisit_at: "2026-11-28", look_for: "对方是否主动联系" }]), b);
throws(() => revisitReading(b, 3, "x", "owner@feishu:dm", "t"), /只有 1 条/, "claim index checked");
throws(() => revisitReading(a, 0, "x", "owner@feishu:dm", "t"), /还没出结果/, "unfinished reading can't be revisited");
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const ctx = (src: string) => ({ runId: "t", lane: "feishu:dm:owner", principal: "owner", turn: { channel: "feishu" } as any, src, token: "", replies: 0 }) as any;
ok(/only from his own words/.test(await tool("reading_revisit").exec({ reading_id: b, claim_idx: 0, text: "有感应" } as any, ctx("timer@job"))), "reading_revisit refused without the owner's words");
await tool("reading_revisit").exec({ reading_id: b, claim_idx: 0, text: "确实是对方先找的我，有点感应" } as any, ctx("owner@feishu:dm"));
const txt = readingsForReview({ period: "2026-11" });
ok(txt.includes("火风鼎") && txt.includes("有点感应") && txt.includes("[0] 月底前有回音"), "review text: original view + his revisit");
ok(readingsForReview({ from: Date.parse("2026-11-23T00:00:00+08:00"), to: Date.parse("2026-11-30T00:00:00+08:00") }).includes(`#${b}`), "claim due this week is brought out");
ok(readingsQuery({ matterId: 7 }).includes(`#${a}`), "readings_query by matter");
throws(() => requestReading({ lens: "liuyao", method: "cast", question: "x", horizon: "month", period: "2026-11", requestedBy: "t" }), /已经有了/, "month view frozen once written");

if (process.argv.includes("--live")) {
  const { startProxy } = await import("../src/proxy.ts");
  const proxy = await startProxy();
  run("DELETE FROM readings WHERE id IN (?, ?)", a, b);
  const id = requestReading({ lens: "liuyao", method: "cast", question: "测试：这周把 SStudioBot 的框架搭完，顺不顺", requestedBy: "job" });
  const eng = new LensEngine(); eng.start();
  const t0 = Date.now();
  while (Date.now() - t0 < 14 * 60_000 && !["done", "failed"].includes(getReading(id)!.status)) await new Promise((r) => setTimeout(r, 5000));
  const r = getReading(id)!;
  ok(r.status === "done", `live 六爻 reading → ${r.status}${r.error ? ` (${r.error})` : ""} in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (r.status === "done") {
    console.log(`  notice: ${r.notice_json}\n  claims: ${r.claims_json}\n  reading: ${String(r.reading).slice(0, 300)}…`);
    ok(/卦/.test(r.reading), "reading talks about a 卦");
  }
  const cost = one("SELECT COALESCE(SUM(cost),0) c, COUNT(*) n FROM usage WHERE run_id=?", `lens_${id}`)!;
  console.log(`  cost $${Number(cost.c).toFixed(3)} over ${cost.n} calls`);
  eng.stop(); proxy.close();
}
console.log(`\n${process.exitCode ? "SOME FAILED" : "ALL PASS"}`);
process.exit(process.exitCode ?? 0);
