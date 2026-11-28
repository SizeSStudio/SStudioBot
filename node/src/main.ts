// The node daemon (05 main.ts): connect to the hub (local hub.sock, or the relay with this device's key), say hello
// with the agents, capabilities and the sessions it still holds, serve the hub's requests, reconnect with 1, 2, 5,
// 10, 30 s backoff (03). A removed or unknown device (4410 / 4401) stops: it has to be paired again.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { PROTOCOL } from "../../protocol/version.ts";
import { CLOSE_AUTH, CLOSE_REMOVED } from "../../protocol/pair.ts";
import { Exec, FsRead, FsWrite, HelloRes, type Hello } from "../../protocol/node/hello.ts";
import { GitChecks, TaskEventsRes, WorktreeCleanup } from "../../protocol/node/v1.ts";
import type { Req } from "../../protocol/frames.ts";
import { configDir, ensureDir, loadConf, stateDir } from "./config.ts";
import { detect, type Found } from "./adapters/index.ts";
import { readFile, runExec, writeFile } from "./exec.ts";
import { connectLocal, connectRelay, type Conn, type Logger } from "./link.ts";
import { keyStore, loadKey } from "./keys.ts";
import { ctlPath, serveCtl, type Tool } from "./mcp.ts";
import type { Peer } from "./peer.ts";
import { Sessions } from "./sessions.ts";
import { prChecks, removeWorktree } from "./git.ts";
import * as up from "./upgrade.ts";

const BACKOFF = [1, 2, 5, 10, 30];
const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, "cli.ts");

export function sockPath(env = process.env): string {
  if (env.SBOT_NODE_SOCK) return env.SBOT_NODE_SOCK;
  if (platform() === "win32") return "\\\\.\\pipe\\sbot-hub";
  if (!env.SBOT_HOME) throw new Error("set SBOT_NODE_SOCK or SBOT_HOME");
  return join(resolve(env.SBOT_HOME), "node", "hub.sock");
}

export function sha(): string {
  const f = join(HERE, "..", "..", "REVISION");
  return existsSync(f) ? (readFileSync(f, "utf8").split("\n")[0] ?? "dev").trim() : "dev";
}

