// Nodes as the hub sees them (03 「tasks 和 nodes」, 05): who is connected, what they said in hello, and the one way
// to send a node a request. The `nodes` row holds the state (04 §4); identity is in `devices` (the local node, id
// `local`, has none: it never pairs). sha, target_sha, upgrade_failed live in extra_json ※ (04 has no columns).
//   hello  → upsert the row, answer target_sha (= the hub's sha: a different one makes the node upgrade itself, 05),
//            the tools its sessions' sbot MCP gets, accepts_work (protocol ≥ min), my git logins
//   gone   → offline; the engine moves that node's tasks to waiting_node
// Every request down is single-shot; the node keeps no timers (§底4.1).
import type { Req, Res } from "../../../protocol/frames.ts";
import { PROTOCOL } from "../../../protocol/version.ts";
import { Hello, type HelloRes } from "../../../protocol/node/hello.ts";
import { NodeStatus } from "../../../protocol/node/v1.ts";
import type { Db } from "../db/db.ts";
import type { NodePeer } from "../link/session.ts";
import type { Out } from "../api/index.ts";
import { peopleConf } from "../config/load.ts";
import * as notify from "../notify.ts";
import { log } from "../log.ts";
import { redact } from "../tools/redact.ts";

/** Default wait for a node's answer; opening a session starts an agent and gets longer (engine.ts). */
export const NODE_TIMEOUT_MS = 30_000;

export class NodeOffline extends Error {}

/** people.yaml owner.ids keys that are git platforms ※; the node gets them as `<platform>:<login>`. */
const GIT_PLATFORMS = ["github", "gitlab", "gitea", "codeberg"];

export function ownerGit(): string[] {
  const ids = (peopleConf().owner?.ids ?? {}) as Record<string, unknown>;
  return GIT_PLATFORMS.flatMap((p) => (typeof ids[p] === "string" && ids[p] ? [`${p}:${ids[p]}`] : []));
}

export interface RegistryDeps {
  db: Db;
  hubSha: () => string;
  /** the sbot MCP tools for node sessions (engine.ts nodeTools) */
  tools: () => NonNullable<HelloRes["tools"]>;
}

const parseJson = (v: unknown): Record<string, unknown> => {
  try { const o = typeof v === "string" ? JSON.parse(v) : null; return o && typeof o === "object" ? o : {}; } catch { return {}; }
};

export class NodeRegistry {
  readonly #d: RegistryDeps;
  readonly #peers = new Map<string, NodePeer>();
  /** the last hello of each connected node (agents, cwd, protocol) */
  readonly #hellos = new Map<string, Hello>();
  /** the engine's hooks; called after the hello's answer is on its way */
  onReconcile: (device: string, hello: Hello) => void = () => {};
  onOnline: (device: string, hello: Hello) => void = () => {};
  onOffline: (device: string) => void = () => {};

