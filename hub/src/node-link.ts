// The local node's link (03 link, 05): hub.sock in its own directory $SBOT_HOME/node/ (0750, group = the local node
// account's group from SBOT_NODE_GROUP, else the hub's own), the socket 0660. Not under run/: run/ is 0700 for the
// admin socket, and a node account that can't enter run/ couldn't reach a socket inside it whatever its mode.
// Connecting is `role: node`, device id `local`, no pairing (same machine, file permissions, veto 3).
// Requests go both ways on one connection: the node says hello and reports (W4: events, tool calls, permissions —
// all through the api dispatcher as device `local`, role `node`, so the one authorize() judges them too); the hub
// sends /node/v1/exec, fs/*, sessions, turns … down.
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { encodeFrame, parseFrame, type Req, type Res } from "../../protocol/frames.ts";
import { encodeLen, FrameReader } from "../../protocol/lenframe.ts";
import { PROTOCOL } from "../../protocol/version.ts";
import { ExecRes, FsReadRes, Hello, type HelloRes } from "../../protocol/node/hello.ts";
import type { NodeClient } from "./tools/registry.ts";
import { log } from "./log.ts";

export const nodeSocketPath = (nodeDir: string) =>
  process.env.SBOT_NODE_SOCK ?? (process.platform === "win32" ? "\\\\.\\pipe\\sbot-hub" : join(nodeDir, "hub.sock"));

/** A group name (from /etc/group) or a numeric gid. */
export function gidOf(group: string, groupFile = "/etc/group"): number {
  if (/^\d+$/.test(group)) return Number(group);
  for (const line of existsSync(groupFile) ? readFileSync(groupFile, "utf8").split("\n") : []) {
    const [name, , gid] = line.split(":");
    if (name === group && gid && /^\d+$/.test(gid)) return Number(gid);
  }
  throw new Error(`SBOT_NODE_GROUP=${group}: no such group`);
}

/**
 * $SBOT_HOME/node/: ours, 0750, group = the node account's (so it can enter and connect, nobody else can). Returns
 * the gid it set, if any. Changing a directory's group needs the hub's account to be in that group (deploy, 05).
 */
