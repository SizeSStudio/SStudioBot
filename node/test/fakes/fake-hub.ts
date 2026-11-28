// A hub stand-in on hub.sock (protocol/ only: node tests may not import hub/). It answers what a node asks — hello,
// events (checking seq is contiguous from 0 per task:attempt), permissions, status, tool calls, blobs — records it,
// and sends the node requests the way the hub does.
import { createServer, type Server, type Socket } from "node:net";
import { encodeFrame, parseFrame, type Req, type Res } from "../../../protocol/frames.ts";
import { encodeLen, FrameReader } from "../../../protocol/lenframe.ts";
import { AgentEvent, type NodeEvent } from "../../../protocol/node/v1.ts";

export type Ev = AgentEvent & { seq: number };

export class FakeHub {
  #srv: Server | undefined;
  #sock: Socket | undefined;
  #next = 1;
  #wait = new Map<number, (r: Res) => void>();
  hellos: any[] = [];
  /** task:attempt → events in seq order */
  events = new Map<string, Ev[]>();
  permissions: any[] = [];
  statuses: any[] = [];
  toolCalls: any[] = [];
  blobs = new Map<string, Buffer>();
  errors: string[] = [];
  stale = false;
  targetSha = "dev";
  tools = [{ name: "echo", description: "says it back", schema: { type: "object", properties: { say: { type: "string" } } } }];

  listen(path: string): Promise<void> {
    this.#srv = createServer((sock) => this.#conn(sock));
    return new Promise((ok) => this.#srv!.listen(path, () => ok()));
  }

  #conn(sock: Socket) {
    this.#sock = sock;
    const r = new FrameReader();
    sock.on("data", (c) => {
      for (const t of r.push(c)) {
        const f = parseFrame(t);
        if (!f) continue;
        if (f.t === "res") { this.#wait.get(f.id)?.(f); this.#wait.delete(f.id); }
        else if (f.t === "req") { const out = this.#serve(f); sock.write(encodeLen(encodeFrame({ t: "res", id: f.id, status: out.status, ...(out.body === undefined ? {} : { body: out.body as never }) }))); }
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => { if (this.#sock === sock) this.#sock = undefined; });
  }

  #serve(f: Req): { status: number; body?: unknown } {
    const b = f.body as any;
    if (f.path === "/node/v1/hello") { this.hellos.push(b); return { status: 200, body: { target_sha: this.targetSha, min_version: 1, accepts_work: true, tools: this.tools } }; }
    if (f.path === "/node/v1/status") { this.statuses.push(b); return { status: 200, body: {} }; }
    const ev = /^\/node\/v1\/tasks\/(t\d+)\/events$/.exec(f.path);
    if (ev) {
      const k = `${ev[1]}:${b.attempt}`;
      const have = this.events.get(k) ?? [];
      b.events.forEach((ne: NodeEvent, i: number) => {
        if (ne.seq !== b.from_seq + i) this.errors.push(`seq ${ne.seq} at ${i} of from ${b.from_seq}`);
        if (ne.seq < have.length) return;   // a resend
        if (ne.seq !== have.length) this.errors.push(`gap: got ${ne.seq}, have ${have.length}`);
        const e = AgentEvent.safeParse(ne.e);
        if (!e.success) this.errors.push(`bad event ${JSON.stringify(ne.e).slice(0, 100)}`);
        else have.push({ ...e.data, seq: ne.seq } as Ev);
      });
      this.events.set(k, have);
      return { status: 200, body: { acked: Math.max(have.length - 1, 0) } };
    }
    if (f.path === "/node/v1/permissions") { this.permissions.push(b); return { status: 200, body: this.stale ? { stale: true } : { approval_id: this.permissions.length } }; }
    if (f.path === "/node/v1/tool-calls") { this.toolCalls.push(b); return { status: 200, body: { text: `echo ${JSON.stringify(b.args)}` } }; }
    if (f.path === "/node/v1/blobs") {
      const cur = this.blobs.get(b.sha) ?? Buffer.alloc(0);
      const next = Buffer.concat([cur, Buffer.from(b.data_b64, "base64")]);
      this.blobs.set(b.sha, next);
      return { status: 200, body: { done: next.length >= b.total, next_offset: next.length } };
    }
    return { status: 404, body: { error: "fake hub: no route" } };
  }

  get connected() { return !!this.#sock; }

  request(method: Req["method"], path: string, body?: unknown, ms = 20_000): Promise<Res> {
    const sock = this.#sock;
    if (!sock) return Promise.reject(new Error("no node"));
    const id = this.#next++;
    return new Promise((ok, fail) => {
      const t = setTimeout(() => { this.#wait.delete(id); fail(new Error(`timeout ${path}`)); }, ms);
      this.#wait.set(id, (r) => { clearTimeout(t); ok(r); });
      sock.write(encodeLen(encodeFrame({ t: "req", id, method, path, ...(body === undefined ? {} : { body: body as never }) })));
    });
  }

  ev(task: string, attempt = 1) { return this.events.get(`${task}:${attempt}`) ?? []; }
  ended(task: string, attempt = 1, n = 1) { return this.ev(task, attempt).filter((e) => e.k === "turn_end").length >= n; }

  dropNode() { this.#sock?.destroy(); }
  async close() { this.#sock?.destroy(); await new Promise<void>((ok) => (this.#srv ? this.#srv.close(() => ok()) : ok())); }
}

export async function until(cond: () => boolean, ms = 10_000, what = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