  constructor(d: RegistryDeps) { this.#d = d; }

  online(device: string) { return this.#peers.has(device); }
  helloOf(device: string): Hello | undefined { return this.#hellos.get(device); }
  /** protocol ≥ min: an older node only upgrades, it gets no work (03) */
  acceptsWork(device: string) { const h = this.#hellos.get(device); return !!h && h.version >= PROTOCOL.min; }
  /** a node the hub has heard of (it said hello once) */
  known(device: string) { return this.#peers.has(device) || !!this.#d.db.one("SELECT 1 FROM nodes WHERE device_id = ?", device); }
  /**
   * 03 task_start: no node given → default_node (no such config key yet) → the hub's own machine (`local`), which may
   * be offline: then the task waits for it. Never another machine on its own (派到别处要我点名或配).
   */
  defaultNode(): string { return "local"; }

  hello(device: string, body: unknown, peer: NodePeer | undefined): Out {
    const h = Hello.safeParse(body);
    if (!h.success) return { status: 400, body: { error: "bad hello" } };
    if (!peer) return { status: 400, body: { error: "hello needs a connection the hub can answer on" } };
    const hello = h.data, db = this.#d.db, now = Date.now(), target = this.#d.hubSha();
    const accepts = hello.version >= PROTOCOL.min;
    db.tx(() => {
      const prev = db.one<{ extra_json: string | null }>("SELECT extra_json FROM nodes WHERE device_id = ?", device);
      const extra = { ...parseJson(prev?.extra_json), sha: hello.sha, target_sha: target } as Record<string, unknown>;
      if (hello.upgrade) extra.upgrade_failed = hello.upgrade.ok ? null : { from: hello.upgrade.from, to: hello.upgrade.to, error: hello.upgrade.error ? redact(hello.upgrade.error).slice(0, 500) : null, at: now };
      db.run(
        `INSERT INTO nodes(device_id, os, version, caps_json, agents_json, quota_json, max_parallel, status, status_at, extra_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(device_id) DO UPDATE SET os = excluded.os, version = excluded.version, caps_json = excluded.caps_json,
           agents_json = excluded.agents_json, quota_json = excluded.quota_json, max_parallel = excluded.max_parallel,
           status = excluded.status, status_at = excluded.status_at, extra_json = excluded.extra_json`,
        device, hello.os, hello.app_version ?? null, JSON.stringify(hello.capabilities), JSON.stringify(hello.agents),
        JSON.stringify(hello.quotas), hello.max_parallel ?? null, accepts ? "online" : "outdated", now, JSON.stringify(extra),
      );
      db.emit("node", device);
    });
    // a newer connection of the same node replaces the older one (it reconnected)
    this.#peers.set(device, peer);
    this.#hellos.set(device, hello);
    log("nodes", "hello", { node: device.slice(0, 8), os: hello.os, sha: hello.sha.slice(0, 12), accepts });
    if (hello.upgrade && !hello.upgrade.ok) {
      // the error text is the node's: untrusted, redacted, cut
      void notify.admin(redact(`节点「${this.name(device)}」升级到 ${hello.upgrade.to.slice(0, 12)} 失败，已退回 ${hello.upgrade.from.slice(0, 12)}${hello.upgrade.error ? `：${hello.upgrade.error.slice(0, 200)}` : ""}`));
    }
    // statuses against hello.sessions now, before any session can be opened on this connection (else a task opened
    // in between would look lost); the sends wait until the hello's answer is on its way
    try { this.onReconcile(device, hello); } catch (e) { log("nodes", "reconcile failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); }
    setImmediate(() => { try { this.onOnline(device, hello); } catch (e) { log("nodes", "onOnline failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); } });
    const res: HelloRes = {
      target_sha: target, min_version: PROTOCOL.min, accepts_work: accepts, owner_git: ownerGit(),
      ...(accepts ? { tools: this.#d.tools() } : {}),
    };
    return { status: 200, body: res };
  }

  /** POST /node/v1/status: quotas and draining between heartbeats. */
  status(device: string, body: unknown): Out {
    const s = NodeStatus.safeParse(body);
    if (!s.success) return { status: 400, body: { error: "bad status" } };
    const db = this.#d.db;
    db.tx(() => {
      const cur = db.one<{ status: string; quota_json: string | null }>("SELECT status, quota_json FROM nodes WHERE device_id = ?", device);
      if (!cur) return;
      const status = cur.status === "outdated" ? "outdated" : s.data.state === "draining" ? "draining" : "online";
      const quota = JSON.stringify(s.data.quotas);
      if (status === cur.status && quota === cur.quota_json) return;
      db.run("UPDATE nodes SET status = ?, status_at = ?, quota_json = ? WHERE device_id = ?", status, Date.now(), quota, device);
      db.emit("node", device);
    });
    return { status: 200, body: {} };
  }

  /** The node's connection ended. `peer`: only if it is still the current one (a reconnect may have replaced it). */
  gone(device: string, peer?: NodePeer) {
    if (!this.#peers.has(device) || (peer && this.#peers.get(device) !== peer)) return;
    this.#peers.delete(device);
    this.#hellos.delete(device);
    const db = this.#d.db;
    db.tx(() => {
      db.run("UPDATE nodes SET status = 'offline', status_at = ? WHERE device_id = ?", Date.now(), device);
      db.emit("node", device);
    });
    log("nodes", "offline", { node: device.slice(0, 8) });
    try { this.onOffline(device); } catch (e) { log("nodes", "onOffline failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }

  /** One request down. Rejects with NodeOffline when the node isn't connected (the caller retries later). */
  async request(device: string, method: Req["method"], path: string, body: unknown, timeoutMs = NODE_TIMEOUT_MS): Promise<Res> {
    const p = this.#peers.get(device);
    if (!p) throw new NodeOffline(`节点「${this.name(device)}」没连着`);
    try { return await p.request(method, path, body, { timeoutMs }); }
    catch (e) { throw this.#peers.get(device) === p ? e : new NodeOffline(String((e as Error)?.message ?? e)); }
  }

  /** How I'd call it in a notice: its device name, 本机 for the local node. */
  name(device: string): string {
    if (device === "local") return "本机";
    return this.#d.db.one<{ name: string }>("SELECT name FROM devices WHERE id = ?", device)?.name ?? device.slice(0, 8);
  }
}
