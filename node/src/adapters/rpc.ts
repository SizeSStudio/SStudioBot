// Line-delimited JSON over a child's stdio, shared by Codex (JSON-RPC without the `jsonrpc` field), ACP (JSON-RPC 2.0)
// and pi (its own {id, type} shape). Lines split on LF only: readline also splits on U+2028/2029 (08 P7).
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export function readJsonl(stream: Readable, on: (value: any) => void) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      let v: unknown;
      try { v = JSON.parse(line); } catch { continue; }   // a stray log line on stdout is not our business
      on(v);
    }
  });
}

export type Spawned = { proc: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }>; stderrTail: () => string };

/** Starts an agent's process in its own process group (an interrupt or release takes its children too). */
export function spawnAgent(cmd: string, args: string[], o: { cwd: string; env: Record<string, string> }): Spawned {
  const proc = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  let tail = "";
  proc.stderr!.setEncoding("utf8");
  // stderr only for the error text of a failed start; never logged as it is
  proc.stderr!.on("data", (d: string) => { tail = (tail + d).slice(-4000); });
  proc.stdin!.on("error", () => {});
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
    proc.on("error", () => res({ code: null, signal: "spawn-error" }));
    proc.on("exit", (code, signal) => res({ code, signal }));
  });
  return { proc, exited, stderrTail: () => tail };
}

/** Kill the process group, quietly. */
export function killTree(proc: ChildProcess | undefined, sig: NodeJS.Signals = "SIGTERM") {
  if (!proc?.pid || proc.exitCode !== null) return;
  try { if (process.platform !== "win32") process.kill(-proc.pid, sig); else proc.kill(sig); } catch { try { proc.kill(sig); } catch { /* gone */ } }
}

/**
 * A JSON-RPC peer over a child's stdio. `v2` adds `"jsonrpc": "2.0"` (ACP); Codex's app-server leaves it out. Requests
 * from the agent go to `onRequest` (its answer or a thrown error becomes the reply); notifications to `onNotify`.
 */
export class JsonRpc {
  #next = 0;
  #wait = new Map<number | string, { ok: (v: any) => void; fail: (e: Error) => void }>();
  #proc: ChildProcess;
  #v2: boolean;
  closed = false;
  onRequest: (method: string, params: any) => Promise<unknown> = async (m) => { throw Object.assign(new Error(`unsupported ${m}`), { code: -32601 }); };
  onNotify: (method: string, params: any) => void = () => {};

  constructor(proc: ChildProcess, v2: boolean) {
    this.#proc = proc;
    this.#v2 = v2;
    readJsonl(proc.stdout!, (m) => this.#in(m));
    proc.on("exit", () => this.#close(new Error("agent 进程退出了")));
    proc.on("error", (e) => this.#close(e));
  }

  #close(e: Error) {
    this.closed = true;
    for (const w of this.#wait.values()) w.fail(e);
    this.#wait.clear();
  }

  #send(m: object) {
    if (this.closed || !this.#proc.stdin?.writable) return;
    this.#proc.stdin.write(JSON.stringify(this.#v2 ? { jsonrpc: "2.0", ...m } : m) + "\n");
  }

  #in(m: any) {
    if (m && typeof m.method === "string" && m.id !== undefined && m.id !== null) {
      const id = m.id;
      this.onRequest(m.method, m.params).then(
        (result) => this.#send({ id, result: result ?? null }),
        (e) => this.#send({ id, error: { code: typeof e?.code === "number" ? e.code : -32603, message: String(e?.message ?? e).slice(0, 500) } }),
      );
    } else if (m && typeof m.method === "string") {
      try { this.onNotify(m.method, m.params); } catch { /* one bad notification doesn't end the session */ }
    } else if (m && m.id !== undefined) {
      const w = this.#wait.get(m.id);
      this.#wait.delete(m.id);
      if (!w) return;
      if (m.error) w.fail(Object.assign(new Error(String(m.error.message ?? "error")), { code: m.error.code, data: m.error.data }));
      else w.ok(m.result);
    }
  }

  call<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("agent 进程退出了"));
    const id = ++this.#next;
    return new Promise<T>((ok, fail) => { this.#wait.set(id, { ok, fail }); this.#send({ id, method, params }); });
  }

  notify(method: string, params: unknown) { this.#send({ method, params }); }
}
