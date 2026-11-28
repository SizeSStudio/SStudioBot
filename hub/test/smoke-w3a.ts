// W3a smoke (09 「W3」 验收 §触6.9 P3、P4, the write half) on a fresh home: hub/test/test-home.sh hub/test/smoke-w3a.ts <port>.
// The relay as its own process on 127.0.0.1:<port>, the hub booted with relay on (ws:// loopback), Feishu in shadow
// mode with dummy credentials, a fake LLM upstream. Devices are hub/test/fake-device.ts (protocol/ only). Walks, all
// over the relay unless said:
//   pairing a second device and a node with POST /api/v1/devices/invites (W3a: device writes over a client channel) ·
//   a thread made and resent (same answer, one row) · a message, resent after a cut socket (one input, the reply once) ·
//   a Feishu card click and a phone click on the same card at the same moment: one wins, one send, every end shows it ·
//   a draft edited on the phone: the desktop's stale save is 409 with the current text, the approved text is the edit ·
//   a decide whose answer is lost to a cut socket, resent after reconnecting: the same answer, one send ·
//   a node: 403 on every write · a personal thread stays personal, the admin chat's /approvals shows it as one line ·
//   sbot devices rm still works over hub-admin.sock.
// Loopback only; fictional data; nothing installed. Prints steps; exits non-zero on the first failure.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeLlm, fakeModelsYaml, FAKE_KEY, type Step } from "./fake-llm.ts";
import { DeviceKey, auth, pair, settle, type Channel } from "./fake-device.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { decodePairCode } from "../../protocol/pair.ts";
import { InviteRes } from "../../protocol/api/devices.ts";
import { ApprovalRes, Conflict, MessageRes, ThreadRes, WRITES } from "../../protocol/api/write.ts";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { run as cli } from "../src/cli.ts";
import { setAdminSink } from "../src/notify.ts";
import { setQuiet } from "../src/log.ts";
import { channel } from "../src/channels/registry.ts";
import type { FeishuChannel } from "../src/channels/feishu/plugin.ts";
import { submitApproval, type ApprovalSpec } from "../src/approvals.ts";
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
const OWNER = "ou_smkw3owner0001", ADMIN = "oc_smkw3admin0001", PEER_CHAT = "oc_smkw3peer00001";
const ASK = "下周三的评审材料准备到哪一步了";
const REPLY = "评审材料还差第三节的数据图，其余都齐了。";
const llm = await fakeLlm((b): Step => (JSON.stringify(b.messages ?? []).includes(ASK) ? { text: REPLY, pace: 20 } : { text: "好。" }));

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
};
for (const [f, t] of Object.entries(cfg)) writeFileSync(join(h.config, f), t);
writeFileSync(h.secrets, `RELAY_TOKEN=${token}\nFAKE_KEY=${FAKE_KEY}\nFEISHU_APP_ID=cli_smkw3fake0001\nFEISHU_APP_SECRET=smoke-w3a-fake-secret-000\n`, { mode: 0o600 });
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
const sawEv = (c: Channel, entity: string, id: string, test: (d: any) => boolean) => evs(c).some((e) => e.entity === entity && e.id === id && test(e.data));
const count = (sql: string, ...a: (string | number)[]) => db.one<{ n: number }>(sql, ...a)!.n;
const linkIn = (s: string) => /sstudiobot:\/\/pair#\S+/.exec(s)?.[0];

