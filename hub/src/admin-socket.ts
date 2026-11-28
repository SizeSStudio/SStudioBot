// hub-admin.sock (03 「link」, 02 本机 socket): what the `sbot` CLI talks to. Frames are a u32 big-endian length then
// one application frame (JSON), no Noise and no envelope; the file permissions are the authentication: the run dir is
// 0700 and the socket 0600, both owned by the hub's account, so only that account can connect. A connection counts as
// the `client` device `cli` (audit records `cli`).
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseFrame, encodeFrame, type Req, type Res } from "../../protocol/frames.ts";
import { log } from "./log.ts";

/** 02 「Noise」: a reassembled frame is at most 1 MiB; the local socket uses the same ceiling so a frame fits either path */
export const FRAME_MAX = 1024 * 1024;
export const adminSocketPath = (runDir: string) => (process.platform === "win32" ? "\\\\.\\pipe\\sbot-hub-admin" : join(runDir, "hub-admin.sock"));

export function encodeLen(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  if (body.length > FRAME_MAX) throw new Error(`frame too large (${body.length} bytes)`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames' texts. Throws on an oversize length (the connection is then dropped). */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): string[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: string[] = [];
    while (this.#buf.length >= 4) {
      const n = this.#buf.readUInt32BE(0);
      if (n > FRAME_MAX) throw new Error(`frame too large (${n} bytes)`);
      if (this.#buf.length < 4 + n) break;
      out.push(this.#buf.subarray(4, 4 + n).toString("utf8"));
      this.#buf = this.#buf.subarray(4 + n);
    }
    return out;
  }
}

export type Handler = (req: Req, who: { device: "cli" }) => Promise<{ status: number; body?: unknown }>;

/** The run dir must be ours and closed to everyone else before a socket goes in it. */
export function ensureRunDir(runDir: string) {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  chmodSync(runDir, 0o700);
  const st = statSync(runDir);
  if (process.getuid && st.uid !== process.getuid()) throw new Error(`${runDir} is not owned by this account (uid ${st.uid}); refusing to put the admin socket there`);
}

const probe = (path: string) => new Promise<boolean>((res) => {
  const s = createConnection(path);
  s.once("connect", () => { s.destroy(); res(true); });
  s.once("error", () => res(false));
});

export async function startAdminSocket(runDir: string, handle: Handler): Promise<Server> {
  ensureRunDir(runDir);
  const path = adminSocketPath(runDir);
  if (process.platform !== "win32" && existsSync(path)) {
    if (await probe(path)) throw new Error("another hub is already listening on hub-admin.sock");
    unlinkSync(path);   // left over from a hub that died
  }
  const server = createServer((sock) => serve(sock, handle));
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(path, () => { server.off("error", rej); res(); }); });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  log("admin", "listening", { socket: "hub-admin.sock" });
  return server;
}

function serve(sock: Socket, handle: Handler) {
  const r = new FrameReader();
  const reply = (f: Res) => { if (!sock.destroyed) sock.write(encodeLen(encodeFrame(f))); };
  sock.on("data", (chunk) => {
    let texts: string[];
    try { texts = r.push(chunk); } catch { sock.destroy(); return; }
    for (const t of texts) {
      let f;
      try { f = parseFrame(t); } catch { sock.destroy(); return; }   // a known frame with a bad shape: protocol error
      if (!f || f.t !== "req") continue;                              // unknown or not for us: ignored (02)
      const req = f;
      handle(req, { device: "cli" }).then(
        (out) => reply({ t: "res", id: req.id, status: out.status, body: out.body }),
        (e) => {
          log("admin", "handler failed", { path: req.path, err: String((e as Error)?.message ?? e).slice(0, 200) });
          reply({ t: "res", id: req.id, status: 500, body: { error: "internal error" } });
        });
    }
  });
  sock.on("error", () => sock.destroy());
}

/** One request over the admin socket (the CLI). Rejects when no hub is listening. */
export function adminRequest(runDir: string, method: Req["method"], path: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(adminSocketPath(runDir));
    const r = new FrameReader();
    sock.once("error", (e) => reject(Object.assign(new Error(`hub 没在运行，或连不上 hub-admin.sock（${(e as NodeJS.ErrnoException).code ?? e.message}）`), { cause: e })));
    sock.on("connect", () => {
      const req: Req = { t: "req", id: 1, method, path, ...(body === undefined ? {} : { body }) };
      sock.write(encodeLen(encodeFrame(req)));
    });
    sock.on("data", (chunk) => {
      let texts: string[];
      try { texts = r.push(chunk); } catch (e) { sock.destroy(); reject(e); return; }
      for (const t of texts) {
        const f = parseFrame(t);
        if (f?.t === "res" && f.id === 1) { sock.end(); resolve(f); return; }
      }
    });
    sock.on("close", () => reject(new Error("hub closed the connection without answering")));
  });
}