const appVersion = (): string | undefined => { try { return JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8")).version; } catch { return undefined; } };

/** Where commands run and relative paths point when the hub names no directory: SBOT_NODE_CWD, else this account's home. */
export const defaultCwd = (env = process.env) => resolve(env.SBOT_NODE_CWD || homedir());

/** hello without sessions or agents (the W1d shape; the daemon adds the rest). */
export const helloOf = (): Hello => ({ version: PROTOCOL.current, sha: sha(), os: platform(), agents: [], capabilities: {}, quotas: {}, cwd: defaultCwd() });

export const log: Logger = (msg, fields = {}) => {
  if (process.env.SBOT_LOG === "off") return;
  process.stderr.write(JSON.stringify({ t: new Date().toISOString(), mod: "node", msg, ...fields }) + "\n");
};

/** The pairing on this machine (written by `sbot-node pair`): the hub's key and the relay. No secret in it. */
export type HubJson = { hub_pk: string; relay: string; device_id: string; paired_at: number };
export const hubJsonPath = (dir = configDir()) => join(dir, "hub.json");
export function readHubJson(dir = configDir()): HubJson | undefined {
  try { return JSON.parse(readFileSync(hubJsonPath(dir), "utf8")) as HubJson; } catch { return undefined; }
}

export type Target = { kind: "local"; path: string } | { kind: "remote"; hub: HubJson };

export function targetOf(env = process.env): Target {
  if (env.SBOT_NODE_SOCK || env.SBOT_HOME || platform() === "win32" && env.SBOT_NODE_LOCAL) return { kind: "local", path: sockPath(env) };
  const hub = readHubJson(configDir(env));
  if (!hub) throw new Error("还没配对：先跑 sbot-node pair '<链接>'（本机节点设 SBOT_HOME 或 SBOT_NODE_SOCK）");
  return { kind: "remote", hub };
}

/** stop.exit is set by runNode: stops the agents it started, then exits (SIGTERM). */
export type Stop = { now: boolean; exit?: (code: number) => Promise<void> };
export interface NodeOpts { target: Target; stop?: Stop; agents?: Found[]; env?: NodeJS.ProcessEnv }

/** The daemon. Resolves when stopped (or the device was removed: { removed: true }). */
export async function runNode(o: NodeOpts): Promise<{ removed?: boolean }> {
  const env = o.env ?? process.env;
  const stop: Stop = o.stop ?? { now: false };
  const local = o.target.kind === "local";
  const conf = loadConf(configDir(env));
  const state = ensureDir(stateDir(env));
  const agents = o.agents ?? detect(conf, state);
  const root = env.SBOT_NODE_ROOT ? up.layout(resolve(env.SBOT_NODE_ROOT)) : undefined;
  const me = sha();
  const boot = root ? up.startup(root, me) : {};
  if (boot.rollback) { log("upgrade trial failed: rolled back"); process.exit(up.EXIT_RESTART); }

  let peer: Peer | undefined;
  let tools: Tool[] = [];
  let helloOk = false;
  let upgrading = false;
  const skip = new Set<string>(root ? up.failedShas(root) : []);

  const request = async (method: "POST", path: string, body: unknown, timeoutMs?: number) => {
    if (!peer || peer.closed) throw new Error("和主的连接断了");
    const r = await peer.request(method, path, body, timeoutMs);
    return { status: r.status, body: r.body };
  };
  let statusTimer: NodeJS.Timeout | undefined;
  const sessions: Sessions = new Sessions({
    stateDir: state, agents, defaultCwd: defaultCwd(env),
    mcpCommand: { command: process.execPath, args: [CLI, "mcp"], ctl: ctlPath(state) },
    request, online: () => !!peer && !peer.closed && helloOk, helloTools: () => tools, log,
    onStatus: () => {
      statusTimer ??= setTimeout(() => {
        statusTimer = undefined;
        if (!peer || !helloOk) return;
        void request("POST", "/node/v1/status", { sessions: sessions.states(), quotas: sessions.quotas, state: sessions.draining ? "draining" : "online" }).catch(() => {});
      }, 200);
    },
  });
  const ctl = await serveCtl(ctlPath(state), {
    session: (key) => { const s = sessions.byKey(key); return s ? { task_id: s.task_id, attempt: s.attempt, tools: s.tools } : undefined; },
    helloTools: () => tools,
    async call(body) {
      const r = await request("POST", "/node/v1/tool-calls", body, 0);
      if (r.status !== 200) return { text: `error: ${String((r.body as { error?: string })?.error ?? r.status)}`, is_error: true };
      return r.body as { text: string; is_error?: boolean };
    },
  });

  const hello = (): Hello => ({
    ...helloOf(), sha: me, cwd: defaultCwd(env),
    agents: agents.map((a) => ({ kind: a.kind, ...(a.version ? { version: a.version } : {}) })),
    capabilities: sessions.caps(), quotas: sessions.quotas,
    ...(conf.max_parallel ? { max_parallel: conf.max_parallel } : {}),
    ...(appVersion() ? { app_version: appVersion()! } : {}),
    sessions: sessions.helloSessions(),
    ...(boot.report ? { upgrade: boot.report } : {}),
  });

  const serve = async (req: Req, signal: AbortSignal): Promise<{ status: number; body?: unknown }> => {
    const [path] = req.path.split("?", 1) as [string];
    const post = req.method === "POST";
    if (post && (path === "/node/v1/exec" || path === "/node/v1/fs/read" || path === "/node/v1/fs/write")) {
      // bash and files are the local node's only (05 ※): a remote node runs work through agents, never raw commands
      if (!local) return { status: 403, body: { error: "远端节点不收 exec / fs" } };
      if (path === "/node/v1/exec") {
        const x = Exec.safeParse(req.body);
        if (!x.success) return { status: 400, body: { error: "bad exec" } };
        return { status: 200, body: await runExec(x.data, (r) => { if (signal.aborted) r.kill(); else signal.addEventListener("abort", () => r.kill(), { once: true }); }) };
      }
      if (path === "/node/v1/fs/read") {
        const x = FsRead.safeParse(req.body);
        if (!x.success) return { status: 400, body: { error: "bad fs/read" } };
        return { status: 200, body: readFile(x.data.path, x.data.offset, x.data.len) };
      }
      const x = FsWrite.safeParse(req.body);
      if (!x.success) return { status: 400, body: { error: "bad fs/write" } };
      writeFile(x.data.path, x.data.data_b64, x.data.append);
      return { status: 200, body: {} };
    }
    if (post && path === "/node/v1/sessions") return sessions.open(req.body);
    const sm = /^\/node\/v1\/sessions\/([^/]+)(?:\/(turns|steer|interrupt))?$/.exec(path);
    if (sm) {
      const ref = decodeURIComponent(sm[1]!);
      if (req.method === "DELETE" && !sm[2]) return sessions.release(ref);
      if (post && sm[2] === "turns") return sessions.turn(ref, req.body);
      if (post && sm[2] === "steer") return sessions.steer(ref, req.body);
      if (post && sm[2] === "interrupt") return sessions.interrupt(ref);
    }
    const pm = /^\/node\/v1\/permissions\/([^/]+)$/.exec(path);
    if (post && pm) return sessions.answer(decodeURIComponent(pm[1]!), req.body);
    if (post && path === "/node/v1/git/checks") {
      const x = GitChecks.safeParse(req.body);
      if (!x.success) return { status: 400, body: { error: "bad git/checks" } };
      const cwd = x.data.repo && existsSync(x.data.repo) ? x.data.repo : defaultCwd(env);
      return { status: 200, body: await prChecks(x.data.pr, cwd) };
    }
    if (post && path === "/node/v1/worktrees/cleanup") {
      const x = WorktreeCleanup.safeParse(req.body);
      if (!x.success) return { status: 400, body: { error: "bad cleanup" } };
      return { status: 200, body: await removeWorktree(x.data.path) };
    }
    return { status: 404, body: { error: `no route ${req.method} ${path}` } };
  };

  async function maybeUpgrade(target: string) {
    if (!root || upgrading || target === me || skip.has(target) || !/^[0-9a-f]{40}$/.test(target)) return;
    upgrading = true;
    try {
      log("upgrade: preparing", { to: target.slice(0, 12) });
      await up.prepare(root, target);
      await sessions.drain(30 * 60_000);
      up.begin(root, me, target);
      log("upgrade: switching", { to: target.slice(0, 12) });
      await shutdown(up.EXIT_RESTART);
    } catch (e) {
      skip.add(target);
      sessions.draining = false;
      upgrading = false;
      log("upgrade failed, staying", { to: target.slice(0, 12), err: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  }

  async function shutdown(code: number) {
    stop.now = true;
    await sessions.closeAll();
    ctl.close();
    peer?.close();
    process.exit(code);
  }

  stop.exit = shutdown;

  if (boot.trial && root) {
    setTimeout(() => {
      if (helloOk) { up.passed(root); log("upgrade trial passed"); }
      else { up.failed(root, "新版本 30 秒内没连上主"); log("upgrade trial failed: no hub"); void shutdown(up.EXIT_RESTART); }
    }, up.TRIAL_MS).unref();
  }

  const signer = o.target.kind === "remote" ? loadKey(keyStore(configDir(env), env)) : undefined;
  if (o.target.kind === "remote" && !signer) throw new Error("没有设备密钥：重新配对（sbot-node pair）");

  let removed = false;
  for (let i = 0; !stop.now; i++) {
    const t0 = Date.now();
    let conn: Conn | undefined;
    try {
      conn = o.target.kind === "local"
        ? await connectLocal(o.target.path, serve)
        : await connectRelay({ relay: o.target.hub.relay, hubPk: o.target.hub.hub_pk, signer: signer! }, serve);
    } catch (e) {
      const code = (e as { code?: number }).code;
      if (code === CLOSE_AUTH || code === CLOSE_REMOVED) { removed = true; log("device refused by the hub: pair again", { code }); break; }
      log("connect failed", { err: String((e as Error)?.message ?? e).slice(0, 200) });
    }
    if (conn) {
      peer = conn.peer;
      try {
        const r = await conn.peer.request("POST", "/node/v1/hello", hello());
        const res = r.status === 200 ? HelloRes.safeParse(r.body) : undefined;
        if (res?.success) {
          helloOk = true;
          tools = res.data.tools ?? [];
          if (boot.report && root) { up.reported(root); delete boot.report; }
          sessions.reconnected(async (task, body) => {
            const x = await conn!.peer.request("POST", `/node/v1/tasks/${task}/events`, body);
            const b = x.status === 200 ? TaskEventsRes.safeParse(x.body) : undefined;
            return b?.success ? b.data : undefined;
          });
          log("hello ok", { agents: agents.map((a) => a.kind).join(","), sessions: sessions.helloSessions().length });
          if (res.data.accepts_work === false || res.data.target_sha !== me) void maybeUpgrade(res.data.target_sha);
        } else log("hello refused", { status: r.status });
      } catch (e) { log("hello failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); }
      const end = await conn.done;
      helloOk = false;
      peer = undefined;
      sessions.disconnected();
      if (end.code === CLOSE_AUTH || end.code === CLOSE_REMOVED) { removed = true; log("device refused by the hub: pair again", { code: end.code }); break; }
    }
    if (stop.now) break;
    if (Date.now() - t0 > 60_000) i = 0;   // it was up a while: start the backoff over
    await new Promise((r) => setTimeout(r, BACKOFF[Math.min(i, BACKOFF.length - 1)]! * 1000));
  }
  await sessions.closeAll();
  ctl.close();
  return removed ? { removed } : {};
}

export async function main(env = process.env) {
  const stop: Stop = { now: false };
  // the agents run in their own process groups: stop them before going (else they outlive the node)
  const quit = () => { stop.now = true; if (stop.exit) void stop.exit(0); else process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  const r = await runNode({ target: targetOf(env), stop, env });
  process.exit(r.removed ? 2 : 0);
}

if (import.meta.main) await main();