// ── 1 the phone from sbot pair; the desktop and a node from invites made over the phone's channel ──
const out: string[] = [];
ok(await cli(["pair"], (x) => out.push(x), () => {}) === 0, "sbot pair (hub-admin.sock, writes through the same dispatcher now)");
const phoneKey = new DeviceKey();
const phonePair = await pair(decodePairCode(linkIn(out.join("\n"))!), phoneKey, "冒烟手机");
ok((await settle(phonePair)) === "open", "phone paired through the relay");
phonePair.close(); await phonePair.closed;
let phone = await auth(peer, hubKey.publicB64u, phoneKey);
ok((await settle(phone)) === "open", "phone connected with auth");
ok((await phone.req("POST", "/api/v1/devices/invites", { role: "client" })).status === 400, "a write without client_op_id: 400");
const invOp = op();
const inv = await phone.req("POST", "/api/v1/devices/invites", { role: "client" }, { client_op_id: invOp });
ok(inv.status === 200, "POST /api/v1/devices/invites over the relay (W2: 404 here)");
const invAgain = await phone.req("POST", "/api/v1/devices/invites", { role: "client" }, { client_op_id: invOp });
ok(invAgain.status === 409 && !JSON.stringify(invAgain.body).includes(InviteRes.parse(inv.body).link), "…its retry: 409, the pairing code is not replayed");
ok(!db.one<{ r: string }>("SELECT result_json AS r FROM client_ops WHERE client_op_id = ?", invOp)!.r.includes("pair#"), "…nor stored in client_ops");
const deskKey = new DeviceKey();
const deskPair = await pair(decodePairCode(InviteRes.parse(inv.body).link), deskKey, "冒烟桌面");
ok((await settle(deskPair)) === "open", "desktop paired with that code");
deskPair.close(); await deskPair.closed;
const desk = await auth(peer, hubKey.publicB64u, deskKey);
ok((await settle(desk)) === "open", "desktop connected");
const nodeInv = await phone.req("POST", "/api/v1/devices/invites", { role: "node" }, { client_op_id: op() });
const node = await pair(decodePairCode(InviteRes.parse(nodeInv.body).link), new DeviceKey(), "冒烟节点");
ok((await settle(node)) === "open", "a node paired with a node invite from the phone");
const ren = await phone.req("PATCH", `/api/v1/devices/${deskKey.id.slice(0, 8)}`, { name: "冒烟桌面二号" }, { client_op_id: op() });
ok(ren.status === 200 && db.one<{ n: string }>("SELECT name AS n FROM devices WHERE id = ?", deskKey.id)?.n === "冒烟桌面二号", "the phone renamed the desktop");

// both clients watch the stream
for (const c of [phone, desk]) {
  const b = await c.req("POST", "/api/v1/bootstrap", {});
  if ((await c.req("POST", "/api/v1/stream", { after: b.body.seq })).status !== 200) ok(false, "stream");
}
ok(true, "phone and desktop: bootstrap + stream");

// ── 2 a node can't write ──
let n403 = 0;
for (const route of Object.keys(WRITES)) {
  const [m, p] = route.split(" ") as [any, string];
  if ((await node.req(m, p.replace(":id", "x1234567"), { action: "approve", draft_version: 1 }, { client_op_id: op() })).status === 403) n403++;
}
ok(n403 === Object.keys(WRITES).length, `node: 403 on all ${n403} write routes`);
node.close();

// ── 3 a thread, resent ──
const thOp = op();
const th1 = await phone.req("POST", "/api/v1/threads", { title: "评审准备" }, { client_op_id: thOp });
const th = ThreadRes.parse(th1.body).thread;
const th2 = await phone.req("POST", "/api/v1/threads", { title: "评审准备" }, { client_op_id: thOp });
ok(th1.status === 200 && JSON.stringify(th2) === JSON.stringify(th1) && count("SELECT COUNT(*) AS n FROM threads WHERE title = '评审准备'") === 1,
  `thread made (${th.id}, ${th.domain}); the resend got the same answer and seq ${th1.seq}, one row`);
ok((await phone.req("POST", "/api/v1/threads", { title: "另一个" }, { client_op_id: thOp })).status === 409, "…the same op id with another body: 409");
await until(() => sawEv(desk, "thread", th.id, (d) => d?.title === "评审准备"), 5000, "thread on the desktop");
ok(true, "…the desktop got it on its stream");

