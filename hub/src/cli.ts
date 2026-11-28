#!/usr/bin/env node
// `sbot` (03 「cli」). Talks to the running hub over hub-admin.sock. Exit codes: 0 ok, 1 failed, 2 bad arguments,
// 3 not built yet (the wave that brings it is named).
//
// ※ `restore` is the one command that does not go through the socket: it runs with the hub stopped (it replaces the
// DB under it), and it refuses when a hub answers on the socket.
import { home } from "./home.ts";
import { adminRequest } from "./admin-socket.ts";
import { BackupError, restore } from "./backup.ts";
import { renderUnicodeCompact } from "uqr";
import { shortFingerprint } from "./link/keys.ts";
import type { InviteRes } from "../../protocol/api/devices.ts";
import type { Device } from "../../protocol/api/entities.ts";

export type Cmd =
  | { cmd: "status" }
  | { cmd: "restore"; file: string; identity: string; force: boolean }
  | { cmd: "pair"; role: "client" | "node" }
  | { cmd: "devices" }
  | { cmd: "devices-rm"; id: string }
  | { cmd: "later"; name: string; wave: string }
  | { cmd: "help" };

export class Usage extends Error {}

const USAGE = `sbot <命令>
  status                                    版本、提交、协议、主公钥指纹、中继、数据库版本
  restore <文件> --identity <私钥文件> [--force]  从备份恢复到 $SBOT_HOME（hub 要先停）
  pair [--node]                             配对码（二维码 + 链接，10 分钟、用一次）
  devices [rm <id>]                         列出设备；删一台（id 前 6 位以上）
  chat                                      W3
  upgrade --ref <sha>                       W4
  import ...                                W6`;

const LATER: Record<string, string> = { chat: "W3", upgrade: "W4", import: "W6" };

export function parseArgs(argv: string[]): Cmd {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") return { cmd: "help" };
  if (cmd === "status") {
    if (rest.length) throw new Usage("status 不带参数");
    return { cmd: "status" };
  }
  if (cmd === "restore") {
    let file: string | undefined, identity: string | undefined, force = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--force") force = true;
      else if (a === "--identity" || a === "-i") { identity = rest[++i]; if (!identity) throw new Usage("--identity 后面要跟私钥文件"); }
      else if (a.startsWith("-")) throw new Usage(`不认识的选项 ${a}`);
      else if (file) throw new Usage("只能给一个备份文件");
      else file = a;
    }
    if (!file) throw new Usage("restore 要给备份文件");
    if (!identity) throw new Usage("restore 要 --identity <私钥文件>（age 私钥，AGE-SECRET-KEY-…）");
    return { cmd: "restore", file, identity, force };
  }
  if (cmd === "pair") {
    if (rest.length > 1 || rest.some((a) => a !== "--node")) throw new Usage("pair 只认 --node");
    return { cmd: "pair", role: rest.length ? "node" : "client" };
  }
  if (cmd === "devices") {
    if (!rest.length) return { cmd: "devices" };
    if (rest[0] === "rm" && rest.length === 2) return { cmd: "devices-rm", id: rest[1]! };
    throw new Usage("devices 或 devices rm <id>");
  }
  if (cmd === "upgrade") {
    if (rest[0] !== "--ref" || !rest[1] || rest.length !== 2) throw new Usage("upgrade --ref <sha>");
  } else if (cmd === "chat") {
    if (rest.length) throw new Usage("chat 不带参数");
  } else if (cmd !== "import") throw new Usage(`不认识的命令 ${cmd}`);
  return { cmd: "later", name: cmd, wave: LATER[cmd]! };
}

async function hubAnswers(runDir: string): Promise<boolean> {
  try { await adminRequest(runDir, "GET", "/api/v1/status"); return true; } catch { return false; }
}

type Print = (s: string) => unknown;

