// Run as root by live-home.sh only: copies what a Feishu live test home needs from the live instance, file to file,
// inside this one process — the values are never printed, logged or put on a command line (底线: 密钥只写不读).
//   FEISHU_APP_ID     the app of the live lark-cli login (/srv/sbot/lark), FEISHU_APP_SECRET from /srv/sbot/secrets.env
//   owner feishu id   from /srv/sbot/config/people.yaml (nothing else from it)
//   the test chat     the bot's group named TEST_CHAT (only me and the bot); --create-chat makes it when missing
// Writes <home>/secrets.env (600), <home>/config/people.yaml, <home>/p9-creds.json (600, for probes/p9 in shared mode).
// Prints only what happened, ids masked. Live files are only read.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { parseEnv } from "../src/secrets.ts";

export const TEST_CHAT = "sbot 测试";
const [T, flag] = process.argv.slice(2);
if (!T || !T.startsWith("/srv/data/sbot/testhomes/")) { console.error("usage: live-creds.ts <test home under /srv/data/sbot/testhomes> [--create-chat]"); process.exit(64); }

const appId: string | undefined = JSON.parse(readFileSync("/srv/sbot/lark/.lark-cli/config.json", "utf8")).apps?.[0]?.appId;
const appSecret = parseEnv(readFileSync("/srv/sbot/secrets.env", "utf8")).get("FEISHU_APP_SECRET");
const owner: string | undefined = parse(readFileSync("/srv/sbot/config/people.yaml", "utf8"))?.owner?.ids?.feishu;
if (!appId || !appSecret || !owner) { console.error("missing: " + [!appId && "app id", !appSecret && "app secret", !owner && "owner id"].filter(Boolean).join(", ")); process.exit(1); }

const base = "https://open.feishu.cn/open-apis";
const tok = await (await fetch(`${base}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }) })).json() as { code: number; tenant_access_token?: string };
if (tok.code !== 0 || !tok.tenant_access_token) { console.error(`token: code ${tok.code}`); process.exit(1); }
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tok.tenant_access_token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json() as { code: number; msg?: string; data?: any };
  if (j.code !== 0) throw new Error(`${method} ${path.split("?")[0]}: http ${r.status} code ${j.code}`);
  return j.data ?? {};
};

// the bot's chats, by name; only the exact test name counts
let chat: string | undefined, page = "";
for (let i = 0; i < 20 && !chat; i++) {
  const d = await api("GET", `/im/v1/chats?page_size=100${page ? `&page_token=${page}` : ""}`);
  chat = (d.items ?? []).find((c: any) => c.name === TEST_CHAT)?.chat_id;
  if (!d.has_more) break;
  page = d.page_token;
}
if (!chat && flag === "--create-chat") {
  chat = (await api("POST", "/im/v1/chats?user_id_type=open_id&set_bot_manager=true", { name: TEST_CHAT, chat_mode: "group", chat_type: "private", user_id_list: [owner],
    description: "SStudioBot 飞书真测用，只有我和机器人" })).chat_id;
  console.log(`created the test chat (oc_…)`);
}
if (!chat) { console.error(`no chat named 「${TEST_CHAT}」 with the bot; rerun with --create-chat`); process.exit(1); }
// only me and the bot: anything else and nothing gets sent there
const members = await api("GET", `/im/v1/chats/${chat}/members?member_id_type=open_id&page_size=50`);
const ids = (members.items ?? []).map((m: any) => m.member_id);
if (ids.length !== 1 || ids[0] !== owner) { console.error(`the test chat has ${ids.length} member(s) besides the bot, expected only me: refusing`); process.exit(1); }

writeFileSync(join(T, "secrets.env"), `FEISHU_APP_ID=${appId}\nFEISHU_APP_SECRET=${appSecret}\n`, { mode: 0o600 });
const ppl = join(T, "config", "people.yaml");
if (existsSync(ppl)) { console.error("people.yaml already there"); process.exit(1); }
writeFileSync(ppl, `owner:\n  name: 测试\n  ids:\n    feishu: ${owner}\n`);
writeFileSync(join(T, "test-chat"), chat + "\n");
writeFileSync(join(T, "p9-creds.json"), JSON.stringify({ app_id: appId, app_secret: appSecret, chat_id: chat, shared_live_app: true }), { mode: 0o600 });
console.log("copied: app id, app secret, owner id; test chat has only me and the bot");