// ── 4 a message, its answer lost to a cut socket, resent ──
const msgOp = op();
phone.sendFrame({ t: "req", id: 9001, method: "POST", path: `/api/v1/threads/${th.id}/messages`, body: { text: ASK }, client_op_id: msgOp });
await until(() => count("SELECT COUNT(*) AS n FROM inbox WHERE lane = ?", th.lane) === 1, 5000, "the message in the inbox");
phone.ws.terminate(); await phone.closed;
phone = await auth(peer, hubKey.publicB64u, phoneKey);
ok((await settle(phone)) === "open", "phone: socket cut after sending, connected again");
const again = await phone.req("POST", `/api/v1/threads/${th.id}/messages`, { text: ASK }, { client_op_id: msgOp });
ok(again.status === 200 && count("SELECT COUNT(*) AS n FROM inbox WHERE lane = ?", th.lane) === 1, `…resent with the same op id: input #${MessageRes.parse(again.body).input.id} again, one row`);
await until(() => evs(desk).some((e) => e.entity === "item" && (e.data as any)?.body?.text === REPLY), 20_000, "the reply on the desktop");
await new Promise((r) => setTimeout(r, 500));
ok(count("SELECT COUNT(*) AS n FROM run_items WHERE lane = ? AND kind = 'assistant'", th.lane) === 1 && count("SELECT COUNT(*) AS n FROM runs WHERE lane = ?", th.lane) === 1,
  "…one run, one reply");

// ── 5 the same card from Feishu and the phone at the same moment ──
const spec = (n: number): ApprovalSpec => ({
  kind: "send", title: `发给 ${PEER_CHAT}`, draft: `第${n}稿：周三下午三点可以`, channel: "feishu", target: { chat: PEER_CHAT }, as_identity: "user",
  origin_lane: "triage", trigger: { chat: PEER_CHAT, msg_id: `om_smkw3trig${n}`, ts: Date.now() },
});
const status = (id: number) => db.one<{ s: string; by: string | null }>("SELECT status AS s, decided_by AS by FROM approvals WHERE id = ?", id)!;
const sends = (id: number) => count("SELECT COUNT(*) AS n FROM outbox WHERE approval_id = ? AND kind = 'text'", id);
let races = 0, feishuWon = 0, phoneWon = 0;
for (let i = 1; i <= 6; i++) {
  const id = submitApproval(db, spec(i));
  db.run("UPDATE approvals SET cards_json = ? WHERE id = ?", JSON.stringify([{ channel: "feishu", chat: ADMIN, msg_id: `om_smkw3card${i}` }]), id);
  const choice = i % 2 ? "approve" : "reject";
  const click = () => f!.onCard({ kind: "card", eventId: `ev_smkw3_${i}`, operatorId: OWNER, messageId: `om_smkw3card${i}`, chatId: ADMIN, value: { k: "appr", id, o: "approve", v: 1 } } as any);
  // odd rounds: the click right as the phone's request leaves; even rounds: a few ms later, about when it arrives
  const pending = phone.req("POST", `/api/v1/approvals/${id}/decide`, { action: choice, draft_version: 1 }, { client_op_id: op() });
  if (i % 2) click(); else setTimeout(click, 3);
  const res = await pending;
  await until(() => count("SELECT COUNT(*) AS n FROM inbox WHERE source_msg_id = ? AND status != 'received'", `ev_smkw3_${i}`) === 1, 5000, "the click handled");
  const st = status(id);
  const phoneFirst = res.status === 200;
  if (phoneFirst) phoneWon++; else feishuWon++;
  const okOne = phoneFirst
    ? st.by === `device:${phoneKey.id}` && st.s === (choice === "approve" ? "approved" : "rejected")
    : res.status === 409 && Conflict.parse(res.body).approval?.status === st.s && st.by === "feishu";
  const want = st.s === "approved" ? 1 : 0;
  await until(() => sawEv(desk, "approval", String(id), (d) => d?.status === st.s), 5000, "the desktop sees the decision");
  const card = db.all<{ payload: string }>("SELECT payload FROM outbox WHERE kind = 'card' AND json_extract(target_json, '$.replace') = ?", `om_smkw3card${i}`);
  if (okOne && sends(id) === want && card.length === 1 && JSON.parse(card[0]!.payload).status === st.s) races++;
}
ok(races === 6, `6 races Feishu vs phone on one card: each time exactly one decision (${phoneWon} phone, ${feishuWon} Feishu), at most one send, the Feishu card and the desktop show the winner`);

