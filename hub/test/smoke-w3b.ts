// W3b smoke (09 「W3」 验收, the push half) on a fresh home: hub/test/test-home.sh hub/test/smoke-w3b.ts <port>.
// The relay as its own process on 127.0.0.1:<port>, the hub booted with relay on (ws:// loopback), Feishu in shadow
// mode with dummy credentials, FCM left at its default (off). Devices are hub/test/fake-device.ts. Walks, over the relay:
//   a phone and a desktop paired · the phone gives an FCM token: stored, never echoed, fcm_enabled false ·
//   the desktop looking at a card: no ring anywhere · present but elsewhere: only counted · it walks away: the card goes
//   out (FCM off → Feishu) · read on the desktop: the push closes and the phone's stream gets the read ·
//   省心 from the phone: the tidy card is held, waiting-for-reply still pushed; the desktop sees `ease` ·
//   a personal card: Feishu says only 「客户端有新消息」 · a node: 403 on presence.
// The night window is set to one minute at 04:00 so the walk doesn't depend on the hour. Loopback only; fictional data.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeLlm, fakeModelsYaml, FAKE_KEY } from "./fake-llm.ts";
import { DeviceKey, auth, pair, settle, type Channel } from "./fake-device.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { decodePairCode } from "../../protocol/pair.ts";
import { InviteRes } from "../../protocol/api/devices.ts";
import { EaseRes, PushTokenRes } from "../../protocol/api/push.ts";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { run as cli } from "../src/cli.ts";
import { setAdminSink } from "../src/notify.ts";
import { setQuiet } from "../src/log.ts";
import { channel } from "../src/channels/registry.ts";
import type { FeishuChannel } from "../src/channels/feishu/plugin.ts";
import { submitApproval } from "../src/approvals.ts";
import { enqueue } from "../src/push/queue.ts";
import { loadOrCreateHubKey } from "../src/link/keys.ts";

let step = 0;
function ok(cond: unknown, what: string): asserts cond {
  step++;
  if (!cond) { console.log(`✗ ${step}. ${what}`); process.exit(1); }
  console.log(`✓ ${step}. ${what}`);
}
const until = async (cond: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) ok(false, `timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};

setQuiet(true);
useCrypto({ aead: nodeAead, dh: nodeDh });
const PORT = Number(process.env.SBOT_PORT ?? 7829);
const OWNER = "ou_smkw3bowner001", ADMIN = "oc_smkw3badmin001";
const TOKEN = `fake-fcm-${randomBytes(12).toString("hex")}`;
const llm = await fakeLlm(() => ({ text: "好。" }));

// ── the home ──
const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);
mkdirSync(h.config, { recursive: true });
const hubKey = loadOrCreateHubKey(h.keys);
const token = randomBytes(24).toString("base64url");
const relayConf = join(h.root, "relay.yaml");
writeFileSync(relayConf, [
  `listen: { host: 127.0.0.1, port: ${PORT} }`, "hubs:",
  `  - { hub_pk: "${hubKey.publicB64u}", token_hash: "${createHash("sha256").update(token).digest("hex")}" }`,
  "limits: { conn_per_min: 100000, auth_fail_max: 100000 }", "",
].join("\n"));
const relayLog: string[] = [];
const relay: ChildProcess = spawn(process.execPath, [join(import.meta.dirname, "../../relay/src/main.ts")], { env: { PATH: process.env.PATH ?? "", RELAY_CONFIG: relayConf }, stdio: ["ignore", "pipe", "pipe"] });
relay.stdout!.on("data", (d: Buffer) => relayLog.push(...d.toString().split("\n").filter(Boolean)));
await until(() => relayLog.some((l) => l.includes('"ev":"listening"')), 10_000, "relay listening");
const cfg: Record<string, string> = {
  "console.yaml": `relay:\n  enabled: true\n  url: ws://127.0.0.1:${PORT}/v1/hub\n`,
  "models.yaml": fakeModelsYaml(llm.port),
  "channels.yaml": `feishu:\n  mode: shadow\n  admin_chat: ${ADMIN}\n`,
  "people.yaml": `owner:\n  name: 小测\n  ids:\n    feishu: ${OWNER}\n`,
  "groups.yaml": "reviewed: true\n",
  "gate.yaml": "push:\n  night: { from: \"04:00\", to: \"04:01\" }\n",
};
for (const [f, t] of Object.entries(cfg)) writeFileSync(join(h.config, f), t);
writeFileSync(h.secrets, `RELAY_TOKEN=${token}\nFAKE_KEY=${FAKE_KEY}\nFEISHU_APP_ID=cli_smkw3bfake001\nFEISHU_APP_SECRET=smoke-w3b-fake-secret-00\n`, { mode: 0o600 });
const lark = join(h.root, "fake-lark-cli");
writeFileSync(lark, `#!/bin/sh\ncase "$1 $2" in "auth status") echo '{"identities":{}}' ;; *) echo '{"data":{}}' ;; esac\n`, { mode: 0o755 });
process.env.SBOT_LARK_CLI = lark;

