// The session table (05 sessions.ts): which task:attempt each agent session belongs to, its state, and the hub's
// requests on it. The node keeps no timers of its own (§底4.1): release, resume, CI are single requests from the hub.
// The state file (sessions.json) holds only refs, tasks, attempts, states and the next event seq, so a restarted node
// can tell the hub in hello what it still holds: an idle session is still `idle` (resumed lazily on the next turn),
// one that was running or waiting is `released` — its process is gone, the hub marks it 「需要你处理」 (§办3.3).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  PermissionAnswer, SessionOpen, TurnReq,
  type AgentEvent, type PermissionRequest, type SessionOpenRes, type SessionState,
} from "../../protocol/node/v1.ts";
import type { AgentAdapter, Caps, McpMount } from "./adapters/types.ts";
import type { Found } from "./adapters/index.ts";
import { Outbox, type Send } from "./outbox.ts";
import { finalDiff, headOf, makeWorktree, prFrom } from "./git.ts";
import { newMcpKey, type Tool } from "./mcp.ts";

type Reply = { status: number; body?: unknown };

/** One session. `live`: its agent process is up in this node process. */
export interface Sess {
  ref: string; task_id: string; attempt: number; agent: string; cwd: string; mode?: string;
  state: "running" | "idle" | "waiting" | "released";
  live: boolean; key: string; tools: Tool[]; base?: string; progress?: string;
  unsub?: () => void;
  /** tool_start args by item, to spot `gh pr create` at its tool_end */
  cmds: Map<string, string>;
  /** text deltas waiting for the next 80 ms batch */
  text: Map<string, string>;
  textTimer?: NodeJS.Timeout;
  /** events go through this one at a time (turn_end waits for the diff) */
  chain: Promise<void>;
}

export interface SessionDeps {
  stateDir: string;
  agents: Found[];
  /** where commands run when the hub names no directory */
  defaultCwd: string;
  /** the `sbot-node mcp` program, as an agent starts it */
  mcpCommand: { command: string; args: string[]; ctl: string };
  /** the hub's current link (undefined while it is away) */
  request(method: "POST", path: string, body: unknown, timeoutMs?: number): Promise<{ status: number; body?: unknown }>;
  online(): boolean;
  helloTools(): Tool[];
  /** something the hub sees in status changed (quota, draining) */
  onStatus(): void;
  log(msg: string, f?: Record<string, unknown>): void;
}

const TEXT_MS = 80;
const DIFF_INLINE = 16 * 1024;

