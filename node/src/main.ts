// The node daemon (05 main.ts). W1d: the local node only — connect to the hub's hub.sock, say hello, serve exec / fs,
// reconnect with 1, 2, 5, 10, 30 s backoff (same steps as the relay link, 03). Sessions, adapters, MCP, upgrade: W2+.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { PROTOCOL } from "../../protocol/version.ts";
import type { Hello } from "../../protocol/node/hello.ts";
import { connectOnce, type Logger } from "./link.ts";

const BACKOFF = [1, 2, 5, 10, 30];

export function sockPath(env = process.env): string {
  if (env.SBOT_NODE_SOCK) return env.SBOT_NODE_SOCK;
  if (platform() === "win32") return "\\\\.\\pipe\\sbot-hub";
  if (!env.SBOT_HOME) throw new Error("set SBOT_NODE_SOCK or SBOT_HOME");
  return join(resolve(env.SBOT_HOME), "node", "hub.sock");
}

function sha(): string {
  const f = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "REVISION");
  return existsSync(f) ? (readFileSync(f, "utf8").split("\n")[0] ?? "dev").trim() : "dev";
}

/** Where commands run and relative paths point when the hub names no directory: SBOT_NODE_CWD, else this account's home. */
export const defaultCwd = (env = process.env) => resolve(env.SBOT_NODE_CWD || homedir());

export const helloOf = (): Hello => ({ version: PROTOCOL.current, sha: sha(), os: platform(), agents: [], capabilities: {}, quotas: {}, cwd: defaultCwd() });

const log: Logger = (msg, fields = {}) => {
  if (process.env.SBOT_LOG === "off") return;
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), mod: "node", msg, ...fields }) + "\n");
};

export async function runNode(path = sockPath(), stop = { now: false }) {
  for (let i = 0; !stop.now; i++) {
    const t0 = Date.now();
    await connectOnce(path, helloOf(), log);
    if (stop.now) return;
    if (Date.now() - t0 > 60_000) i = 0;   // it was up a while: start the backoff over
    await new Promise((r) => setTimeout(r, BACKOFF[Math.min(i, BACKOFF.length - 1)]! * 1000));
  }
}

if (import.meta.main) {
  const stop = { now: false };
  const quit = () => { stop.now = true; process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  await runNode(sockPath(), stop);
}
