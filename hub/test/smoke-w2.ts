// W2 acceptance smoke (09 「W2」 验收) on a fresh home: hub/test/test-home.sh hub/test/smoke-w2.ts <port>.
// The relay (relay/src/main.ts) as its own process on 127.0.0.1:<port>, a WS tap in front of it (ws-tap.ts) that
// records every byte it is handed on both sides, the hub booted with console.yaml relay on (ws:// loopback), Feishu in
// shadow mode with dummy credentials, a fake LLM upstream that types one character per event, a real local node for
// the tool. Devices are hub/test/fake-device.ts (protocol/ only, what the App does; the App's own state machine runs
// the same walk in clients/app/test/e2e.test.ts). Walks:
//   three ways to a pairing code (sbot pair · Feishu /pair in my DM · POST /api/v1/devices/invites on hub-admin.sock),
//   each paired through the relay · my DM → the reply streams to a device piece by piece, a tool starts and ends live ·
//   five drops (clean close, cut socket, relay restart) with lines coming in between: nothing missing, nothing twice ·
//   another hub key can't connect (unknown, wrong Noise key, impostor hub) · replayed handshake + auth / pair, and a
//   replayed message inside a channel · a node: 403 on approve, glance, message, self · 20 at once, measured ·
//   removal (sbot devices rm, Feishu /devices rm) closes within 1 s · the relay saw no plaintext.
// Loopback only; fictional data; nothing installed. Prints steps and numbers; exits non-zero on the first failure.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocket } from "ws";
import { fakeLlm, fakeModelsYaml, FAKE_KEY, type Step } from "./fake-llm.ts";
import { DeviceKey, auth, openChannel, pair, settle, type Channel } from "./fake-device.ts";
import { startTap } from "./ws-tap.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { finishInitiator, generateNoiseKeyPair, respond, startInitiator } from "../../protocol/noise/channel.ts";
import { CLOSE_HUB_OFFLINE, DATA, OPEN, decodeEnvelope, encodeEnvelope } from "../../protocol/envelope.ts";
import { b64u, decodePairCode, type PairCode } from "../../protocol/pair.ts";
import type { Frame } from "../../protocol/frames.ts";
import { InviteRes } from "../../protocol/api/devices.ts";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { adminRequest } from "../src/admin-socket.ts";
import { run as cli } from "../src/cli.ts";
import { setAdminSink } from "../src/notify.ts";
import { setQuiet } from "../src/log.ts";
import { channelHost } from "../src/channels/host.ts";
import { channel } from "../src/channels/registry.ts";
import type { FeishuChannel } from "../src/channels/feishu/plugin.ts";
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
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]!; };
const ms = (x: number) => `${x.toFixed(1)} ms`;

setQuiet(true);
useCrypto({ aead: nodeAead, dh: nodeDh });
const PORT = Number(process.env.SBOT_PORT ?? 7829);
const OWNER = "ou_smkw2owner0001", ADMIN = "oc_smkw2admin0001", DM = "oc_smkw2dm0000001";
const DM_TEXT = "帮我看一下样稿第二版放哪了";
const FIRST = "我看一下。";
const REPLY = "样稿第二版在共享目录的秋季文件夹里，一共十二页，封面换成了浅灰色。";
const CMD = "sleep 1; echo 秋季样稿第二版";

// ── the fake upstream: my DM → a short text and the tool; the tool's result → the reply, typed out ──
const lastUser = (b: any): string => JSON.stringify((b.messages ?? []).filter((m: { role: string }) => m.role === "user").slice(-1));
const llm = await fakeLlm((b): Step => {
  const u = lastUser(b);
  if (u.includes("tool_result")) return { text: REPLY, pace: 40 };
  if (u.includes("样稿第二版")) return { tool: { name: "bash", input: { cmd: CMD } }, text: FIRST, pace: 40 };
  return { text: "好。" };
});