/** The agent's environment: ours without the node's own variables or an outer agent session's markers. */
export function childEnv(env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (/^SBOT_/.test(k)) continue;
    if (k !== "CLAUDE_CODE_OAUTH_TOKEN" && /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_AGENT_SDK_|T3CODE_)/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export class Sessions {
  readonly #d: SessionDeps;
  readonly #byRef = new Map<string, Sess>();
  readonly #adapters = new Map<string, AgentAdapter>();
  readonly #file: string;
  readonly outbox: Outbox;
  #seqs: Record<string, number> = {};
  /** permissions the hub hasn't got yet (it was away): sent again after the next hello */
  readonly #unsent = new Map<string, { s: Sess; r: PermissionRequest }>();
  quotas: Record<string, unknown> = {};
  draining = false;

  constructor(d: SessionDeps) {
    this.#d = d;
    this.#file = join(d.stateDir, "sessions.json");
    const saved = this.#load();
    this.#seqs = saved.seqs;
    this.outbox = new Outbox(join(d.stateDir, "spool"), this.#seqs);
    this.outbox.onSeq = (k, n) => { this.#seqs[k] = n; this.#save(); };
    for (const x of saved.sessions) {
      // the process didn't survive the restart: a session that was mid-turn is lost to the hub (cards void)
      const state = x.state === "idle" ? "idle" : "released";
      this.#byRef.set(x.ref, { ...x, state, live: false, key: newMcpKey(), tools: [], cmds: new Map(), text: new Map(), chain: Promise.resolve() });
    }
    this.#save();
  }

  // ── state file ──

  #load(): { sessions: Pick<Sess, "ref" | "task_id" | "attempt" | "agent" | "cwd" | "state" | "base" | "mode">[]; seqs: Record<string, number> } {
    if (!existsSync(this.#file)) return { sessions: [], seqs: {} };
    try {
      const j = JSON.parse(readFileSync(this.#file, "utf8"));
      return { sessions: Array.isArray(j.sessions) ? j.sessions : [], seqs: j.seqs && typeof j.seqs === "object" ? j.seqs : {} };
    } catch { return { sessions: [], seqs: {} }; }
  }

  #save() {
    const sessions = [...this.#byRef.values()].map((s) => ({ ref: s.ref, task_id: s.task_id, attempt: s.attempt, agent: s.agent, cwd: s.cwd, state: s.state, ...(s.base ? { base: s.base } : {}), ...(s.mode ? { mode: s.mode } : {}) }));
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions, seqs: this.#seqs }), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  // ── what hello and status report ──

  helloSessions() { return [...this.#byRef.values()].map((s) => ({ ref: s.ref, task_id: s.task_id, attempt: s.attempt, agent: s.agent, state: s.state })); }

  states(): SessionState[] {
    return [...this.#byRef.values()].map((s) => {
      const a = this.#adapters.get(s.agent);
      const pid = s.live ? a?.pid?.(s.ref) : undefined;
      const pending = s.live && a ? a.getPendingPermissions(s.ref).length : 0;
      return { ref: s.ref, task_id: s.task_id, attempt: s.attempt, agent: s.agent, state: s.state, cwd: s.cwd, ...(pid ? { pid } : {}), ...(pending ? { pending } : {}) };
    });
  }

  caps(): Record<string, Caps> { return Object.fromEntries(this.#d.agents.map((f) => [f.kind, f.caps])); }

  busy() { return [...this.#byRef.values()].some((s) => s.live && (s.state === "running" || s.state === "waiting")); }

  get(ref: string) { return this.#byRef.get(ref); }
  byKey(key: string) { for (const s of this.#byRef.values()) if (s.key === key && s.live) return s; return undefined; }

  // ── the hub's requests ──

  #adapter(kind: string): AgentAdapter | undefined {
    let a = this.#adapters.get(kind);
    if (a) return a;
    const f = this.#d.agents.find((x) => x.kind === kind);
    if (!f) return undefined;
    a = f.make();
    a.onExit = (ref, why) => this.#exited(ref, why);
    this.#adapters.set(kind, a);
    return a;
  }

  #mount(s: Sess): McpMount {
    const m = this.#d.mcpCommand;
    return { command: m.command, args: m.args, env: { SBOT_NODE_CTL: m.ctl, SBOT_NODE_MCP_KEY: s.key }, tools: s.tools.map((t) => t.name) };
  }

  #opts(s: Sess) { return { cwd: s.cwd, mcp: this.#mount(s), env: childEnv(), ...(s.mode ? { mode: s.mode } : {}) }; }

  /** POST /node/v1/sessions */
  async open(body: unknown): Promise<Reply> {
    const b = SessionOpen.safeParse(body);
    if (!b.success) return { status: 400, body: { error: "bad session open" } };
    if (this.draining) return { status: 503, body: { error: "节点在排空（要升级或停机），不接新的 session" } };
    const o = b.data;
    const adapter = this.#adapter(o.agent);
    if (!adapter) return { status: 422, body: { error: `这台节点没有 ${o.agent}` } };
    let cwd = resolve(o.cwd || this.#d.defaultCwd);
    let worktree: SessionOpenRes["worktree"];
    if (o.worktree) {
      worktree = await makeWorktree(o.worktree.repo, o.task_id, o.worktree.branch);
      cwd = worktree.path;
    }
    if (!existsSync(cwd)) return { status: 422, body: { error: `目录不存在：${cwd}` } };
    const old = o.resume_ref ? this.#byRef.get(o.resume_ref) : undefined;
    const s: Sess = {
      ref: o.resume_ref ?? "", task_id: o.task_id, attempt: o.attempt, agent: o.agent, cwd, ...(o.mode ? { mode: o.mode } : {}),
      state: "running", live: false, key: newMcpKey(), tools: o.tools ?? this.#d.helloTools(), cmds: new Map(), text: new Map(), chain: Promise.resolve(),
      ...(old?.base ? { base: old.base } : {}),
    };
    s.base ??= await headOf(cwd);
    if (old) { old.unsub?.(); if (old.live) await adapter.release(old.ref).catch(() => {}); }
    let fresh = false;
    if (o.resume_ref) {
      try {
        await adapter.resumeSession(o.resume_ref, this.#opts(s));
        this.#bind(s, adapter);
        await adapter.startTurn(s.ref, o.prompt);
      } catch (e) {
        s.unsub?.();
        s.live = false;
        this.#d.log("resume failed, fresh session", { task: o.task_id, err: String((e as Error)?.message ?? e).slice(0, 200) });
        this.#byRef.delete(o.resume_ref);
        fresh = true;
      }
    }
    if (!o.resume_ref || fresh) {
      const prompt = o.handoff ? `${o.handoff}\n\n---\n\n${o.prompt}` : o.prompt;
      s.ref = await adapter.createSession({ ...this.#opts(s), prompt });
      this.#bind(s, adapter);
    }
    this.#save();
    this.#d.log("session open", { task: o.task_id, attempt: o.attempt, agent: o.agent, fresh });
    const res: SessionOpenRes = { session_ref: s.ref, workdir: cwd, ...(worktree ? { worktree } : {}), ...(fresh ? { fresh: true } : {}) };
    return { status: 200, body: res };
  }

  #bind(s: Sess, a: AgentAdapter) {
    s.live = true;
    this.#byRef.set(s.ref, s);
    s.unsub = a.subscribe(s.ref, (e) => { s.chain = s.chain.then(() => this.#on(s, e)).catch((err) => this.#d.log("event failed", { err: String(err?.message ?? err).slice(0, 200) })); });
  }

  /** A known session whose process is gone (released, or the node restarted): take it back before a turn. */
  async #revive(s: Sess): Promise<AgentAdapter> {
    const a = this.#adapter(s.agent);
    if (!a) throw new Error(`这台节点没有 ${s.agent} 了`);
    if (s.live) return a;
    s.key = newMcpKey();
    if (!s.tools.length) s.tools = this.#d.helloTools();
    await a.resumeSession(s.ref, this.#opts(s));
    this.#bind(s, a);
    return a;
  }

  /** POST /node/v1/sessions/:ref/turns */
  async turn(ref: string, body: unknown): Promise<Reply> {
    const b = TurnReq.safeParse(body);
    if (!b.success) return { status: 400, body: { error: "bad turn" } };
    if (this.draining) return { status: 503, body: { error: "节点在排空" } };
    const s = this.#byRef.get(ref);
    if (!s) return { status: 404, body: { error: "节点上没有这个 session" } };
    if (s.live && (s.state === "running" || s.state === "waiting")) return { status: 409, body: { error: "这一轮还没完" } };
    let a: AgentAdapter;
    try { a = await this.#revive(s); }
    catch (e) {
      s.state = "released";
      this.#save();
      return { status: 410, body: { error: `session 续不上：${String((e as Error)?.message ?? e).slice(0, 300)}` } };
    }
    if (b.data.attempt && b.data.attempt !== s.attempt) s.attempt = b.data.attempt;
    s.state = "running";
    s.base = (await headOf(s.cwd)) ?? s.base;
    this.#save();
    await a.startTurn(ref, b.data.text);
    return { status: 200, body: {} };
  }

  /** POST /node/v1/sessions/:ref/steer — applied:false is honest: the hub sends it as the next turn (ACP). */
  async steer(ref: string, body: unknown): Promise<Reply> {
    const b = TurnReq.safeParse(body);
    if (!b.success) return { status: 400, body: { error: "bad steer" } };
    const s = this.#byRef.get(ref);
    if (!s || !s.live || s.state !== "running" && s.state !== "waiting") return { status: 200, body: { applied: false } };
    const a = this.#adapters.get(s.agent)!;
    const applied = await a.steer(ref, b.data.text).catch(() => false);
    return { status: 200, body: { applied } };
  }

  /** POST /node/v1/sessions/:ref/interrupt */
  async interrupt(ref: string): Promise<Reply> {
    const s = this.#byRef.get(ref);
    if (!s || !s.live) return { status: 200, body: {} };
    await this.#adapters.get(s.agent)!.interrupt(ref);
    return { status: 200, body: {} };
  }

  /** DELETE /node/v1/sessions/:ref — idle release; refused while it works or waits for me. */
  async release(ref: string): Promise<Reply> {
    const s = this.#byRef.get(ref);
    if (!s) return { status: 200, body: { released: true } };
    if (s.live && (s.state === "running" || s.state === "waiting")) return { status: 409, body: { error: s.state === "waiting" ? "它在等你回答，不放" : "这一轮还在跑，不放" } };
    s.unsub?.();
    if (s.live) await this.#adapters.get(s.agent)?.release(ref).catch(() => {});
    s.live = false;
    s.state = "idle";   // the agent keeps the session; the next turn resumes it (hub: task_sessions.proc released)
    this.#save();
    this.#d.log("session released", { task: s.task_id });
    return { status: 200, body: { released: true } };
  }

  /** POST /node/v1/permissions/:request_id — my answer on the card. gone: the request died with a restart. */
  async answer(requestId: string, body: unknown): Promise<Reply> {
    const b = PermissionAnswer.safeParse(body);
    if (!b.success) return { status: 400, body: { error: "bad answer" } };
    for (const s of this.#byRef.values()) {
      if (!s.live) continue;
      if (b.data.task_id && b.data.task_id !== s.task_id) continue;
      if (b.data.attempt && b.data.attempt !== s.attempt) continue;
      const a = this.#adapters.get(s.agent)!;
      if (!a.getPendingPermissions(s.ref).some((r) => r.id === requestId)) continue;
      const { option_id, text, answers } = b.data;
      await a.respondToPermission(s.ref, requestId, { ...(option_id ? { option_id } : {}), ...(text ? { text } : {}), ...(answers ? { answers } : {}) });
      this.#unsent.delete(requestId);
      if (s.state === "waiting" && !a.getPendingPermissions(s.ref).length) { s.state = "running"; this.#save(); }
      return { status: 200, body: { ok: true } };
    }
    return { status: 200, body: { ok: false, gone: true } };
  }

  // ── events from the agents ──

  async #on(s: Sess, e: AgentEvent) {
    if (e.k === "text") {
      s.text.set(e.item, (s.text.get(e.item) ?? "") + e.delta);
      s.textTimer ??= setTimeout(() => { s.textTimer = undefined; this.#flushText(s); }, TEXT_MS);
      return;
    }
    this.#flushText(s);
    if (e.k === "tool_start") {
      const a = e.args as { command?: unknown; cmd?: unknown } | undefined;
      const cmd = typeof a?.command === "string" ? a.command : Array.isArray(a?.command) ? a.command.join(" ") : typeof a?.cmd === "string" ? a.cmd : "";
      if (cmd) s.cmds.set(e.item, cmd);
    }
    if (e.k === "permission" || e.k === "ask") {
      if (s.state === "running") { s.state = "waiting"; this.#save(); }
      this.#push(s, e);
      await this.#postPermission(s, e.request);
      return;
    }
    if (e.k === "quota") {
      this.quotas[s.agent] = { ...(e.resets_at ? { resets_at: e.resets_at } : {}), at: Date.now() };
      this.#d.onStatus();
    }
    if (e.k === "session" && e.ref !== s.ref) {
      this.#byRef.delete(s.ref);
      s.ref = e.ref;
      this.#byRef.set(s.ref, s);
      this.#save();
    }
    if (e.k === "turn_end") {
      await this.#finish(s);
      this.#push(s, e);
      s.state = s.live ? "idle" : s.state;
      this.#save();
      return;
    }
    this.#push(s, e);
    if (e.k === "tool_end") {
      const cmd = s.cmds.get(e.item);
      s.cmds.delete(e.item);
      const out = typeof e.result === "string" ? e.result : JSON.stringify(e.result ?? "");
      const pr = cmd ? prFrom(cmd, out) : undefined;
      if (pr) this.#push(s, { k: "pr", url: pr.url, repo: pr.repo, number: pr.number });
    }
  }

  #flushText(s: Sess) {
    if (s.textTimer) { clearTimeout(s.textTimer); s.textTimer = undefined; }
    for (const [item, delta] of s.text) if (delta) this.#push(s, { k: "text", item, delta });
    s.text.clear();
  }

  #push(s: Sess, e: AgentEvent) { this.outbox.push(s.task_id, s.attempt, s.ref || undefined, e); }

  /** End of a turn: progress.md if it changed, the finished diff (big ones as a blob). */
  async #finish(s: Sess) {
    const p = join(s.cwd, "progress.md");
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8").slice(0, 20_000);
      if (text !== s.progress) { s.progress = text; this.#push(s, { k: "progress", text }); }
    }
    if (!s.base) return;
    const d = await finalDiff(s.cwd, s.base).catch(() => undefined);
    if (!d) return;
    if (Buffer.byteLength(d.text) <= DIFF_INLINE) { this.#push(s, { k: "diff", text: d.text, stat: d.stat }); return; }
    const blob = await this.#blob(Buffer.from(d.text, "utf8")).catch(() => undefined);
    this.#push(s, blob ? { k: "diff", blob, stat: d.stat } : { k: "diff", text: d.text.slice(0, DIFF_INLINE) + "\n…（太长，截断了）", stat: d.stat });
  }

  /** POST /node/v1/blobs in 512 KiB pieces; → blob:<sha> */
  async #blob(data: Buffer): Promise<string> {
    const sha = createHash("sha256").update(data).digest("hex");
    let offset = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const piece = data.subarray(offset, offset + 512 * 1024);
      const r = await this.#d.request("POST", "/node/v1/blobs", { sha, offset, data_b64: piece.toString("base64"), total: data.length });
      if (r.status !== 200) throw new Error(`blob ${r.status}`);
      const b = r.body as { done: boolean; next_offset: number };
      if (b.done) return `blob:${sha}`;
      offset = b.next_offset;
    }
    throw new Error("blob upload did not finish");
  }

  async #postPermission(s: Sess, r: PermissionRequest) {
    this.#unsent.set(r.id, { s, r });
    if (!this.#d.online()) return;
    let res: { status: number; body?: unknown };
    try {
      res = await this.#d.request("POST", "/node/v1/permissions", {
        task_id: s.task_id, attempt: s.attempt, session_ref: s.ref, request_id: r.id, kind: r.kind, title: r.title, detail: r.detail, options: r.options,
      });
    } catch { return; }   // the hub went away: sent again after the next hello
    if (res.status !== 200) return;
    this.#unsent.delete(r.id);
    if ((res.body as { stale?: boolean } | undefined)?.stale) {
      // an old attempt: nobody will be asked, so the agent hears no
      await this.#adapters.get(s.agent)?.respondToPermission(s.ref, r.id, { option_id: "reject" }).catch(() => {});
    }
  }

  /** After a hello: what couldn't reach the hub goes now. */
  reconnected(send: Send) {
    this.outbox.connect(send);
    for (const { s, r } of [...this.#unsent.values()]) {
      const a = this.#adapters.get(s.agent);
      if (s.live && a?.getPendingPermissions(s.ref).some((x) => x.id === r.id)) void this.#postPermission(s, r);
      else this.#unsent.delete(r.id);
    }
  }

  disconnected() { this.outbox.connect(undefined); }

  #exited(ref: string, why: string) {
    const s = this.#byRef.get(ref);
    if (!s) return;
    // the adapter already sent turn_end interrupted if a turn was running; wait for it to go through
    void s.chain.then(() => {
      s.unsub?.();
      s.live = false;
      s.state = s.state === "idle" ? "idle" : "released";
      for (const [id, u] of this.#unsent) if (u.s === s) this.#unsent.delete(id);
      this.#save();
      this.#d.log("agent exited", { task: s.task_id, why: why.slice(0, 200) });
    });
  }

  // ── draining (upgrade, stop) ──

  /** No new sessions or turns; wait for running turns; after `timeoutMs` the rest is cut like a restart. */
  async drain(timeoutMs: number) {
    this.draining = true;
    this.#d.onStatus();
    const end = Date.now() + timeoutMs;
    while (this.busy() && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
    for (const s of this.#byRef.values()) if (s.live) await this.#adapters.get(s.agent)?.release(s.ref).catch(() => {});
    const t0 = Date.now();
    while (!this.outbox.empty() && this.#d.online() && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 200));
  }

  /** Everything this node process started stops (SIGTERM). */
  async closeAll() {
    for (const s of this.#byRef.values()) {
      if (!s.live) continue;
      s.unsub?.();
      await this.#adapters.get(s.agent)?.release(s.ref).catch(() => {});
    }
  }
}