export function ensureNodeDir(dir: string, group = process.env.SBOT_NODE_GROUP): number | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  if (process.platform === "win32") return undefined;
  const st = statSync(dir);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${dir} is not owned by this account (uid ${st.uid}); refusing to put hub.sock there`);
  let gid: number | undefined;
  if (group) {
    gid = gidOf(group);
    try { chownSync(dir, st.uid, gid); } catch (e) { throw new Error(`can't give ${dir} to group ${group} (is the hub's account in it?): ${(e as Error).message}`); }
    // the node account also has to pass through $SBOT_HOME itself; say so instead of failing silently later
    const up = statSync(dirname(dir));
    if (!(up.gid === gid ? up.mode & 0o010 : up.mode & 0o001)) log("node-link", "the node group can't enter SBOT_HOME (needs g+x with that group, 05)", {});
  }
  chmodSync(dir, 0o750);
  return gid;
}

type Pending = { resolve: (r: Res) => void; reject: (e: Error) => void };
/** What main.ts plugs in: every `req` from the local node, as the caller `{ device_id: "local", role: "node" }`. */
export type LocalHandler = (req: Req, peer: { request: NodeLink["peerRequest"] }) => Promise<{ status: number; body?: unknown }>;

export class NodeLink implements NodeClient {
  #server: Server | undefined;
  #sock: Socket | undefined;
  #pending = new Map<number, Pending>();
  #next = 1;
  hello: Hello | undefined;
  readonly targetSha: string;
  /** set by main.ts (W4); without it only hello is served, as before */
  handle: LocalHandler | undefined;
  /** the node's connection ended (tasks/nodes.ts marks it offline) */
  onGone: (() => void) | undefined;

  constructor(targetSha: string) { this.targetSha = targetSha; }

  async listen(nodeDir: string): Promise<string> {
    const path = nodeSocketPath(nodeDir);
    const gid = process.env.SBOT_NODE_SOCK ? undefined : ensureNodeDir(nodeDir);
    if (process.platform !== "win32" && existsSync(path)) unlinkSync(path);
    this.#server = createServer((sock) => this.#accept(sock));
    await new Promise<void>((res, rej) => { this.#server!.once("error", rej); this.#server!.listen(path, () => { this.#server!.off("error", rej); res(); }); });
    if (process.platform !== "win32") {
      chmodSync(path, 0o660);
      if (gid !== undefined) chownSync(path, statSync(path).uid, gid);
    }
    log("node-link", "listening", { socket: "hub.sock" });
    return path;
  }

  connected() { return !!this.#sock && !this.#sock.destroyed && !!this.hello; }

  /** The node's own default directory, from its hello. */
  defaultCwd() { return this.connected() ? this.hello?.cwd : undefined; }

  /** Resolves once a node has said hello (tests, startup checks). */
  async waitConnected(ms = 10_000) {
    const end = Date.now() + ms;
    while (!this.connected()) { if (Date.now() > end) throw new Error("local node did not connect"); await new Promise((r) => setTimeout(r, 20)); }
  }

  #accept(sock: Socket) {
    // one local node; a newer connection replaces an older one (the node restarted)
    if (this.#sock && !this.#sock.destroyed) this.#sock.destroy();
    this.#sock = sock;
    this.hello = undefined;
    const r = new FrameReader();
    sock.on("data", (chunk) => {
      let texts: string[];
      try { texts = r.push(chunk); } catch { sock.destroy(); return; }
      for (const t of texts) {
        let f;
        try { f = parseFrame(t); } catch { sock.destroy(); return; }
        if (!f) continue;
        if (f.t === "res") { const p = this.#pending.get(f.id); if (p) { this.#pending.delete(f.id); p.resolve(f); } }
        else if (f.t === "req") void this.#serve(sock, f);
      }
    });
    const gone = () => {
      if (this.#sock !== sock) return;
      this.#sock = undefined;
      this.hello = undefined;
      for (const [id, p] of this.#pending) { this.#pending.delete(id); p.reject(new Error("本机节点断开了")); }
      log("node-link", "node disconnected");
      try { this.onGone?.(); } catch (e) { log("node-link", "onGone failed", { err: String((e as Error)?.message ?? e).slice(0, 200) }); }
    };
    sock.on("close", gone);
    sock.on("error", () => sock.destroy());
  }

  async #serve(sock: Socket, req: Req) {
    const reply = (status: number, body?: unknown) => { if (!sock.destroyed) sock.write(encodeLen(encodeFrame({ t: "res", id: req.id, status, ...(body === undefined ? {} : { body }) }))); };
    const isHello = req.method === "POST" && req.path === "/node/v1/hello";
    if (this.handle) {
      let out: { status: number; body?: unknown };
      try { out = await this.handle(req, { request: this.peerRequest }); }
      catch (e) { log("node-link", "handler failed", { path: req.path, err: String((e as Error)?.message ?? e).slice(0, 200) }); out = { status: 500, body: { error: "internal error" } }; }
      // exec/fs and defaultCwd() read the hello; only one this connection's handler accepted counts
      if (isHello && out.status === 200 && this.#sock === sock) this.hello = Hello.parse(req.body);
      return reply(out.status, out.body);
    }
    if (isHello) {
      const h = Hello.safeParse(req.body);
      if (!h.success) return reply(400, { error: "bad hello" });
      this.hello = h.data;
      log("node-link", "node hello", { os: h.data.os, sha: h.data.sha.slice(0, 12) });
      const res: HelloRes = { target_sha: this.targetSha, min_version: PROTOCOL.min };
      return reply(200, res);
    }
    reply(404, { error: `no route ${req.method} ${req.path}` });
  }

  /** One request down to the node. Aborting sends `cancel` (the node kills the process group) and rejects. */
  request(method: Req["method"], path: string, body: unknown, signal?: AbortSignal): Promise<Res> {
    const sock = this.#sock;
    if (!sock || sock.destroyed) return Promise.reject(new Error("本机节点没连上"));
    const id = this.#next++;
    return new Promise<Res>((resolve, reject) => {
      const onAbort = () => {
        if (!sock.destroyed) sock.write(encodeLen(encodeFrame({ t: "cancel", id })));
        this.#pending.delete(id);
        reject(new Error("已停下"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        resolve: (r) => { signal?.removeEventListener("abort", onAbort); resolve(r); },
        reject: (e) => { signal?.removeEventListener("abort", onAbort); reject(e); },
      });
      sock.write(encodeLen(encodeFrame({ t: "req", id, method, path, body })));
    });
  }

  /** The same request in tasks/nodes.ts's NodePeer shape (a timeout instead of only a signal). */
  peerRequest = (method: Req["method"], path: string, body: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Res> => {
    if (!o.timeoutMs) return this.request(method, path, body, o.signal);
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), o.timeoutMs);
    timer.unref();
    return this.request(method, path, body, ac.signal).catch((e) => { throw ac.signal.aborted && !o.signal?.aborted ? new Error("本机节点没回应") : e; })
      .finally(() => { clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort); });
  };

  async exec(o: { cmd: string; cwd: string; env?: Record<string, string>; stdin?: string }, signal?: AbortSignal) {
    const r = await this.request("POST", "/node/v1/exec", o, signal);
    if (r.status !== 200) throw new Error(`exec ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
    return ExecRes.parse(r.body);
  }

  async readFile(path: string, o: { offset?: number; len?: number } = {}) {
    const r = await this.request("POST", "/node/v1/fs/read", { path, ...o });
    if (r.status !== 200) throw new Error(`读不了 ${path}：${(r.body as { error?: string })?.error ?? r.status}`);
    const b = FsReadRes.parse(r.body);
    return { data: Buffer.from(b.data_b64, "base64"), total: b.total };
  }

  async writeFile(path: string, data: Buffer, append?: boolean) {
    const r = await this.request("POST", "/node/v1/fs/write", { path, data_b64: data.toString("base64"), ...(append ? { append } : {}) });
    if (r.status !== 200) throw new Error(`写不了 ${path}：${(r.body as { error?: string })?.error ?? r.status}`);
  }

  async close() {
    this.#sock?.destroy();
    await new Promise<void>((res) => (this.#server ? this.#server.close(() => res()) : res()));
  }
}