// ── 6 a draft edited on the phone; the desktop's stale copy ──
const ed = submitApproval(db, spec(7));
const e1 = await phone.req("PUT", `/api/v1/approvals/${ed}/draft`, { text: "周三下午四点可以", draft_version: 1 }, { client_op_id: op() });
ok(e1.status === 200 && ApprovalRes.parse(e1.body).approval.draft_version === 2, "phone edited the draft (version 2)");
const stale = await desk.req("PUT", `/api/v1/approvals/${ed}/draft`, { text: "周四也行", draft_version: 1 }, { client_op_id: op() });
ok(stale.status === 409 && Conflict.parse(stale.body).approval?.draft === "周三下午四点可以", "desktop's save on version 1: 409 with the phone's text");
const staleDecide = await desk.req("POST", `/api/v1/approvals/${ed}/decide`, { action: "approve", draft_version: 1 }, { client_op_id: op() });
ok(staleDecide.status === 409 && status(ed).s === "pending", "desktop's approve on version 1: 409, nothing decided");

// ── 7 approve, the answer lost, resent ──
const decOp = op();
phone.sendFrame({ t: "req", id: 9002, method: "POST", path: `/api/v1/approvals/${ed}/decide`, body: { action: "approve", draft_version: 2 }, client_op_id: decOp });
await until(() => status(ed).s !== "pending", 5000, "decided");
phone.ws.terminate(); await phone.closed;
phone = await auth(peer, hubKey.publicB64u, phoneKey);
ok((await settle(phone)) === "open", "phone: socket cut after approving, connected again");
const dec = await phone.req("POST", `/api/v1/approvals/${ed}/decide`, { action: "approve", draft_version: 2 }, { client_op_id: decOp });
ok(dec.status === 200 && ApprovalRes.parse(dec.body).approval.status === "approved" && sends(ed) === 1, "…resent: the stored 200, still one send");
ok(db.one<{ p: string }>("SELECT payload AS p FROM outbox WHERE approval_id = ? AND kind = 'text'", ed)!.p === "周三下午四点可以", "…and what goes out is exactly the edited, approved text");

// ── 8 personal stays personal ──
const pt = ThreadRes.parse((await phone.req("POST", "/api/v1/threads", { title: "体检预约", domain: "personal" }, { client_op_id: op() })).body).thread;
await phone.req("POST", `/api/v1/threads/${pt.id}/messages`, { text: "虚构的体检时间想换到周五" }, { client_op_id: op() });
ok(db.one<{ d: string }>("SELECT domain AS d FROM messages WHERE lane = ?", pt.lane)?.d === "personal", "a personal thread's line is stored personal");
submitApproval(db, { kind: "plan", title: "改体检时间", draft: "周五上午", origin_lane: pt.lane } as ApprovalSpec);
const o0 = count("SELECT COUNT(*) AS n FROM outbox");
f!.onMessage({ kind: "message", eventId: "", messageId: "om_smkw3adm0001", chatId: ADMIN, chatType: "group", operatorId: OWNER, senderType: "user",
  messageType: "text", content: JSON.stringify({ text: "/approvals" }), createTime: Date.now() } as any, "event");
await until(() => count("SELECT COUNT(*) AS n FROM outbox WHERE id > ? AND payload LIKE '%等你批的%'", o0) > 0, 10_000, "the /approvals reply");
const list = db.one<{ p: string }>("SELECT payload AS p FROM outbox WHERE id > ? AND payload LIKE '%等你批的%'", o0)!.p;
ok(!list.includes("体检") && list.includes("私人的一条"), "admin chat /approvals (by code): the personal card is one line, no title");

// ── 9 the admin socket still removes ──
const rmOut: string[] = [];
ok(await cli(["devices", "rm", deskKey.id.slice(0, 8)], (x) => rmOut.push(x), () => {}) === 0 && (await desk.closed).code === 4410, `sbot devices rm: ${rmOut.join(" ")}; the desktop's channel closed 4410`);

phone.close();
await hub.close();
relay.kill("SIGTERM");
await llm.close();
ok(true, "hub and relay stopped");
process.exit(0);
