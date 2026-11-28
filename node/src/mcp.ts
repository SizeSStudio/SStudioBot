// The sbot MCP (05, 02 Y2). Two halves:
//   serveCtl  in the daemon: a unix socket (0600, the node account only) that agents' MCP programs talk to; a call
//             becomes POST /node/v1/tool-calls with this session's task and attempt
//   runMcp    `sbot-node mcp`, the stdio MCP server every agent starts (one program for all four ※): tools/list and
//             tools/call go to the daemon, nothing is decided here
// The tools come from the hub (hello / SessionOpen.tools), never written into the node. SBOT_NODE_MCP_KEY names the
// session: a random handle the daemon made for it, worth only that session's own tool calls (which the agent can make
// anyway), not a secret of mine. No key = an agent I started myself (05 反向开放): an ad hoc call, the hub 403s it
// unless mcp_open.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { encodeLen, FrameReader } from "../../protocol/lenframe.ts";
import type { HelloRes } from "../../protocol/node/hello.ts";
import type { ToolCallRes } from "../../protocol/node/v1.ts";

export type Tool = NonNullable<HelloRes["tools"]>[number];
type CtlReq = { id: number; op: "tools" | "call"; key?: string; name?: string; args?: unknown };
type CtlRes = { id: number; tools?: Tool[]; text?: string; is_error?: boolean };

export interface CtlDeps {
  /** a session's key → its task, attempt and tools; undefined = unknown key */
  session(key: string): { task_id: string; attempt: number; tools: Tool[] } | undefined;
  /** the tools hello gave (ad hoc) */
  helloTools(): Tool[];
  /** POST /node/v1/tool-calls; rejects when the hub is away */
  call(body: { task_id?: string; attempt?: number; tool_call_id: string; name: string; args: unknown }): Promise<ToolCallRes>;
}

export const newMcpKey = () => randomBytes(24).toString("base64url");

/** A unix socket path is at most ~104 bytes: a long state dir gets one in the temp dir, named by its hash. */
export function ctlPath(stateDir: string) {
  const h = createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\sbot-node-ctl-${h}`;
  const p = join(stateDir, "ctl.sock");
  return Buffer.byteLength(p) < 100 ? p : join(tmpdir(), `sbot-node-${h}.sock`);
}

export function serveCtl(path: string, d: CtlDeps): Promise<Server> {
  if (process.platform !== "win32" && existsSync(path)) unlinkSync(path);
  const srv = createServer((sock: Socket) => {
    const r = new FrameReader();
    const reply = (m: CtlRes) => { if (!sock.destroyed) sock.write(encodeLen(JSON.stringify(m))); };
    sock.on("data", (chunk) => {
      let texts: string[];
      try { texts = r.push(chunk); } catch { sock.destroy(); return; }
      for (const t of texts) {
        let m: CtlReq;
        try { m = JSON.parse(t); } catch { sock.destroy(); return; }
        void handle(m).then(reply, (e) => reply({ id: m.id, text: `error: ${String((e as Error)?.message ?? e).slice(0, 500)}`, is_error: true }));
      }
    });
    sock.on("error", () => sock.destroy());
  });
  async function handle(m: CtlReq): Promise<CtlRes> {
    const s = m.key ? d.session(m.key) : undefined;
    if (m.key && !s) return { id: m.id, tools: [], text: "error: 这个 session 已经不在节点上了", is_error: true };
    if (m.op === "tools") return { id: m.id, tools: s ? s.tools : d.helloTools() };
    const r = await d.call({ ...(s ? { task_id: s.task_id, attempt: s.attempt } : {}), tool_call_id: randomUUID(), name: String(m.name ?? ""), args: m.args ?? {} });
    return { id: m.id, text: r.text, ...(r.is_error ? { is_error: true } : {}) };
  }
  return new Promise((res, rej) => {
    srv.once("error", rej);
    srv.listen(path, () => {
      if (process.platform !== "win32") chmodSync(path, 0o600);
      res(srv);
    });
  });
}

/** `sbot-node mcp`: MCP over stdio (newline-delimited JSON-RPC 2.0), backed by the daemon's ctl socket. */
export async function runMcp(env = process.env, stdin: NodeJS.ReadableStream = process.stdin, stdout: NodeJS.WritableStream = process.stdout) {
  const key = env.SBOT_NODE_MCP_KEY || undefined;
  const path = env.SBOT_NODE_CTL;
  if (!path) throw new Error("SBOT_NODE_CTL not set");
  let next = 1;
  const wait = new Map<number, (r: CtlRes) => void>();
  let sock: Socket | undefined;
  const ctl = (m: Omit<CtlReq, "id">): Promise<CtlRes> => new Promise((ok) => {
    if (!sock || sock.destroyed) {
      sock = createConnection(path);
      const r = new FrameReader();
      sock.on("data", (c) => { for (const t of r.push(c)) { const x = JSON.parse(t) as CtlRes; wait.get(x.id)?.(x); wait.delete(x.id); } });
      sock.on("error", () => {});
      sock.on("close", () => { for (const [id, w] of wait) w({ id, text: "error: 节点守护进程断开了", is_error: true }); wait.clear(); });
    }
    const id = next++;
    wait.set(id, ok);
    sock.write(encodeLen(JSON.stringify({ id, ...m, ...(key ? { key } : {}) })));
  });
  const write = (o: object) => stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
  let buf = "";
  stdin.setEncoding?.("utf8");
  stdin.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line.trim()) void onLine(line);
    }
  });
  await new Promise<void>((res) => { stdin.on("end", () => res()); stdin.on("close", () => res()); });
  sock?.destroy();

  async function onLine(line: string) {
    let m: { id?: number | string; method?: string; params?: any };
    try { m = JSON.parse(line); } catch { return write({ id: null, error: { code: -32700, message: "parse error" } }); }
    if (m.id === undefined || m.id === null) return;   // notifications (initialized, cancelled)
    const ok = (result: unknown) => write({ id: m.id, result });
    switch (m.method) {
      case "initialize":
        return ok({ protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "sbot", version: "1" } });
      case "ping": return ok({});
      case "tools/list": {
        const r = await ctl({ op: "tools" });
        return ok({ tools: (r.tools ?? []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema && typeof t.schema === "object" ? t.schema : { type: "object" } })) });
      }
      case "tools/call": {
        const r = await ctl({ op: "call", name: String(m.params?.name ?? ""), args: m.params?.arguments ?? {} });
        return ok({ content: [{ type: "text", text: r.text ?? "" }], ...(r.is_error ? { isError: true } : {}) });
      }
      default: return write({ id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
    }
  }
}