// ── the home ──
const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);
mkdirSync(h.config, { recursive: true });
const hubKey = loadOrCreateHubKey(h.keys);
const token = randomBytes(24).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");
const OTHER_PK = b64u(generateNoiseKeyPair().publicKey);   // listed in relay.yaml; only the impostor registers it
const relayConf = join(h.root, "relay.yaml");
writeFileSync(relayConf, [
  `listen: { host: 127.0.0.1, port: ${PORT} }`,
  "hubs:",
  `  - { hub_pk: "${hubKey.publicB64u}", token_hash: "${tokenHash}" }`,
  `  - { hub_pk: "${OTHER_PK}", token_hash: "${tokenHash}" }`,
  // this walk opens a lot of sessions from one loopback address and fails auth on purpose
  "limits: { conn_per_min: 100000, auth_fail_max: 100000 }",
  "",
].join("\n"));
const relayLog: string[] = [];
let relay: ChildProcess;
async function startRelay() {
  const from = relayLog.length;
  relay = spawn(process.execPath, [join(import.meta.dirname, "../../relay/src/main.ts")], { env: { PATH: process.env.PATH ?? "", RELAY_CONFIG: relayConf }, stdio: ["ignore", "pipe", "pipe"] });
  relay.stdout!.on("data", (d: Buffer) => relayLog.push(...d.toString().split("\n").filter(Boolean)));
  relay.stderr!.on("data", (d: Buffer) => relayLog.push(`stderr: ${d.toString()}`));
  await until(() => relayLog.slice(from).some((l) => l.includes('"ev":"listening"')), 10_000, "relay listening");
}
async function stopRelay() { relay.kill("SIGTERM"); await new Promise((r) => relay.once("exit", r)); }
await startRelay();
const listening = JSON.parse(relayLog.find((l) => l.includes('"ev":"listening"'))!);
ok(listening.host === "127.0.0.1" && listening.port === PORT, `relay (its own process) on 127.0.0.1:${PORT} only`);
const tap = await startTap(() => PORT);

const cfg: Record<string, string> = {
  "console.yaml": `relay:\n  enabled: true\n  url: ws://127.0.0.1:${tap.port}/v1/hub\n`,
  "models.yaml": fakeModelsYaml(llm.port),
  "channels.yaml": `feishu:\n  mode: shadow\n  admin_chat: ${ADMIN}\n`,
  "people.yaml": `owner:\n  name: 小测\n  ids:\n    feishu: ${OWNER}\n`,
  "groups.yaml": "reviewed: true\n",
};
for (const [f, t] of Object.entries(cfg)) writeFileSync(join(h.config, f), t);
writeFileSync(h.secrets, `RELAY_TOKEN=${token}\nFAKE_KEY=${FAKE_KEY}\nFEISHU_APP_ID=cli_smkw2fake0001\nFEISHU_APP_SECRET=smoke-w2-fake-secret-0000\n`, { mode: 0o600 });
// the observer's user identity: a lark-cli that is logged in nowhere
const lark = join(h.root, "fake-lark-cli");
writeFileSync(lark, `#!/bin/sh\ncase "$1 $2" in "auth status") echo '{"identities":{}}' ;; *) echo '{"data":{}}' ;; esac\n`, { mode: 0o755 });
process.env.SBOT_LARK_CLI = lark;

const hub = await boot(h, { proxyPort: 0 });
const db = hub.db;
const notices: string[] = [];
setAdminSink((t) => { notices.push(t); });
await until(() => hub.link.relay?.connected === true, 10_000, "hub registered");
ok(true, "hub registered with the relay through the tap (console.yaml relay.enabled, ws:// loopback)");
const f = channel("feishu") as FeishuChannel | undefined;
ok(f?.state() === "shadow", "feishu plugin up in shadow mode with dummy credentials");
const work = join(h.root, "work");
mkdirSync(work, { recursive: true });
const node = spawn(process.execPath, [join(import.meta.dirname, "../../node/src/main.ts")], { env: { ...process.env, SBOT_LOG: "off", SBOT_NODE_CWD: work }, stdio: "ignore" });
await hub.node.waitConnected(15_000);
ok(hub.node.connected(), "local node connected over hub.sock (for the tool)");

