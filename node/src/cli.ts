#!/usr/bin/env node
// sbot-node (05 cli.ts):
//   sbot-node pair '<链接>' [--name 名字]   pair this machine as a node through the relay (the link from 「加一台」)
//   sbot-node status                        what this machine has: pairing, agents, sessions
//   sbot-node mcp                           the sbot MCP over stdio (agents start it; not for people)
//   sbot-node [run]                         the daemon (the service runs this)
//   sbot-node selftest                      the upgrade's self-check: every module loads
// The device key is made here and stays here; only its public key goes to the hub (06). Nothing secret is printed.
import { hostname, platform } from "node:os";
import { writeFileSync } from "node:fs";
import { decodePairCode, fingerprintOf, fromB64u } from "../../protocol/pair.ts";
import { configDir, ensureDir, loadConf, stateDir } from "./config.ts";
import { connectRelay } from "./link.ts";
import { freshKey, keyStore, loadKey } from "./keys.ts";
import { hubJsonPath, main, readHubJson, type HubJson } from "./main.ts";

async function pair(args: string[], env = process.env): Promise<number> {
  const link = args.find((a) => !a.startsWith("--"));
  const ni = args.indexOf("--name");
  const name = (ni >= 0 ? args[ni + 1] : undefined) ?? hostname();
  if (!link) { process.stderr.write("用法：sbot-node pair '<链接>' [--name 名字]\n"); return 2; }
  let code;
  try { code = decodePairCode(link); } catch { process.stderr.write("这不是配对链接（要 sstudiobot://pair#v1. 开头，或 v1. 开头的码）\n"); return 2; }
  if (code.role !== "node") { process.stderr.write("这个链接是给客户端的，节点要用「加一台 → 节点」生成的链接\n"); return 2; }
  if (code.exp < Date.now()) process.stderr.write("链接看起来过期了，还是试一下（以主的时间为准）\n");
  const dir = ensureDir(configDir(env));
  const store = keyStore(dir, env);
  const signer = freshKey(store);   // a new pairing is a new device (06); saved only once the hub accepted
  let conn;
  try {
    conn = await connectRelay({ relay: code.relay, hubPk: code.hub_pk, signer, pair: { secret: code.secret, name, platform: platform() } }, async () => ({ status: 404 }));
  } catch (e) { process.stderr.write(`连不上中继或主：${String((e as Error)?.message ?? e).slice(0, 200)}\n`); return 1; }
  // the hub answers a request only once it accepted the pairing; a refusal closes the channel
  const ok = await Promise.race([
    conn.peer.request("POST", "/node/v1/status", { sessions: [], quotas: {} }, 15_000).then(() => true, () => false),
    conn.done.then(() => false),
  ]);
  conn.peer.close();
  if (!ok) { process.stderr.write("主没接受这次配对（链接用过了、过期了，或被撤销）；原来的配对没动\n"); return 1; }
  signer.save();
  const hub: HubJson = { hub_pk: code.hub_pk, relay: code.relay, device_id: signer.deviceId, paired_at: Date.now() };
  writeFileSync(hubJsonPath(dir), JSON.stringify(hub, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(`配好了。设备 ${signer.deviceId.slice(0, 12)}，主的指纹 ${fingerprintOf(fromB64u(code.hub_pk)).slice(0, 16)}。\n启动节点服务（deploy/node/install.sh 装的服务，或 sbot-node run）。\n`);
  return 0;
}

async function status(env = process.env): Promise<number> {
  const { detect } = await import("./adapters/index.ts");
  const hub = readHubJson(configDir(env));
  const key = loadKey(keyStore(configDir(env), env));
  const lines = [
    `配置：${configDir(env)}`,
    `状态：${stateDir(env)}`,
    hub ? `配对：主指纹 ${fingerprintOf(fromB64u(hub.hub_pk)).slice(0, 16)}，中继 ${hub.relay}，设备 ${hub.device_id.slice(0, 12)}` : "配对：还没有（本机节点不用配）",
    `设备密钥：${key ? "在" : "没有"}`,
    `agent：${detect(loadConf(configDir(env)), stateDir(env)).map((a) => `${a.kind}${a.version ? ` ${a.version}` : ""}`).join("、") || "一个都没找到"}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
  // 1 = not paired (install.sh prints the pair hint); a local node (SBOT_NODE_SOCK / SBOT_HOME) needs no pairing
  return hub || env.SBOT_NODE_SOCK || env.SBOT_HOME ? 0 : 1;
}

async function selftest(): Promise<number> {
  await Promise.all(["./main.ts", "./sessions.ts", "./mcp.ts", "./git.ts", "./upgrade.ts", "./adapters/index.ts", "./adapters/claude.ts", "./adapters/codex.ts", "./adapters/pi.ts", "./adapters/acp.ts"].map((m) => import(m)));
  process.stdout.write("selftest ok\n");
  return 0;
}

export async function cli(argv = process.argv.slice(2)): Promise<number | undefined> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "pair": return pair(rest);
    case "status": return status();
    case "selftest": return selftest();
    case "mcp": { const { runMcp } = await import("./mcp.ts"); await runMcp(); return 0; }
    case undefined: case "run": await main(); return undefined;
    default: process.stderr.write("用法：sbot-node pair '<链接>' | status | run\n"); return 2;
  }
}

if (import.meta.main) {
  const code = await cli();
  if (code !== undefined) process.exit(code);
}
