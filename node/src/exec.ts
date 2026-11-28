// Local node only (05 「本机节点专有」): bash, read and write files, as the node's own account. The hub's command guard
// has already looked at the path or command (the guard lives in one place); the node does not judge again.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readSync, statSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Exec, ExecRes } from "../../protocol/node/hello.ts";

/**
 * No time or output limit (§办3.4), but a reply is one frame (1 MiB): each stream keeps its first 300 KB and says how
 * much was cut, rather than failing the whole call. Streaming output into run_items comes with the client waves ※.
 */
const KEEP = 300 * 1024;

function collector() {
  const parts: Buffer[] = [];
  let kept = 0, total = 0;
  return {
    push(b: Buffer) { total += b.length; if (kept < KEEP) { const s = b.subarray(0, KEEP - kept); parts.push(s); kept += s.length; } },
    text() { const t = Buffer.concat(parts).toString("utf8"); return total > kept ? `${t}\n…（截掉 ${total - kept} 字节，共 ${total}）` : t; },
  };
}

export interface Running { child: ChildProcess; kill(): void }

/** bash -lc (Windows: pwsh -NoProfile -Command), in its own process group so a stop kills everything it started. */
export function runExec(o: Exec, onStart?: (r: Running) => void): Promise<ExecRes> {
  const win = process.platform === "win32";
  const child = win
    ? spawn("pwsh", ["-NoProfile", "-Command", o.cmd], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"] })
    : spawn("bash", ["-lc", o.cmd], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const kill = () => {
    try { if (!win && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already gone */ }
  };
  onStart?.({ child, kill });
  const out = collector(), err = collector();
  child.stdout?.on("data", (b: Buffer) => out.push(b));
  child.stderr?.on("data", (b: Buffer) => err.push(b));
  child.stdin?.on("error", () => {});
  if (o.stdin !== undefined) child.stdin?.end(o.stdin); else child.stdin?.end();
  return new Promise((res) => {
    child.on("error", (e) => res({ code: null, signal: null, stdout: out.text(), stderr: `${err.text()}${String(e.message)}` }));
    child.on("close", (code, signal) => res({ code, signal, stdout: out.text(), stderr: err.text() }));
  });
}

export function readFile(path: string, offset = 0, len = 1024 * 512): { data_b64: string; total: number } {
  const f = resolve(path), total = statSync(f).size;
  const want = Math.max(0, Math.min(len, 700 * 1024, total - offset));   // stays inside one frame after base64
  const buf = Buffer.alloc(want), fd = openSync(f, "r");
  try { readSync(fd, buf, 0, want, offset); } finally { closeSync(fd); }
  return { data_b64: buf.toString("base64"), total };
}

export function writeFile(path: string, data_b64: string, append?: boolean) {
  const f = resolve(path);
  mkdirSync(dirname(f), { recursive: true });
  const data = Buffer.from(data_b64, "base64");
  if (append) appendFileSync(f, data); else writeFileSync(f, data);
}