const peer = `ws://127.0.0.1:${tap.port}/v1/peer`;
const names: string[] = [], secrets: string[] = [];
const keep = (c: PairCode) => { secrets.push(c.secret); return c; };
let dmN = 0;
const dm = (text: string) => f!.onMessage({ kind: "message", eventId: "", messageId: `om_smkw2dm${String(++dmN).padStart(4, "0")}`, chatId: DM, chatType: "p2p",
  operatorId: OWNER, senderType: "user", messageType: "text", content: JSON.stringify({ text }), createTime: Date.now() }, "event");
const outbox = () => db.all<{ id: number; payload: string; channel: string; status: string }>("SELECT id, payload, channel, status FROM outbox ORDER BY id");
const linkIn = (s: string) => /sstudiobot:\/\/pair#\S+/.exec(s)?.[0];
const paired = async (code: PairCode, name: string, key = new DeviceKey()) => {
  names.push(name);
  const t0 = performance.now();
  const ch = await pair(code, key, name);
  const st = await settle(ch);
  return { key, ch, st, ms: performance.now() - t0 };
};

// ── 1 three ways to a code, each paired through the relay ──
const out: string[] = [];
ok(await cli(["pair"], (x) => out.push(x), () => {}) === 0, "sbot pair (over hub-admin.sock) printed a code");
const cliCode = keep(decodePairCode(linkIn(out.join("\n"))!));
ok(cliCode.relay === peer && cliCode.hub_pk === hubKey.publicB64u && cliCode.role === "client", "its code: the relay's /v1/peer, this hub's key, role client");
const phone = await paired(cliCode, "冒烟手机甲");
ok(phone.st === "open", `paired through the relay with the sbot pair code (${ms(phone.ms)})`);
ok(notices.some((n) => n.includes("新设备配上了") && n.includes("冒烟手机甲")), "new-device notice to the admin outlet");

const n0 = outbox().length;
dm("/pair");
await until(() => outbox().slice(n0).some((r) => !!linkIn(r.payload)), 10_000, "Feishu /pair reply");
const fsRow = outbox().slice(n0).find((r) => !!linkIn(r.payload))!;
ok(fsRow.channel === "feishu" && fsRow.payload.includes("飞书的服务器"), `Feishu /pair in my DM → command row → reply with a code (outbox #${fsRow.id}, shadow: logged, not sent)`);
ok(!llm.seen.some((s) => JSON.stringify(s.body).includes("/pair")), "…answered by code, the model never saw it");
const fsCode = keep(decodePairCode(linkIn(fsRow.payload)!));
const desk = await paired(fsCode, "冒烟桌面乙");
ok(desk.st === "open", `paired through the relay with the Feishu code (${ms(desk.ms)})`);
ok(db.one<{ by: string }>("SELECT created_by AS by FROM device_invites WHERE used_by = ?", desk.key.id)?.by === "channel:feishu", "its invite says created_by channel:feishu");

const inv = await adminRequest(h.run, "POST", "/api/v1/devices/invites", { role: "client" });
const apiCode = keep(decodePairCode(InviteRes.parse(inv.body).link));
const tablet = await paired(apiCode, "冒烟平板丙");
ok(inv.status === 200 && tablet.st === "open", `POST /api/v1/devices/invites (hub-admin.sock; over the relay too since W3a) → paired (${ms(tablet.ms)})`);
const viaRelay = await phone.ch.req("POST", "/api/v1/devices/invites", { role: "client" });
ok(viaRelay.status === 400, "the same route over the relay: since W3a it is there, and a write without client_op_id is 400");
ok((await settle(await pair(cliCode, new DeviceKey(), "拿用过的码"))) !== "open", "a used code: refused");
phone.ch.close(); desk.ch.close(); tablet.ch.close();
await Promise.all([phone.ch.closed, desk.ch.closed, tablet.ch.closed]);