const hub = await boot(h, { proxyPort: 0 });
const db = hub.db;
setAdminSink(() => {});
await until(() => hub.link.relay?.connected === true, 10_000, "hub registered");
const f = channel("feishu") as FeishuChannel | undefined;
ok(f?.state() === "shadow", "hub up, registered with the relay, Feishu in shadow mode");
const peer = `ws://127.0.0.1:${PORT}/v1/peer`;
const op = () => randomUUID();
const evs = (c: Channel) => c.frames.flatMap((fr) => (fr.t === "ev" ? [fr] : []));
const sawEv = (c: Channel, entity: string, id: string, test: (d: any) => boolean = () => true) => evs(c).some((e) => e.entity === entity && e.id === id && test(e.data));
const linkIn = (s: string) => /sstudiobot:\/\/pair#\S+/.exec(s)?.[0];
const pq = (ref: string) => db.one<{ state: string; sent_json: string | null; id: number }>("SELECT state, sent_json, id FROM push_queue WHERE ref = ?", ref);
const pushRows = (id: number) => db.all<{ channel: string; payload: string }>("SELECT channel, payload FROM outbox WHERE idem_key LIKE ?", `push:${id}:%`);

// ── 1 two clients ──
const out: string[] = [];
ok(await cli(["pair"], (x) => out.push(x), () => {}) === 0, "sbot pair");
const phoneKey = new DeviceKey();
const phonePair = await pair(decodePairCode(linkIn(out.join("\n"))!), phoneKey, "冒烟手机");
ok((await settle(phonePair)) === "open", "phone paired through the relay");
phonePair.close(); await phonePair.closed;
const phone = await auth(peer, hubKey.publicB64u, phoneKey);
ok((await settle(phone)) === "open", "phone connected");
const inv = await phone.req("POST", "/api/v1/devices/invites", { role: "client" }, { client_op_id: op() });
const deskKey = new DeviceKey();
const deskPair = await pair(decodePairCode(InviteRes.parse(inv.body).link), deskKey, "冒烟桌面");
ok((await settle(deskPair)) === "open", "desktop paired with an invite from the phone");
deskPair.close(); await deskPair.closed;
const desk = await auth(peer, hubKey.publicB64u, deskKey);
ok((await settle(desk)) === "open", "desktop connected");
for (const c of [phone, desk]) {
  const b = await c.req("POST", "/api/v1/bootstrap", {});
  if (b.status !== 200 || !b.body.ease || (await c.req("POST", "/api/v1/stream", { after: b.body.seq })).status !== 200) ok(false, "bootstrap + stream");
}
ok(true, "phone and desktop: bootstrap (with ease) + stream");

// ── 2 the FCM token ──
const tk = await phone.req("PUT", "/api/v1/devices/self/push-token", { token: TOKEN }, { client_op_id: op() });
ok(tk.status === 200 && JSON.stringify(PushTokenRes.parse(tk.body)) === JSON.stringify({ has_token: true, fcm_enabled: false }), "phone's FCM token stored; fcm_enabled false (console.yaml default)");
ok(!JSON.stringify(tk.body).includes(TOKEN) && !JSON.stringify(db.all("SELECT * FROM client_ops")).includes(TOKEN), "…the token isn't echoed or kept in client_ops");
await until(() => sawEv(desk, "device", phoneKey.id, (d) => d?.push === true), 5000, "the device ev");
ok(!JSON.stringify(evs(desk)).includes(TOKEN), "…the desktop sees push: true, never the token");