/** One request to the running hub; prints the hub's error and returns undefined on anything but 200. */
async function admin(err: Print, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  try {
    const r = await adminRequest(home().run, method, path, body);
    if (r.status === 200) return r.body;
    err((r.body as { error?: string })?.error ?? `hub 回了 ${r.status}`);
  } catch (e) { err(String((e as Error).message)); }
  return undefined;
}
export async function run(argv: string[], out: Print = (s) => process.stdout.write(s + "\n"), err: Print = (s) => process.stderr.write(s + "\n")): Promise<number> {
  let c: Cmd;
  try { c = parseArgs(argv); } catch (e) {
    if (!(e instanceof Usage)) throw e;
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  switch (c.cmd) {
    case "help": out(USAGE); return 0;
    case "later": err(`sbot ${c.name}: not yet (${c.wave})`); return 3;
    case "status": {
      try {
        const r = await adminRequest(home().run, "GET", "/api/v1/status");
        if (r.status !== 200) { err(`hub 回了 ${r.status}`); return 1; }
        const s = r.body as Record<string, any>;
        out([
          `版本      ${s.version}`,
          `提交      ${s.hub_sha}`,
          `协议      ${s.protocol?.current}（最低 ${s.protocol?.min}）`,
          `主公钥    ${s.hub_key_fingerprint ? shortFingerprint(s.hub_key_fingerprint) : "还没有"}`,
          ...(s.hub_pk ? [`          relay.yaml 的 hub_pk: ${s.hub_pk}（公钥，不是秘密）`] : []),
          `中继      ${!s.relay ? "?" : !s.relay.enabled ? "关（console.yaml relay.enabled）" : s.relay.connected ? "开，已连上" : "开，没连上"}`,
          `启动于    ${new Date(Number(s.started_at)).toISOString()}`,
          `数据库    v${s.db_version}`,
        ].join("\n"));
        return 0;
      } catch (e) { err(String((e as Error).message)); return 1; }
    }
    case "pair": {
      const r = await admin(err, "POST", "/api/v1/devices/invites", { role: c.role });
      if (!r) return 1;
      const inv = r as InviteRes;
      // the QR is the link itself; the link is a password for 10 minutes, so it goes to this terminal and nowhere else
      out(renderUnicodeCompact(inv.link, { border: 2 }));
      out(inv.link);
      out(`\n${c.role === "node" ? "节点：sbot-node pair '<链接>'。" : "用 App 扫码，或在 App 里粘贴链接。"}10 分钟内有效（到 ${new Date(inv.expires).toLocaleString()}），只能用一次。`);
      if (!inv.relay_enabled) out("注意：中继还没开（console.yaml relay.enabled），现在用这个码连不上。");
      return 0;
    }
    case "devices": {
      const r = await admin(err, "GET", "/api/v1/devices");
      if (!r) return 1;
      const list = (r as { devices: Device[] }).devices;
      if (!list.length) { out("还没有配对过的设备。sbot pair 出一个码。"); return 0; }
      out("id        名字（自称）            平台      角色    最近");
      for (const d of list) out(`${d.id.slice(0, 8)}  ${d.name.padEnd(20).slice(0, 20)}  ${(d.platform ?? "").padEnd(8)}  ${d.role.padEnd(6)}  ${d.last_seen ? new Date(d.last_seen).toLocaleString() : "没连过"}${d.last_ip_masked ? `  ${d.last_ip_masked}` : ""}`);
      return 0;
    }
    case "devices-rm": {
      const r = await admin(err, "DELETE", `/api/v1/devices/${encodeURIComponent(c.id.toLowerCase())}`);
      if (!r) return 1;
      const x = r as { id: string; name: string; channels: number; dropped: number; runs: number };
      out(`删了「${x.name}」（${x.id.slice(0, 8)}）：断开 ${x.channels} 条连接，作废 ${x.dropped} 条排队输入，停了 ${x.runs} 个 run。`);
      return 0;
    }
    case "restore": {
      const h = home();
      if (await hubAnswers(h.run)) { err("hub 还在跑。先停掉 hub 再恢复。"); return 1; }
      try {
        const r = await restore(c.file, c.identity, h, { force: c.force });
        out(`恢复好了：${r.day} 的备份，${r.parts} 个部分。${r.movedAside ? `原来的东西在 ${r.movedAside}。` : ""}`);
        return 0;
      } catch (e) {
        if (e instanceof BackupError) { err(e.message); return 1; }
        throw e;
      }
    }
  }
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
