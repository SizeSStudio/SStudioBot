// Live CardKit test: streams a fake reply into a real Feishu chat as the bot, through CardStream.
//   sudo -u sbot env SBOT_HOME=<scratch> SBOT_SECRETS=/srv/sbot/secrets.env SBOT_LARK_HOME=/srv/sbot/lark \
//     SBOT_LARK_CLI=/opt/sbot/bin/lark-cli node test/card-live.ts <chat_id>
import { run } from "../src/db.ts";
import { CardStream, toolStatus } from "../src/card.ts";
import { directApi } from "../src/feishu-api.ts";

const chat = process.argv[2];
if (!chat) throw new Error("usage: card-live.ts <chat_id>");
const runId = `cardtest_${Date.now().toString(36)}`;
run("INSERT INTO runs(id, lane, status, started) VALUES(?,?,?,?)", runId, "test", "running", Date.now());
const ctx = { runId, lane: "test", principal: "owner" as const, turn: { channel: "feishu" as const, chat_id: chat, surface: "feishu:dm" }, src: "test", token: "", replies: 0 };
const t0 = Date.now();
const c = new CardStream(ctx);
const parts = ["（SStudioBot 流式卡片测试，不用回复）", "先想一下……", "\n\n要查点东西。"];
let text = "";
for (const p of parts) { text += p; c.update(text); await new Promise((r) => setTimeout(r, 400)); }
c.update(text, toolStatus("web_search"));
await new Promise((r) => setTimeout(r, 3500));
for (const p of ["\n\n查到了：", "流式更新、状态行、", "结束时关掉流式，", "**都正常**。"]) { text += p; c.update(text); await new Promise((r) => setTimeout(r, 300)); }
const ok = await c.finish(text);
console.log(JSON.stringify({ direct: directApi(), started: c.started, finished: ok, failed: c.failed, ms: Date.now() - t0 }));
process.exit(ok ? 0 : 1);
