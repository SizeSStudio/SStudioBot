// W2a smoke on a fresh home (hub/test/test-home.sh hub/test/smoke-w2a.ts <port>): the relay on 127.0.0.1:<port>
// (SBOT_PORT) as its own process, the hub registered with it (its LLM proxy on a free port), then a fake device does
// what the App will: pair with a code from hub-admin.sock, reconnect with auth, get 403 as a node on /api/v1, get cut
// within 1 s when removed; 20 devices at once, measured. Loopback only; fictional data; nothing installed.
// Prints steps and numbers; exits non-zero on the first failure.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { home } from "../src/home.ts";
import { boot } from "../src/main.ts";
import { adminRequest } from "../src/admin-socket.ts";
import { run } from "../src/cli.ts";
import { setAdminSink } from "../src/notify.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { decodePairCode } from "../../protocol/pair.ts";
import { InviteRes } from "../../protocol/api/devices.ts";
import { loadOrCreateHubKey } from "../src/link/keys.ts";
import { DeviceKey, auth, pair, settle } from "./fake-device.ts";

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

useCrypto({ aead: nodeAead, dh: nodeDh });
const port = Number(process.env.SBOT_PORT ?? 7830);
const h = home();
ok(!existsSync(h.db), `fresh home ${h.root}`);
mkdirSync(h.config, { recursive: true });

// relay.yaml in the home, listing this hub's key with a throwaway token
const hubKey = loadOrCreateHubKey(h.keys);
const token = randomBytes(24).toString("base64url");
const relayConf = join(h.root, "relay.yaml");
writeFileSync(relayConf, `listen: { host: 127.0.0.1, port: ${port} }\nhubs:\n  - { hub_pk: "${hubKey.publicB64u}", token_hash: "${createHash("sha256").update(token).digest("hex")}" }\n` +
  "limits: { conn_per_min: 1000 }\n");
const relayLog: string[] = [];
const relay = spawn(process.execPath, [join(import.meta.dirname, "../../relay/src/main.ts")], { env: { PATH: process.env.PATH ?? "", RELAY_CONFIG: relayConf }, stdio: ["ignore", "pipe", "pipe"] });
relay.stdout.on("data", (d: Buffer) => relayLog.push(...d.toString().split("\n").filter(Boolean)));
relay.stderr.on("data", (d: Buffer) => relayLog.push(`stderr: ${d.toString()}`));
await until(() => relayLog.some((l) => l.includes('"ev":"listening"')), 10_000, "relay listening");
const listening = JSON.parse(relayLog.find((l) => l.includes('"ev":"listening"'))!);
ok(listening.host === "127.0.0.1" && listening.port === port, `relay listening on 127.0.0.1:${port} only`);
ok((await fetch(`http://127.0.0.1:${port}/healthz`)).status === 200, "relay /healthz");

writeFileSync(join(h.config, "console.yaml"), `relay:\n  enabled: true\n  url: ws://127.0.0.1:${port}/v1/hub\n`);
writeFileSync(h.secrets, `RELAY_TOKEN=${token}\n`, { mode: 0o600 });
const hub = await boot(h, { proxyPort: 0 });
const notices: string[] = [];
setAdminSink((t) => { notices.push(t); });
await until(() => hub.link.relay?.connected === true, 10_000, "hub registered with the relay");
ok(true, "hub registered with the relay");

const out: string[] = [];
await run(["status"], (x) => out.push(x), () => {});
ok(out.join("\n").includes("开，已连上"), "sbot status: relay on, connected");
ok(!out.join("\n").includes(readFileSync(join(h.keys, "hub.key"), "utf8").split(":")[1]!.trim()), "sbot status never shows the key");