// ── 2 my DM streams to a connected device; the tool starts and ends live ──
const evs = (c: Channel) => c.frames.flatMap((fr, i) => (fr.t === "ev" ? [{ ...fr, at: c.at[i]! }] : []));
const cursorOf = (c: Channel, after: number) => Math.max(after, ...c.frames.flatMap((fr) => (fr.t === "ev" || fr.t === "beat" ? [fr.seq] : [])));
const watch = await auth(peer, hubKey.publicB64u, phone.key);
ok((await settle(watch)) === "open", "the phone reconnects with auth (no pairing again)");
const boot0 = await watch.req("POST", "/api/v1/bootstrap", {});
ok(boot0.status === 200 && typeof boot0.body.seq === "number", `bootstrap over the relay (seq ${boot0.body.seq}, ${boot0.body.threads.length} threads)`);
ok((await watch.req("POST", "/api/v1/stream", { after: boot0.body.seq })).status === 200, "stream open");
const t0 = performance.now();
dm(DM_TEXT);
await until(() => evs(watch).some((e) => e.entity === "input" && (e.data as { text?: string })?.text === DM_TEXT), 5000, "my line as an ev");
const tIn = evs(watch).find((e) => e.entity === "input" && (e.data as { text?: string })?.text === DM_TEXT)!.at - t0;
ok(true, `my DM line reached the device in ${ms(tIn)}`);
type It = { kind: string; status: string; name: string | null; live_key: string | null; body: { text?: string } | null; run_id: string };
const items = () => evs(watch).filter((e) => e.entity === "item").map((e) => ({ ...(e.data as It), at: e.at }));
await until(() => items().some((i) => i.kind === "assistant" && i.body?.text === REPLY), 20_000, "the reply's row");
const runId = items().find((i) => i.body?.text === REPLY)!.run_id;
const deltas = watch.frames.flatMap((fr, i) => (fr.t === "delta" && fr.run === runId ? [{ ...fr, at: watch.at[i]! }] : []));
const byItem = (k: string) => deltas.filter((d) => d.item === k);
const a0 = byItem(`${runId}:a0`), a1 = byItem(`${runId}:a1`);
const row = items().find((i) => i.body?.text === REPLY)!;
ok(a1.length >= 8 && a1.map((d) => d.text).join("") === REPLY && a1.every((d, i) => d.chunk_seq === i + 1),
  `the reply came as ${a1.length} deltas in order (chunk_seq 1…${a1.length}), ${(REPLY.length / a1.length).toFixed(1)} characters each, joined = the finished row`);
const gaps = a1.slice(1).map((d, i) => d.at - a1[i]!.at);
ok(row.at - a1[0]!.at > 500 && row.live_key === `${runId}:a1`,
  `…live: first piece ${ms(row.at - a1[0]!.at)} before the row, gap between pieces p50 ${ms(pct(gaps, 0.5))} / max ${ms(Math.max(...gaps))}`);
ok(a0.map((d) => d.text).join("") === FIRST, `the text before the tool streamed too (${a0.length} deltas)`);
const tool = items().filter((i) => i.kind === "tool" && i.name === "bash");
const tRun = tool.find((i) => i.status === "running"), tDone = tool.find((i) => i.status === "done");
ok(tRun && tDone && tDone.at - tRun.at > 800 && tRun.at < a1[0]!.at,
  `tool bash: an ev at start (running) and ${ms(tDone!.at - tRun!.at)} later at the end (done), before the reply streamed`);
await until(() => evs(watch).some((e) => e.entity === "run" && e.id === runId && (e.data as { status?: string })?.status === "done"), 5000, "run done ev");
ok(outbox().some((r) => r.payload === REPLY && r.channel === "feishu"), "the same reply went to my Feishu DM (shadow: outbox, not sent)");
watch.close(); await watch.closed;

