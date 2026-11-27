// 对照：A 跨家换回来后新模型又调一次工具，是不是调用 id 的形状引起的。
// 把记录下来的换后请求原样重放一次，再把 call_ 开头的 id 改成 toolu_ 重放一次。
//   node replay.ts <某次测试 home 里的 p10-requests.jsonl>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const HOME = process.env.SBOT_HOME!, PROXY = process.env.P10_PROXY!;
const token: string = JSON.parse(readFileSync(join(HOME, "run", "tokens.json"), "utf8")).work;
const recs = readFileSync(process.argv[2]!, "utf8").trim().split("\n").map((l) => JSON.parse(l));

for (const trial of ["A-cross-5", "A-cross-6", "A-cross-7"]) {
  const body = recs.filter((r) => r.trial === trial)[1]?.body;
  if (!body) throw new Error(`记录里没有 ${trial} 的换后请求`);
  const raw = JSON.stringify(body);
  for (const [variant, text] of [["原样", raw], ["toolu_", raw.replace(/"call_/g, '"toolu_')]] as const) {
    const r = await fetch(`${PROXY}/v1/messages`, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01" }, body: text });
    const res = await r.text();
    const types = res.split("\n").filter((l) => l.startsWith("data:")).flatMap((l) => {
      try { const e = JSON.parse(l.slice(5)); return e.type === "content_block_start" ? [e.content_block.type as string] : []; } catch { return []; }
    });
    console.log(JSON.stringify({ trial, variant, rewritten: text !== raw, status: r.status, blocks: types }));
  }
}
await new Promise((r) => setTimeout(r, 1500));
const db = new DatabaseSync(join(HOME, "db", "sbot.db"), { readOnly: true });
console.table(db.prepare(`SELECT model, status, COUNT(*) n, SUM(input_tokens) input, SUM(output_tokens) output,
  SUM(cache_read) cache_read, SUM(cache_write) cache_write, ROUND(SUM(cost), 5) cost FROM usage GROUP BY model, status`).all());
