#!/usr/bin/env node
// `sbot` (03 「cli」). Talks to the running hub over hub-admin.sock. Exit codes: 0 ok, 1 failed, 2 bad arguments,
// 3 not built yet (the wave that brings it is named).
//
// ※ `restore` is the one command that does not go through the socket: it runs with the hub stopped (it replaces the
// DB under it), and it refuses when a hub answers on the socket.
import { home } from "./home.ts";
import { adminRequest } from "./admin-socket.ts";
import { BackupError, restore } from "./backup.ts";

export type Cmd =
  | { cmd: "status" }
  | { cmd: "restore"; file: string; identity: string; force: boolean }
  | { cmd: "later"; name: string; wave: string }
  | { cmd: "help" };

export class Usage extends Error {}

const USAGE = `sbot <命令>
  status                                    版本、提交、协议、数据库版本
  restore <文件> --identity <私钥文件> [--force]  从备份恢复到 $SBOT_HOME（hub 要先停）
  pair [--node] · devices [rm <id>]          W2
  chat                                      W3
  upgrade --ref <sha>                       W4
  import ...                                W6`;

const LATER: Record<string, string> = { pair: "W2", devices: "W2", chat: "W3", upgrade: "W4", import: "W6" };

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
    if (rest.some((a) => a !== "--node")) throw new Usage("pair 只认 --node");
  } else if (cmd === "devices") {
    if (rest.length && !(rest[0] === "rm" && rest.length === 2)) throw new Usage("devices 或 devices rm <id>");
  } else if (cmd === "upgrade") {
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
          `主公钥    ${s.hub_key_fingerprint ?? "还没有（W2）"}`,
          `启动于    ${new Date(Number(s.started_at)).toISOString()}`,
          `数据库    v${s.db_version}`,
        ].join("\n"));
        return 0;
      } catch (e) { err(String((e as Error).message)); return 1; }
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