// ── 3 five drops with lines coming in between: nothing missing, nothing twice ──
const LANE = "console:t:th_smkw2rc01";
const host = channelHost(db);
let sayN = 0;
const said: string[] = [];
const say = (text: string) => { said.push(text); host.ingest({ lane: LANE, kind: "user", source: "smoke", source_msg_id: `w2rc_${++sayN}`, payload: { text, owner: true } }); };
let cursor = cursorOf(watch, boot0.body.seq);
const seen = new Map<string, number>();   // entity\0id\0seq → times seen, across all connections
const gotText = new Set<string>();
let late = 0, unordered = 0;
const absorb = (c: Channel, after: number) => {
  let last = after;
  for (const e of evs(c)) {
    if (e.seq <= after) late++;
    if (e.seq <= last) unordered++;
    last = e.seq;
    const k = `${e.entity}\0${e.id}\0${e.seq}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    const t = (e.data as { text?: string } | undefined)?.text;
    if (e.entity === "input" && t) gotText.add(t);
  }
};
const drops = ["clean close", "socket cut", "relay restart", "clean close", "socket cut"];
const conTimes: number[] = [];
for (let i = 0; i < drops.length; i++) {
  const c0 = performance.now();
  const c = await auth(peer, hubKey.publicB64u, phone.key);
  if ((await settle(c, 8000)) !== "open") ok(false, `reconnect ${i + 1}`);
  const after = cursor;
  if ((await c.req("POST", "/api/v1/stream", { after })).status !== 200) ok(false, `stream ${i + 1}`);
  conTimes.push(performance.now() - c0);
  const live = `第${i + 1}轮连着时说的`;
  say(live);
  await until(() => [...said].every((s) => evs(c).some((e) => e.entity === "input" && (e.data as { text?: string })?.text === s) || gotText.has(s)), 8000, `round ${i + 1} caught up`);
  await new Promise((r) => setTimeout(r, 150));   // let the run it starts show up too, so the next one resumes mid-traffic
  absorb(c, after);
  cursor = cursorOf(c, after);
  if (drops[i] === "clean close") { c.close(); await c.closed; }
  else if (drops[i] === "socket cut") { c.ws.terminate(); await c.closed; }
  else {
    await stopRelay();
    await c.closed;
    await until(() => hub.link.relay?.connected === false, 5000, "hub noticed the relay is gone");
    say(`第${i + 1}轮中继没了时说的`);
    await startRelay();
    await until(() => hub.link.relay?.connected === true, 15_000, "hub re-registered");
  }
  say(`第${i + 1}轮断着时说的甲`);
  say(`第${i + 1}轮断着时说的乙`);
}
const last = await auth(peer, hubKey.publicB64u, phone.key);
ok((await settle(last, 8000)) === "open", "connected again after the fifth drop");
await last.req("POST", "/api/v1/stream", { after: cursor });
await until(() => said.every((s) => gotText.has(s) || evs(last).some((e) => e.entity === "input" && (e.data as { text?: string })?.text === s)), 8000, "the last lines");
await new Promise((r) => setTimeout(r, 300));
absorb(last, cursor);
const dbInputs = db.all<{ id: number }>("SELECT id FROM inbox WHERE lane = ?", LANE).map((r) => String(r.id));
const evInputs = new Set([...seen.keys()].filter((k) => k.startsWith("input\0")).map((k) => k.split("\0")[1]!));
const twice = [...seen.values()].filter((n) => n > 1).length;
ok(said.every((s) => gotText.has(s)) && dbInputs.every((id) => evInputs.has(id)),
  `5 drops (${drops.join(", ")}): all ${said.length} lines arrived, every inbox row of the lane seen (${dbInputs.length})`);
ok(twice === 0 && late === 0 && unordered === 0, `…none twice (${seen.size} distinct evs), none at or below the seq it resumed from, in seq order on each connection`);
ok(true, `reconnect → auth → stream: p50 ${ms(pct(conTimes, 0.5))}, max ${ms(Math.max(...conTimes))}`);
last.close(); await last.closed;

// ── 4 another hub key can't connect ──
const nobody = { ...cliCode, hub_pk: b64u(generateNoiseKeyPair().publicKey) };
let code404 = 0;
try { await openChannel(peer, nobody.hub_pk, { role: "client", purpose: "auth" }); } catch (e) { code404 = (e as { code?: number }).code ?? -1; }
ok(code404 === CLOSE_HUB_OFFLINE, `a code with another hub key: the relay has no such hub (${code404})`);
{
  // routed to our hub, but trusting another key: our hub can't read message 1
  const ws = new WebSocket(`${peer}?hub=${hubKey.publicB64u}`);
  const { message } = startInitiator(Buffer.from(nobody.hub_pk, "base64url"), { v: 1, role: "client", purpose: "auth" });
  const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
  ws.on("open", () => ws.send(message));
  ok((await closed) === 4401, "a device trusting another key, routed to our hub: 4401");
}
{
  // an impostor that holds a relay token under another key, and a device steered to it: the handshake can't finish
  const imp = generateNoiseKeyPair();
  const fake = new WebSocket(`ws://127.0.0.1:${PORT}/v1/hub`, { headers: { authorization: `Bearer ${token}`, "x-sbot-hub": OTHER_PK } });
  let impFailed = 0;
  fake.on("message", (d: Buffer) => {
    const env = decodeEnvelope(d);
    if (env?.type !== DATA) return;
    try { respond(imp, env.payload, () => ({ v: 1, challenge: b64u(randomBytes(32)), hub_time: 0 })); } catch { impFailed++; }
    fake.send(encodeEnvelope(DATA, env.sid, randomBytes(96)));
  });
  await new Promise<void>((r) => fake.on("open", () => r()));
  const steered = new WebSocket(`ws://127.0.0.1:${PORT}/v1/peer?hub=${OTHER_PK}`);
  const { hs, message: m1 } = startInitiator(Buffer.from(hubKey.publicB64u, "base64url"), { v: 1, role: "client", purpose: "auth" });
  const answer = await new Promise<Buffer>((r) => { steered.on("open", () => steered.send(m1)); steered.on("message", (d: Buffer) => r(d)); });
  let devFailed = false;
  try { finishInitiator(hs, new Uint8Array(answer)); } catch { devFailed = true; }
  ok(devFailed && impFailed >= 1, "an impostor hub the relay steers a device to: can't read message 1, its answer fails on the device");
  steered.terminate(); fake.close();
}

// ── 5 replays ──
const rawReplay = async (msgs: Buffer[]): Promise<number> => {
  const ws = new WebSocket(`${peer}?hub=${hubKey.publicB64u}`);
  const closed = new Promise<number>((r) => ws.on("close", (c) => r(c)));
  const answered = new Promise<void>((r) => ws.once("message", () => r()));
  await new Promise<void>((r) => ws.on("open", () => r()));
  ws.send(msgs[0]!);
  await answered;   // the hub answers a replayed message 1 with a fresh ephemeral key and challenge …
  for (const m of msgs.slice(1)) ws.send(m);
  return closed;    // … so what was encrypted for the old channel doesn't open
};
const good = await auth(peer, hubKey.publicB64u, phone.key);
ok((await settle(good)) === "open", "a good auth session, recorded");
ok((await rawReplay([good.wire[0]!, good.wire[2]!])) === 4401, "its message 1 + auth replayed on a new connection: 4401");
const n = good.wire.length;
await good.req("GET", "/api/v1/status");
good.raw(good.wire[n]!);
ok((await good.closed).code === 4400, "a request replayed inside the open channel: 4400 (nonce order)");
const pk2 = new DeviceKey();
const p2 = await paired(keep(decodePairCode(InviteRes.parse((await adminRequest(h.run, "POST", "/api/v1/devices/invites", { role: "client" })).body).link)), "冒烟重放丁", pk2);
ok(p2.st === "open", "a good pairing session, recorded");
p2.ch.close();
const devs0 = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices")!.n;
ok((await rawReplay([p2.ch.wire[0]!, p2.ch.wire[2]!])) === 4401 && db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices")!.n === devs0,
  "its message 1 + pair replayed: 4401, no device written");

// ── 6 a node: 403 on approve, glance, message, self ──
const n1 = outbox().length;
dm("/pair node");
await until(() => outbox().slice(n1).some((r) => !!linkIn(r.payload)), 10_000, "Feishu /pair node reply");
const nodeCode = keep(decodePairCode(linkIn(outbox().slice(n1).find((r) => !!linkIn(r.payload))!.payload)!));
ok(nodeCode.role === "node", "Feishu /pair node gives a node code");
const nd = await paired(nodeCode, "冒烟节点戊");
ok(nd.st === "open", "a node paired through the relay with that code");
const denied = await Promise.all([
  nd.ch.req("POST", "/api/v1/approvals/1/decide", { decision: "approve" }),
  nd.ch.req("POST", "/api/v1/glances/1/answer", { answer: "好" }),
  nd.ch.req("POST", "/api/v1/threads/th_smkw2rc01/messages", { text: "以我名义发一句" }),
  nd.ch.req("GET", "/api/v1/self/rhythm.md"),
]);
ok(denied.every((r) => r.status === 403), `node: ${denied.map((r) => r.status).join(" ")} on approve, glance, message, self`);
nd.ch.close();

// ── 7 20 at once ──
const N = 20, ROUNDS = 10;
const keys = Array.from({ length: N }, () => new DeviceKey());
const codes = await Promise.all(keys.map(async () => keep(decodePairCode(InviteRes.parse((await adminRequest(h.run, "POST", "/api/v1/devices/invites", { role: "client" })).body).link))));
const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
const rss0 = process.memoryUsage().rss;
const pairT = await Promise.all(keys.map((k, i) => paired(codes[i]!, `冒烟并发-${i}`, k)));
ok(pairT.every((p) => p.st === "open"), `${N} paired at once: per device p50 ${ms(pct(pairT.map((p) => p.ms), 0.5))} / p95 ${ms(pct(pairT.map((p) => p.ms), 0.95))}`);
for (const p of pairT) p.ch.close();
await Promise.all(pairT.map((p) => p.ch.closed));
const authT: number[] = [];
const chans = await Promise.all(keys.map(async (k) => {
  const s = performance.now();
  const c = await auth(peer, hubKey.publicB64u, k);
  const st = await settle(c, 10_000);
  const b = await c.req("POST", "/api/v1/bootstrap", {}, 10_000);
  await c.req("POST", "/api/v1/stream", { after: b.body.seq }, 10_000);
  authT.push(performance.now() - s);
  return st === "open" ? c : null;
}));
ok(chans.every(Boolean), `${N} reconnect at once (auth + bootstrap + stream): p50 ${ms(pct(authT, 0.5))} / p95 ${ms(pct(authT, 0.95))} / max ${ms(Math.max(...authT))}`);
const live = chans as Channel[];
const rtt: number[] = [];
const r0 = performance.now();
await Promise.all(live.map(async (c) => { for (let i = 0; i < ROUNDS; i++) { const s = performance.now(); await c.req("GET", "/api/v1/threads", undefined, 10_000); rtt.push(performance.now() - s); } }));
const tReq = performance.now() - r0;
ok(rtt.length === N * ROUNDS, `${N * ROUNDS} requests (GET threads) in ${tReq.toFixed(0)} ms: p50 ${ms(pct(rtt, 0.5))} / p95 ${ms(pct(rtt, 0.95))} / max ${ms(Math.max(...rtt))}`);
const f0 = performance.now();
const marks = live.map((c) => c.frames.length);
say("二十台都该看到这句");
await until(() => live.every((c, i) => c.frames.slice(marks[i]).some((fr) => fr.t === "ev" && fr.entity === "input" && (fr.data as { text?: string })?.text === "二十台都该看到这句")), 5000, "fan-out");
const fan = live.map((c, i) => c.at[marks[i]! + c.frames.slice(marks[i]).findIndex((fr) => fr.t === "ev" && fr.entity === "input" && (fr.data as { text?: string })?.text === "二十台都该看到这句")]! - f0);
loop.disable();
ok(true, `one new line to ${N} streams: p50 ${ms(pct(fan, 0.5))} / max ${ms(Math.max(...fan))}; event-loop delay p99 ${ms(loop.percentile(99) / 1e6)}, max ${ms(loop.max / 1e6)}; ` +
  `rss +${((process.memoryUsage().rss - rss0) / 1048576).toFixed(1)} MiB (hub, node link and ${N} test devices in one process)`);
for (const c of live) c.close();

// ── 8 removal closes within 1 s ──
const twoA = await auth(peer, hubKey.publicB64u, tablet.key), twoB = await auth(peer, hubKey.publicB64u, tablet.key);
ok((await settle(twoA)) === "open" && (await settle(twoB)) === "open", "the tablet on two channels");
const rm0 = Date.now();
const rmOut: string[] = [];
ok(await cli(["devices", "rm", tablet.key.id.slice(0, 8)], (x) => rmOut.push(x), () => {}) === 0, `sbot devices rm: ${rmOut.join(" ")}`);
const [ca, cb] = await Promise.all([twoA.closed, twoB.closed]);
const rmMs = Math.max(twoA.closedAt, twoB.closedAt) - rm0;
ok(ca.code === 4410 && cb.code === 4410 && rmMs < 1000, `…both channels closed 4410 in ${rmMs} ms`);
ok((await settle(await auth(peer, hubKey.publicB64u, tablet.key))) !== "open", "…and it can't come back");
const dk = await auth(peer, hubKey.publicB64u, desk.key);
ok((await settle(dk)) === "open", "the desktop connected");
const fr0 = Date.now();
dm(`/devices rm ${desk.key.id.slice(0, 8)}`);
const dc = await dk.closed;
ok(dc.code === 4410 && dk.closedAt - fr0 < 1000, `Feishu /devices rm in my DM: closed 4410 ${dk.closedAt - fr0} ms after the message came in`);
await until(() => outbox().some((r) => r.payload.includes("删了「冒烟桌面乙」")), 5000, "the /devices rm reply");
ok(db.one<{ by: string }>("SELECT removed_by AS by FROM devices WHERE id = ?", desk.key.id)?.by === "channel:feishu", "…removed_by channel:feishu, reply in my DM");

// ── 9 what the relay saw ──
const needles = ['"t":', "/api/v1", "device_id", "public_key", "sbot-auth", "sbot-pair", DM_TEXT, FIRST, REPLY, "sleep 1", "秋季样稿", "二十台都该看到这句", "第1轮", ...names, ...secrets];
const leak = (side: "hub" | "peer", b: Buffer): string | undefined => {
  const env = side === "hub" ? decodeEnvelope(b) : null;
  if (env?.type === OPEN) return undefined;   // the relay's own metadata (masked IP)
  const body = env ? Buffer.from(env.payload) : b;
  const text = body.toString("utf8"), latin = body.toString("latin1");
  return needles.find((x) => text.includes(x) || latin.includes(x));
};
ok(leak("hub", Buffer.from(encodeEnvelope(DATA, 1, new TextEncoder().encode(`{"t":"res","body":"${REPLY}"}`)))) !== undefined && leak("peer", Buffer.from(REPLY)) !== undefined,
  "the check finds plaintext when it is there");
const hubSide = tap.wire.filter(([s]) => s === "hub").length, peerSide = tap.wire.length - hubSide;
const bytes = tap.wire.reduce((a, [, b]) => a + b.length, 0);
const leaks = tap.wire.map(([s, b]) => leak(s, b)).filter(Boolean);
ok(leaks.length === 0, `the tap recorded ${tap.wire.length} messages (${hubSide} hub side, ${peerSide} device side, ${(bytes / 1024).toFixed(0)} KiB): none carries any of ${needles.length} known plaintexts`);
const rlog = relayLog.join("\n");
ok(!needles.some((x) => rlog.includes(x)) && !rlog.includes(token) && rlog.includes("127.0.0.0/24"), "relay log: metadata only, masked IPs");
const hubSecret = readFileSync(join(h.keys, "hub.key"), "utf8").split(":")[1]!.trim();
ok(!rlog.includes(hubSecret) && !tap.wire.some(([, b]) => b.toString("latin1").includes(hubSecret)), "the hub's private key is nowhere on the wire or in the relay log");

await hub.close();
node.kill("SIGTERM");
await tap.close();
await stopRelay();
await llm.close();
ok(true, "hub, node, tap and relay stopped");
process.exit(0);
