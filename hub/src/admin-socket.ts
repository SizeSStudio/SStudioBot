// hub-admin.sock (03 「link」, 02 本机 socket): what the `sbot` CLI talks to. Frames are a u32 big-endian length then
// one application frame (JSON), no Noise and no envelope; the file permissions are the authentication: the run dir is
// 0700 and the socket 0600, both owned by the hub's account, so only that account can connect. A connection counts as
// the `client` device `cli` (audit records `cli`).
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseFrame, encodeFrame, type Req, type Res } from "../../protocol/frames.ts";
import { log } from "./log.ts";

// framing moved to protocol/lenframe.ts in W1d so node/ can share it (hub.sock); re-exported for existing callers
export { FRAME_MAX, encodeLen, FrameReader } from "../../protocol/lenframe.ts";
import { encodeLen, FrameReader } from "../../protocol/lenframe.ts";
export const adminSocketPath = (runDir: string) => (process.platform === "win32" ? "\\\\.\\pipe\\sbot-hub-admin" : join(runDir, "hub-admin.sock"));

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