const invite = async (role: "client" | "node" = "client") => {
  const r = await adminRequest(h.run, "POST", "/api/v1/devices/invites", { role });
  return decodePairCode(InviteRes.parse(r.body).link);
};
const phone = new DeviceKey();
const code = await invite();
ok(code.relay === `ws://127.0.0.1:${port}/v1/peer`, "pairing code carries the relay's peer URL and the hub key");
const ch = await pair(code, phone, "冒烟手机");
ok((await settle(ch)) === "open", "paired through the relay");
ok(notices.some((n) => n.includes("新设备配上了")), "new-device notice");
ok((await settle(await pair(code, new DeviceKey()))) !== "open", "the same code twice: refused");
ch.close(); await ch.closed;
const again = await auth(code.relay, code.hub_pk, phone);
ok((await settle(again)) === "open", "reconnected with auth");

const nodeKey = new DeviceKey();
const nodeCh = await pair(await invite("node"), nodeKey, "冒烟节点");
ok((await settle(nodeCh)) === "open", "a node paired");
const denied = await Promise.all(["/api/v1/approvals/a1/decide", "/api/v1/glances/g1/answer", "/api/v1/threads/t1/messages", "/api/v1/self/x"]
  .map((p) => nodeCh.req(p.includes("self") ? "GET" : "POST", p, p.includes("self") ? undefined : {})));
ok(denied.every((r) => r.status === 403), "node: 403 on approve, glance, message, self");
nodeCh.close();

const t0 = Date.now();
const rm = await adminRequest(h.run, "DELETE", `/api/v1/devices/${phone.id.slice(0, 8)}`);
const closed = await again.closed;
ok(rm.status === 200 && closed.code === 4410 && again.closedAt - t0 < 1000, `removed: channel closed in ${again.closedAt - t0} ms (code ${closed.code})`);
ok((await settle(await auth(code.relay, code.hub_pk, phone))) !== "open", "the removed device can't come back");

// 20 at once
const N = 20, ROUNDS = 10;
const keys = Array.from({ length: N }, () => new DeviceKey());
const codes = await Promise.all(keys.map(() => invite()));
const loop = monitorEventLoopDelay({ resolution: 5 }); loop.enable();
const rss0 = process.memoryUsage().rss;
const p0 = performance.now();
const chans = await Promise.all(keys.map((k, i) => pair(codes[i]!, k, `冒烟并发-${i}`)));
const states = await Promise.all(chans.map((c) => settle(c, 10_000)));
const tPair = performance.now() - p0;
ok(states.every((s) => s === "open"), `${N} devices paired at once in ${tPair.toFixed(0)} ms`);
const rtt: number[] = [];
const r0 = performance.now();
await Promise.all(chans.map(async (c) => { for (let i = 0; i < ROUNDS; i++) { const s = performance.now(); await c.req("GET", "/api/v1/devices", undefined, 10_000); rtt.push(performance.now() - s); } }));
const tReq = performance.now() - r0;
loop.disable();
rtt.sort((a, b) => a - b);
const q = (p: number) => rtt[Math.min(rtt.length - 1, Math.floor(p * rtt.length))]!.toFixed(1);
ok(rtt.length === N * ROUNDS, `${N * ROUNDS} requests in ${tReq.toFixed(0)} ms: rtt p50 ${q(0.5)} / p95 ${q(0.95)} / max ${q(1)} ms; ` +
  `event-loop delay p99 ${(loop.percentile(99) / 1e6).toFixed(1)} ms; rss +${((process.memoryUsage().rss - rss0) / 1048576).toFixed(1)} MiB (hub + test devices, one process)`);
for (const c of chans) c.close();

const log = relayLog.join("\n");
ok(!log.includes("冒烟") && !log.includes("/api/v1") && !log.includes(token), "relay log: metadata only (no names, paths, token)");
ok(log.includes('"ev":"peer_open"') && log.includes("127.0.0.0/24"), "relay log: masked IPs");

await hub.close();
relay.kill("SIGTERM");
await new Promise((r) => relay.once("exit", r));
ok(true, "hub and relay stopped");
process.exit(0);