// ── 3 looking → no ring; present elsewhere → counted; walked away → pushed ──
const look = await desk.req("POST", "/api/v1/presence", { foreground: true, viewing: null });
ok(look.status === 200 && look.body.present === true, "desktop in front: present");
const a1 = submitApproval(db, { kind: "plan", title: "虚构计划：周会挪到周四", origin_lane: "feishu:wb:th_smk1" });
await desk.req("POST", "/api/v1/presence", { foreground: true, viewing: `approval:${a1}` });
// a pass may count it before the viewing report lands; the report kicks again and the counted row closes as viewed
await until(() => pq(`approval:${a1}`)?.state === "done", 5000, "the card closed as viewed");
ok(pq(`approval:${a1}`)?.state === "done" && pushRows(pq(`approval:${a1}`)!.id).length === 0, "the desktop looking at the card: done, nothing to Feishu or the phone");
await desk.req("POST", "/api/v1/presence", { foreground: true, viewing: null });
const a2 = submitApproval(db, { kind: "plan", title: "虚构计划：换会议室", origin_lane: "feishu:wb:th_smk1" });
await until(() => pq(`approval:${a2}`)?.state === "counted", 5000, "counted");
ok(pushRows(pq(`approval:${a2}`)!.id).length === 0, "present, looking elsewhere: only counted");
const gone = await desk.req("POST", "/api/v1/presence", { foreground: false });
ok(gone.body.present === false, "desktop to the background");
await until(() => pq(`approval:${a2}`)?.state === "sent", 5000, "sent after walking away");
const r2 = pushRows(pq(`approval:${a2}`)!.id);
ok(r2.length === 1 && r2[0]!.channel === "feishu" && r2[0]!.payload.includes("换会议室"), "walked away: the card goes out; FCM off → Feishu DM line");

// ── 4 read on one end ──
const rd = await desk.req("POST", "/api/v1/reads", { entity: "approval", id: String(a2) }, { client_op_id: op() });
ok(rd.status === 200 && pq(`approval:${a2}`)?.state === "done", "read on the desktop: the push closes");
await until(() => sawEv(phone, "read", `approval:${a2}`), 5000, "read ev on the phone");
ok(true, "…the phone's stream got the read");

// ── 5 省心 ──
const es = await phone.req("PUT", "/api/v1/ease", { on: true }, { client_op_id: op() });
ok(es.status === 200 && EaseRes.parse(es.body).ease.on, "省心 on from the phone");
await until(() => sawEv(desk, "ease", "ease", (d) => d?.on === true), 5000, "ease ev");
ok(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM config_changes WHERE file = 'ease'")!.n === 1, "…the desktop sees it; one config_changes row");
db.tx(() => {
  enqueue(db, { cat: "tidy", ref: "matter_review:smk1", lane: "feishu:dm:owner", text: "今天的整理：3 条" });
  enqueue(db, { cat: "ask", ref: "approval:smk_ask1", lane: "feishu:wb:th_smk1", text: "等你回：虚构的问题" });
});
await until(() => pq("approval:smk_ask1")?.state === "sent" && pq("matter_review:smk1")?.state !== "wait", 40_000, "ease judged");
ok(pq("matter_review:smk1")?.state === "void" && pushRows(pq("matter_review:smk1")!.id).length === 0, "省心: the tidy card isn't pushed");
ok(pushRows(pq("approval:smk_ask1")!.id).length === 1, "…waiting-for-reply still is");

// ── 6 personal ──
const a3 = submitApproval(db, { kind: "plan", title: "虚构的体检改期", origin_lane: "console:main" });
await until(() => pq(`approval:${a3}`)?.state === "sent", 5000, "personal sent");
const r3 = pushRows(pq(`approval:${a3}`)!.id);
ok(r3.length === 1 && r3[0]!.payload === "客户端有新消息", "a personal card: Feishu says only 「客户端有新消息」");

// ── 7 a node can't report presence ──
const nodeInv = await phone.req("POST", "/api/v1/devices/invites", { role: "node" }, { client_op_id: op() });
const node = await pair(decodePairCode(InviteRes.parse(nodeInv.body).link), new DeviceKey(), "冒烟节点");
ok((await settle(node)) === "open", "a node paired");
ok((await node.req("POST", "/api/v1/presence", { foreground: true })).status === 403, "node: presence is 403");
node.close();

// ── 8 the token stayed out of the logs and the event stream ──
const logs = ["hub.log", "logs/hub.log"].map((p) => join(h.root, p)).filter(existsSync).map((p) => readFileSync(p, "utf8")).join("");
ok(!logs.includes(TOKEN) && !JSON.stringify(db.all("SELECT * FROM change_log")).includes(TOKEN), "the FCM token is in no log and no change_log row");

phone.close(); desk.close();
await hub.close();
relay.kill("SIGTERM");
await llm.close();
ok(true, "hub and relay stopped");
process.exit(0);
