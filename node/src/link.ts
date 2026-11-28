// The local link (05 link.ts): length-prefixed frames over hub.sock (protocol/lenframe.ts), the same application frames
// as everywhere else. Remote nodes (relay + Noise + auth) come in W2.
import { createConnection, type Socket } from "node:net";
import { encodeFrame, parseFrame, type Req, type Res } from "../../protocol/frames.ts";
import { encodeLen, FrameReader } from "../../protocol/lenframe.ts";
import { Exec, FsRead, FsWrite, type Hello } from "../../protocol/node/hello.ts";
import { readFile, runExec, writeFile, type Running } from "./exec.ts";

export type Logger = (msg: string, fields?: Record<string, unknown>) => void;

/** One connection's life: hello, then serve the hub's requests until the socket closes. */
export function connectOnce(path: string, hello: Hello, log: Logger): Promise<void> {
  return new Promise((resolveDone) => {
    const sock: Socket = createConnection(path);
    const r = new FrameReader();
    const running = new Map<number, Running>();
    const send = (f: Req | Res | { t: "cancel"; id: number }) => { if (!sock.destroyed) sock.write(encodeLen(encodeFrame(f as Req))); };
    const reply = (id: number, status: number, body?: unknown) => send({ t: "res", id, status, ...(body === undefined ? {} : { body }) });

    async function serve(req: Req) {
      try {
        if (req.method === "POST" && req.path === "/node/v1/exec") {
          const o = Exec.safeParse(req.body);
          if (!o.success) return reply(req.id, 400, { error: "bad exec" });
          const res = await runExec(o.data, (run) => running.set(req.id, run));
          running.delete(req.id);
          return reply(req.id, 200, res);
        }
        if (req.method === "POST" && req.path === "/node/v1/fs/read") {
          const o = FsRead.safeParse(req.body);
          if (!o.success) return reply(req.id, 400, { error: "bad fs/read" });
          return reply(req.id, 200, readFile(o.data.path, o.data.offset, o.data.len));
        }
        if (req.method === "POST" && req.path === "/node/v1/fs/write") {
          const o = FsWrite.safeParse(req.body);
          if (!o.success) return reply(req.id, 400, { error: "bad fs/write" });
          writeFile(o.data.path, o.data.data_b64, o.data.append);
          return reply(req.id, 200, {});
        }
        reply(req.id, 404, { error: `no route ${req.method} ${req.path}` });
      } catch (e) {
        reply(req.id, 500, { error: String((e as Error)?.message ?? e).slice(0, 500) });
      }
    }

    sock.on("connect", () => send({ t: "req", id: 0, method: "POST", path: "/node/v1/hello", body: hello }));
    sock.on("data", (chunk) => {
      let texts: string[];
      try { texts = r.push(chunk); } catch { sock.destroy(); return; }
      for (const t of texts) {
        let f;
        try { f = parseFrame(t); } catch { sock.destroy(); return; }
        if (!f) continue;
        if (f.t === "req") void serve(f);
        else if (f.t === "cancel") { running.get(f.id)?.kill(); running.delete(f.id); }
        else if (f.t === "res" && f.id === 0) log(f.status === 200 ? "hello ok" : "hello refused", { status: f.status });
      }
    });
    sock.on("error", (e) => log("link error", { code: (e as NodeJS.ErrnoException).code }));
    sock.on("close", () => { for (const run of running.values()) run.kill(); running.clear(); resolveDone(); });
  });
}
