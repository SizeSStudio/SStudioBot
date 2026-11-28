// The local node's link (03 link, 05): hub.sock under run/ (0700), the socket 0660 so the node account's group can
// connect. Connecting there is `role: node`, device id `local`, no pairing (same machine, file permissions, veto 3).
// Requests go both ways on one connection: the node says hello; the hub sends /node/v1/exec and fs/* down.
import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { encodeFrame, parseFrame, type Req, type Res } from "../../protocol/frames.ts";
import { encodeLen, FrameReader } from "../../protocol/lenframe.ts";
import { PROTOCOL } from "../../protocol/version.ts";
import { ExecRes, FsReadRes, Hello, type HelloRes } from "../../protocol/node/hello.ts";
import { ensureRunDir } from "./admin-socket.ts";
import type { NodeClient } from "./tools/registry.ts";
import { log } from "./log.ts";

export const nodeSocketPath = (runDir: string) =>
  process.env.SBOT_NODE_SOCK ?? (process.platform === "win32" ? "\\\\.\\pipe\\sbot-hub" : join(runDir, "hub.sock"));

type Pending = { resolve: (r: Res) => void; reject: (e: Error) => void };

export class NodeLink implements NodeClient {
  #server: Server | undefined;
  #sock: Socket | undefined;
  #pending = new Map<number, Pending>();
  #next = 1;
  hello: Hello | undefined;
  readonly targetSha: string;

  constructor(targetSha: string) { this.targetSha = targetSha; }

  async listen(runDir: string): Promise<string> {
    const path = nodeSocketPath(runDir);
    if (!process.env.SBOT_NODE_SOCK) ensureRunDir(runDir);
    if (process.platform !== "win32" && existsSync(path)) unlinkSync(path);
    this.#server = createServer((sock) => this.#accept(sock));
    await new Promise<void>((res, rej) => { this.#server!.once("error", rej); this.#server!.listen(path, () => { this.#server!.off("error", rej); res(); }); });
    if (process.platform !== "win32") chmodSync(path, 0o660);
    log("node-link", "listening", { socket: "hub.sock" });
    return path;
  }

  connected() { return !!this.#sock && !this.#sock.destroyed && !!this.hello; }

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
        else if (f.t === "req") this.#serve(sock, f);
      }
    });
    const gone = () => {
      if (this.#sock !== sock) return;
      this.#sock = undefined;
      this.hello = undefined;
      for (const [id, p] of this.#pending) { this.#pending.delete(id); p.reject(new Error("本机节点断开了")); }
      log("node-link", "node disconnected");
    };
    sock.on("close", gone);
    sock.on("error", () => sock.destroy());
  }

  #serve(sock: Socket, req: Req) {
    const reply = (status: number, body?: unknown) => { if (!sock.destroyed) sock.write(encodeLen(encodeFrame({ t: "res", id: req.id, status, ...(body === undefined ? {} : { body }) }))); };
    if (req.method === "POST" && req.path === "/node/v1/hello") {
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
