// The task engine (03 「tasks 和 nodes」, §办3.3, §办3.4): a task is a lane `task:<id>` plus the session on a node.
// The hub is the only scheduler (§底4.1): every request to a node is single-shot, every later thing is a `timers` row
// (kind task: resume | ci | release) that comes back as a `task` inbox row in the task's lane.
//
// What is in the task's lane (inbox, all `received` until delivered; the dispatcher leaves task:* lanes alone):
//   user      my message: a steer while a turn runs, else the next turn (an open card is refused first, §办3.4)
//   approval  I answered a glance / ask card (approvals.decide writes it, so an answer given while the node is away
//             still arrives when it is back)
//   task      a timer (op resume | ci | release), or a CI wake-up turn (op turn)
// Statuses (04 §4): queued (not opened yet, or waiting out a quota) → running ⇄ waiting (a card is open) → done (the
// turn ended; the session stays, 「再改」 is the next turn). waiting_node: its node is offline. interrupted: the node or
// the agent restarted under it — 「需要你处理」; my next message resumes it in the same session (§办3.3).
//
// Security: a node reports only for a task that is on that node now (task.node = its device id); an attempt below
// the current one is dropped. A node never decides anything: cards are answered through approvals.decide (only me),
// and the answer the node gets follows the decision — a rejected card always reaches it as a reject option.
// Everything a node sends is untrusted text: redacted before it is stored (items.ts, redact), never rendered here.
import type { Db, Row } from "../db/db.ts";
import type { Home } from "../home.ts";
import type { Out } from "../api/index.ts";
import type { Hello } from "../../../protocol/node/hello.ts";
import {
  AgentEvent, GitChecksRes, PermissionAnswerRes, PermissionPost, SessionOpenRes, SteerRes, TaskEvents, ToolCall, WorktreeCleanupRes,
  type PermissionAnswer, type SessionOpen,
} from "../../../protocol/node/v1.ts";
import type { TaskStart } from "../../../protocol/api/tasks.ts";
import type { ItemEvent } from "../runner/types.ts";
import { itemEnd, itemStart } from "../items.ts";
import { getBlob, putBlob } from "../blobs.ts";
import { ingest } from "../inbox.ts";
import { touchThread } from "../api/threads.ts";
import { submitApproval, voidTaskCards } from "../approvals.ts";
import { redact, redactDeep, StreamRedactor } from "../tools/redact.ts";
import { log } from "../log.ts";
import { enqueue } from "../push/queue.ts";
import { NodeOffline, type NodeRegistry } from "./nodes.ts";
import { callNodeTool } from "./tools.ts";

const MIN = 60_000;
/** ※ constants until they get config keys (§办3.4 says 「可改」): */
export const TIMES = {
  /** opening a session starts an agent process */
  openTimeoutMs: 120_000,
  /** a quota with no reset time: try again every 30 minutes (05 认出额度上限, §底4.3) */
  quotaRetryMs: 30 * MIN,
  /** idle release (§办3.4: default 1 hour) */
  releaseAfterMs: 60 * MIN,
  /** CI: first look after a PR is reported, then while pending, then while open and settled */
  ciFirstMs: 2 * MIN, ciPendingMs: 3 * MIN, ciSettledMs: 10 * MIN,
  /** an answer or message the node couldn't take (not a refusal): try again */
  retryMs: 30_000,
};
/** §办3.4: the 3rd red in a row on the same PR → a notification, not a stop (04 §14 第 3 条) ※ constant */
export const CI_RED_NOTIFY = 3;
const FAILED_LOG_MAX = 20_000;
const HANDOFF_MAX = 12_000;

export interface EngineDeps {
  db: Db; h: Home; nodes: NodeRegistry;
  /** live assistant text to the event pump (api.pump.onItem); already redacted */
  onItem?: (run: string, lane: string, e: ItemEvent) => void;
}

export class TaskError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

const lane = (id: string) => `task:${id}`;
const runId = (id: string, attempt: number, turn: number) => `tr_${id}_${attempt}_${turn}`;
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const json = (v: unknown): Record<string, unknown> => {
  try { const o = typeof v === "string" ? JSON.parse(v) : null; return o && typeof o === "object" ? o : {}; } catch { return {}; }
};

/** The node's reply with a schema, or a TaskError (the node said no, or said something we can't read). */
async function expect<T>(p: Promise<{ status: number; body?: unknown }>, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, what: string): Promise<T> {
  const r = await p;
  if (r.status !== 200) throw new TaskError(r.status === 409 ? 409 : 502, `${what}：节点回 ${r.status} ${redact(JSON.stringify(r.body ?? "")).slice(0, 200)}`);
  const v = schema.safeParse(r.body);
  if (!v.success) throw new TaskError(502, `${what}：节点的回复读不懂`);
  return v.data;
}

export class TaskEngine {
  readonly #d: EngineDeps;
  #timer: NodeJS.Timeout | undefined;
  #busy = false;
  #again = false;
  /** tasks I asked to stop this turn: their `turn_end: interrupted` is mine, not a restart */
  readonly #stopping = new Set<string>();
  /** live assistant text per (task, attempt, item) */
  readonly #text = new Map<string, { text: string; red: StreamRedactor }>();

  constructor(d: EngineDeps) {
    this.#d = d;
    d.nodes.onReconcile = (dev, hello) => this.reconcile(dev, hello);
    d.nodes.onOnline = (dev, hello) => this.online(dev, hello);
    d.nodes.onOffline = (dev) => this.offline(dev);
  }

  startLoop(everyMs = 1000) {
    this.#timer = setInterval(() => this.kick(), everyMs);
    this.#timer.unref();
  }
  stopLoop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }

  /** Work through the task lanes now (also every second). Never overlaps itself. */
  kick() {
    if (this.#busy) { this.#again = true; return; }
    this.#busy = true;
    void this.#tick().catch((e) => log("tasks", "tick failed", { err: errText(e) })).finally(() => {
      this.#busy = false;
      if (this.#again) { this.#again = false; this.kick(); }
    });
  }

  /** For tests: until nothing is left to deliver now. */
  async idle(ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      while (this.#busy) await new Promise((r) => setTimeout(r, 5));
      await this.#tick();
      if (!this.#deliverable().length) return;
      if (Date.now() > end) throw new Error("task engine not idle");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  #task(id: string): Row | undefined { return this.#d.db.one("SELECT * FROM tasks WHERE id = ?", id); }
  #must(id: string): Row {
    const t = this.#task(id);
    if (!t) throw new TaskError(404, "没有这个任务");
    return t;
  }

  // ── client side (03 task_start; protocol/api/tasks.ts) ──────────────────────────────────────────────────────

  /** 派活. The task row is written first (status queued); opening the session follows without waiting. */
  start(o: TaskStart & { device_id?: string }): Row {
    const { db, nodes } = this.#d;
    const node = o.node ?? nodes.defaultNode();
    if (o.node && !nodes.known(o.node)) throw new TaskError(404, "没有这台节点");
    const hello = nodes.helloOf(node);
    const agent = o.agent ?? hello?.agents[0]?.kind ?? null;
    const now = Date.now();
    const id = db.tx(() => {
      const n = Number(db.kvGet("task.seq") ?? "0") + 1;
      db.kvSet("task.seq", String(n));
      const id = `t${n}`;
      db.run(`INSERT INTO tasks(id, origin_lane, goal, context, status, repo, node, agent, workdir, mode, ts) VALUES (?,?,?,?, 'queued', ?,?,?,?,?,?)`,
        id, o.origin_lane ?? null, redact(o.goal), o.context != null ? redact(o.context) : null, o.repo ?? null, node, agent,
        o.cwd ?? o.repo ?? null, o.mode ?? null, now);
      touchThread(db, lane(id), now);
      // 限1 (§办3.3): work on a machine other than the hub's own → tell me once, don't wait for me
      if (node !== "local") pushNotice(db, `task:${id}:dispatched`, lane(id), `任务 ${id} 派到了「${nodes.name(node)}」：${redact(o.goal).slice(0, 80)}`);
      return id;
    });
    log("tasks", "started", { task: id, node: node.slice(0, 8), agent });
    void this.#open(id).catch((e) => log("tasks", "open failed", { task: id, err: errText(e) }));
    return this.#must(id);
  }

  /**
   * My message to a task (§办3.4). Always an inbox row in its lane (the thread shows it); then: an open card is
   * refused first; a running turn gets it as a steer when the agent can take it, else it waits for the next turn.
   */
  async steer(id: string, text: string, o: { device_id?: string; source?: string; msg_id?: string } = {}): Promise<{ applied: boolean; queued: boolean }> {
    const { db } = this.#d;
    const t = this.#must(id);
    if (t.status === "cancelled") throw new TaskError(409, "这个任务已经取消了");
    const src = o.source ?? "client";
    const row = ingest(db, {
      lane: lane(id), kind: "user", source: src, source_msg_id: o.msg_id ?? `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      payload: { text: redact(text), ts: Date.now(), owner: true }, device_id: o.device_id,
    });
    if (row.dup) return { applied: false, queued: true };
    // a card is open: refuse it, the message goes into the same turn (not after the stuck request)
    if (t.status === "waiting") await this.#refuseCards(t, "owner_message");
    const cur = this.#must(id);
    if ((cur.status === "running" || cur.status === "waiting") && cur.session_ref && this.#d.nodes.online(String(cur.node))) {
      try {
        const r = await expect(this.#d.nodes.request(String(cur.node), "POST", `/node/v1/sessions/${encodeURIComponent(String(cur.session_ref))}/steer`,
          { text: redact(text), attempt: Number(cur.attempt) }), SteerRes, "插话");
        if (r.applied) {
          db.run("UPDATE inbox SET status = 'done' WHERE id = ? AND status = 'received'", row.id);
          if (cur.status === "waiting") this.#setStatus(id, "running");
          return { applied: true, queued: false };
        }
      } catch (e) { log("tasks", "steer failed", { task: id, err: errText(e) }); }
      db.run("UPDATE inbox SET payload_json = json_set(payload_json, '$.next_turn', 1) WHERE id = ?", row.id);
      db.tx(() => db.emit("task", id));
      return { applied: false, queued: true };
    }
    this.kick();
    return { applied: false, queued: true };
  }

  /** 停: cancel this turn; messages not yet read go with it (§办3.4). The task stays. */
  async stopTurn(id: string): Promise<Row> {
    const { db } = this.#d;
    const t = this.#must(id);
    db.tx(() => {
      db.run("UPDATE inbox SET status = 'dropped' WHERE lane = ? AND status = 'received' AND kind = 'user'", lane(id));
      db.emit("task", id);
    });
    if (["running", "waiting"].includes(String(t.status)) && t.session_ref && this.#d.nodes.online(String(t.node))) {
      this.#stopping.add(id);
      await this.#refuseCards(t, "stopped");
      try { await this.#d.nodes.request(String(t.node), "POST", `/node/v1/sessions/${encodeURIComponent(String(t.session_ref))}/interrupt`, {}); }
      catch (e) { this.#stopping.delete(id); throw new TaskError(502, `停不下来：${errText(e)}`); }
    }
    return this.#must(id);
  }

  /** 取消: the task is not wanted. Its worktree becomes cleanable (I still press 清理, §0.7). */
  async cancel(id: string): Promise<Row> {
    const { db } = this.#d;
    const t = this.#must(id);
    if (t.status === "cancelled") return t;
    const live = ["running", "waiting"].includes(String(t.status)) && t.session_ref && this.#d.nodes.online(String(t.node));
    voidTaskCards(db, id, { status: "invalidated", by: "code:cancel" });
    db.tx(() => {
      const now = Date.now();
      db.run("UPDATE tasks SET status = 'cancelled', ended = ?, quota_until = NULL WHERE id = ?", now, id);
      db.run("UPDATE inbox SET status = 'dropped' WHERE lane = ? AND status = 'received'", lane(id));
      db.run("UPDATE timers SET status = 'cancelled' WHERE task_id = ? AND kind = 'task' AND status = 'pending'", id);
      db.run("UPDATE worktrees SET state = 'cleanable', cleanable_at = ? WHERE task_id = ? AND state IN ('in_use','kept')", now, id);
      db.run("UPDATE runs SET status = 'aborted', stop_reason = 'cancelled', ended = ? WHERE task_id = ? AND status = 'running'", now, id);
    });
    if (live) {
      this.#stopping.add(id);
      try { await this.#d.nodes.request(String(t.node), "POST", `/node/v1/sessions/${encodeURIComponent(String(t.session_ref))}/interrupt`, {}); }
      catch (e) { log("tasks", "cancel: interrupt failed", { task: id, err: errText(e) }); }
    }
    return this.#must(id);
  }

  /**
   * 换机器 / 换家 (§办3.4 失联): a new session elsewhere with a handoff the code assembles (no model summary). The old
   * session row stays, so moving back can resume it.
   */
  async move(id: string, to: { node?: string; agent?: string }): Promise<Row> {
    const { db, nodes } = this.#d;
    const t = this.#must(id);
    if (t.status === "cancelled") throw new TaskError(409, "这个任务已经取消了");
    if (["running", "waiting"].includes(String(t.status))) throw new TaskError(409, "这一轮还在跑，先停");
    const node = to.node ?? String(t.node);
    if (!nodes.known(node)) throw new TaskError(404, "没有这台节点");
    const agent = to.agent ?? (to.node ? nodes.helloOf(node)?.agents[0]?.kind : undefined) ?? String(t.agent);
    voidTaskCards(db, id, { status: "invalidated", by: "code:move" });
    // an older session of this task on that node and agent: resume it instead of a handoff
    const back = db.one<Row>("SELECT * FROM task_sessions WHERE task_id = ? AND node = ? AND agent = ? AND proc != 'lost' ORDER BY opened_at DESC LIMIT 1", id, node, agent);
    db.tx(() => {
      db.run("UPDATE tasks SET node = ?, agent = ?, status = 'queued', quota_until = NULL, session_ref = ? WHERE id = ?", node, agent, back ? String(back.session_ref) : null, id);
      db.run("UPDATE timers SET status = 'cancelled' WHERE task_id = ? AND kind = 'task' AND status = 'pending' AND json_extract(payload_json, '$.op') IN ('resume','release')", id);
    });
    void this.#open(id, back ? { resume: String(back.session_ref), prompt: "（换回这个 session，接着做）" } : { handoff: true })
      .catch((e) => log("tasks", "move: open failed", { task: id, err: errText(e) }));
    return this.#must(id);
  }

  /** 清理 a worktree I pressed (§0.7: never automatic). The branch stays (it may carry a PR) ※. */
  async cleanupWorktree(node: string, path: string, by: string): Promise<Row> {
    const { db, nodes } = this.#d;
    const w = db.one<Row>("SELECT * FROM worktrees WHERE node = ? AND path = ?", node, path);
    if (!w) throw new TaskError(404, "没有这个 worktree");
    if (w.state === "deleted") return w;
    if (!["cleanable", "kept", "deleting"].includes(String(w.state))) throw new TaskError(409, "这个 worktree 还在用");
    db.tx(() => { db.run("UPDATE worktrees SET state = 'deleting' WHERE node = ? AND path = ?", node, path); db.emit("task", String(w.task_id)); });
    try {
      const r = await expect(nodes.request(node, "POST", "/node/v1/worktrees/cleanup", { path }), WorktreeCleanupRes, "清理 worktree");
      if (!r.removed) throw new TaskError(502, `没删掉：${redact(r.error ?? "节点没说为什么").slice(0, 200)}`);
      db.tx(() => {
        db.run("UPDATE worktrees SET state = 'deleted', deleted_at = ?, deleted_by = ? WHERE node = ? AND path = ?", Date.now(), by, node, path);
        db.emit("task", String(w.task_id));
      });
    } catch (e) {
      db.tx(() => { db.run("UPDATE worktrees SET state = ? WHERE node = ? AND path = ? AND state = 'deleting'", String(w.state), node, path); db.emit("task", String(w.task_id)); });
      throw e instanceof TaskError ? e : new TaskError(e instanceof NodeOffline ? 409 : 502, errText(e));
    }
    return db.one<Row>("SELECT * FROM worktrees WHERE node = ? AND path = ?", node, path)!;
  }

  // ── node → hub (/node/v1, tasks/node-api.ts) ──────────────────────────────────────────────────────────────

  /** POST /node/v1/tasks/:id/events. Idempotent on task:attempt:seq; an old attempt is dropped whole. */
  events(device: string, id: string, body: unknown): Out {
    const { db } = this.#d;
    const b = TaskEvents.safeParse(body);
    if (!b.success) return { status: 400, body: { error: "bad events" } };
    const t = this.#task(id);
    if (!t || t.node !== device) return { status: 403, body: { error: "这个任务不在这台节点上" } };
    const last = b.data.from_seq + b.data.events.length - 1;
    if (b.data.attempt < Number(t.attempt)) return { status: 200, body: { acked: Math.max(last, 0), dropped: true } };
    if (b.data.attempt > Number(t.attempt)) return { status: 409, body: { error: "attempt 比主上的新" } };
    const key = `task.ev:${id}:${b.data.attempt}`;
    let acked = Number(db.kvGet(key) ?? "-1");
    const now = Date.now();
    db.tx(() => {
      for (const [i, ne] of b.data.events.entries()) {
        const seq = b.data.from_seq + i;
        if (ne.seq !== seq) continue;          // the batch must be contiguous; a stray seq is skipped, not trusted
        if (seq <= acked) continue;
        const e = AgentEvent.safeParse(ne.e);
        if (e.success) this.#apply(device, t, b.data.attempt, e.data);   // unknown kinds skip that event only (05)
        acked = seq;
      }
      db.kvSet(key, String(acked));
      // last_output_at makes no event of its own (04 §10.1); the steps do
      db.run("UPDATE tasks SET last_output_at = ? WHERE id = ?", now, id);
      db.run("UPDATE task_sessions SET last_output_at = ? WHERE task_id = ? AND node = ? AND session_ref = ?", now, id, device, String(this.#task(id)?.session_ref ?? ""));
    });
    if (b.data.events.length) this.kick();
    return { status: 200, body: { acked: Math.max(acked, 0) } };
  }

  /** One unified event, inside events()' transaction. `t` is the row as the batch began. */
  #apply(device: string, t: Row, attempt: number, e: AgentEvent) {
    const { db, h } = this.#d;
    const id = String(t.id), ln = lane(id);
    const cur = this.#task(id)!;
    const run = runId(id, attempt, Number(cur.turn));
    const tk = (item: string) => `${id}:${attempt}:${item}`;
    switch (e.k) {
      case "text": {
        let s = this.#text.get(tk(e.item));
        if (!s) {
          const red = new StreamRedactor((text) => this.#d.onItem?.(run, ln, { k: "delta", text }));
          this.#text.set(tk(e.item), (s = { text: "", red }));
        }
        s.text += e.delta;
        s.red.push(e.delta);
        return;
      }
      case "message": {
        const s = this.#text.get(tk(e.item));
        s?.red.flush();
        this.#text.delete(tk(e.item));
        itemStart(db, h.blobs, { lane: ln, run_id: run, kind: "assistant", body: { text: e.text }, status: "done" });
        this.#d.onItem?.(run, ln, { k: "message", text: redact(e.text) });
        return;
      }
      case "tool_start":
        itemStart(db, h.blobs, { lane: ln, run_id: run, kind: "tool", name: e.name.slice(0, 100), call_id: e.item.slice(0, 200), body: { args: e.args } });
        return;
      case "tool_end": {
        const it = db.one<{ id: number; body_json: string | null }>("SELECT id, body_json FROM run_items WHERE run_id = ? AND call_id = ? ORDER BY id DESC LIMIT 1", run, e.item.slice(0, 200));
        const v = { args: it ? json(it.body_json).args : undefined, ...(e.result !== undefined ? { result: e.result } : {}), ...(e.diff ? { diff: e.diff } : {}) };
        if (it) itemEnd(db, h.blobs, it.id, e.ok ? "done" : "error", v);
        else itemStart(db, h.blobs, { lane: ln, run_id: run, kind: "tool", call_id: e.item.slice(0, 200), body: v, status: e.ok ? "done" : "error" });
        return;
      }
      case "permission": case "ask":
        return;   // the card comes from POST /node/v1/permissions (it waits for the answer); the event is only a mirror
      case "turn_end": return this.#turnEnd(t, attempt, e.stop, e.error);
      case "usage":
        // usage.source = node: the node's own subscription, never through the proxy (§办3.2)
        db.run("INSERT INTO usage(ts, source, device_id, run_id, task_id, model, input_tokens, output_tokens, ms) VALUES (?, 'node', ?,?,?,?,?,?,?)",
          Date.now(), device, run, id, e.model?.slice(0, 100) ?? null, e.input_tokens ?? null, e.output_tokens ?? null, e.ms ?? null);
        return;
      case "quota": {
        const until = e.resets_at && e.resets_at > Date.now() ? e.resets_at : Date.now() + TIMES.quotaRetryMs;
        db.run("UPDATE tasks SET status = 'queued', quota_until = ? WHERE id = ?", until, id);
        db.run("UPDATE timers SET status = 'cancelled' WHERE task_id = ? AND kind = 'task' AND status = 'pending' AND json_extract(payload_json, '$.op') = 'resume'", id);
        this.#timer_(id, until, { op: "resume" });
        const when = new Date(until).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
        this.#notice(id, run, "task", `额度用完了，${e.resets_at ? `${when} 恢复，到点接着跑` : `恢复时间没报，${when} 再试`}`);
        pushNotice(db, `task:${id}:quota:${until}`, ln, `任务 ${id} 额度用完，${when} 接着跑`);
        return;
      }
      case "progress":
        itemStart(db, h.blobs, { lane: ln, run_id: run, kind: "notice", name: "progress", body: { text: e.text }, status: "done" });
        return;
      case "session":
        if (e.ref === cur.session_ref) return;
        db.run("UPDATE tasks SET session_ref = ? WHERE id = ?", e.ref, id);
        db.run(`INSERT INTO task_sessions(task_id, node, agent, session_ref, workdir, proc, last_attempt, opened_at) VALUES (?,?,?,?,?, 'live', ?, ?)
                ON CONFLICT(task_id, node, session_ref) DO UPDATE SET proc = 'live', last_attempt = excluded.last_attempt`,
          id, device, String(cur.agent ?? ""), e.ref, cur.workdir as string | null, attempt, Date.now());
        return;
      case "diff": {
        let ref: string | null = null;
        // only a blob the node really uploaded; its text is the node's, so it is redacted into a blob of our own
        if (e.blob) { const raw = getBlob(h.blobs, e.blob); ref = raw ? putBlob(h.blobs, redact(raw.toString("utf8"))) : null; }
        else if (e.text) ref = putBlob(h.blobs, redact(e.text));
        if (!ref) return;
        if (!e.item) db.run("UPDATE tasks SET diff_ref = ? WHERE id = ?", ref, id);
        else itemStart(db, h.blobs, { lane: ln, run_id: run, kind: "notice", name: "diff", body: { item: e.item, diff_ref: ref, stat: e.stat ?? null }, status: "done" });
        return;
      }
      case "pr": {
        const r = db.run("INSERT OR IGNORE INTO task_prs(task_id, node, url, repo, number, branch, opened_at) VALUES (?,?,?,?,?,?,?)",
          id, device, e.url, e.repo ?? null, e.number ?? null, e.branch ?? null, Date.now());
        if (Number(r.changes) === 0) return;
        const pr = Number(r.lastInsertRowid);
        db.emit("task", id);
        this.#notice(id, run, "task", `开了 PR：${e.url}，CI 我盯着`);
        this.#timer_(id, Date.now() + TIMES.ciFirstMs, { op: "ci", pr_id: pr });
        return;
      }
    }
  }

  #turnEnd(t: Row, attempt: number, stop: string, error?: string) {
    const { db } = this.#d;
    const id = String(t.id), cur = this.#task(id)!, now = Date.now();
    const run = runId(id, attempt, Number(cur.turn));
    for (const [k, s] of this.#text) {
      if (!k.startsWith(`${id}:${attempt}:`)) continue;
      s.red.flush();
      this.#text.delete(k);
      if (s.text) itemStart(db, this.#d.h.blobs, { lane: lane(id), run_id: run, kind: "assistant", body: { text: s.text }, status: "done" });
    }
    const mine = this.#stopping.delete(id);
    const runStatus = stop === "done" ? "done" : stop === "interrupted" ? (mine ? "aborted" : "interrupted") : "failed";
    db.run("UPDATE runs SET status = ?, stop_reason = ?, error = ?, ended = ? WHERE id = ? AND status = 'running'", runStatus, stop.slice(0, 40), error ? redact(error).slice(0, 2000) : null, now, run);
    if (cur.status === "cancelled") return;
    if (cur.status === "queued" && cur.quota_until != null) return;   // a quota ended the turn: the timer resumes it
    if (stop === "interrupted" && !mine) {
      // the node or the agent restarted under it (05 权限和问我): cards are void, 「需要你处理」, my next message resumes
      voidTaskCards(db, id, { attempt, status: "invalidated", by: "code:restart" });
      db.run("UPDATE tasks SET status = 'interrupted' WHERE id = ?", id);
      this.#notice(id, run, "task", "节点或 agent 重启了，这一轮断在半路；你说一句我就在同一个 session 里接着来");
      return;
    }
    if (stop === "error") db.run("UPDATE tasks SET status = 'failed', error = ?, ended = ? WHERE id = ?", redact(error ?? "出错了").slice(0, 2000), now, id);
    else db.run("UPDATE tasks SET status = 'done', ended = ?, error = NULL WHERE id = ?", now, id);
    db.run("UPDATE timers SET status = 'cancelled' WHERE task_id = ? AND kind = 'task' AND status = 'pending' AND json_extract(payload_json, '$.op') = 'release'", id);
    this.#timer_(id, now + TIMES.releaseAfterMs, { op: "release", attempt });
  }

  /** POST /node/v1/permissions → a glance / ask card (§办3.3). Idempotent on the request id; waits without a timeout. */
  permission(device: string, body: unknown): Out {
    const { db } = this.#d;
    const b = PermissionPost.safeParse(body);
    if (!b.success) return { status: 400, body: { error: "bad permission request" } };
    const p = b.data, t = this.#task(p.task_id);
    if (!t || t.node !== device) return { status: 403, body: { error: "这个任务不在这台节点上" } };
    if (p.attempt !== Number(t.attempt) || t.status === "cancelled") return { status: 200, body: { stale: true } };
    const kind = p.kind === "ask" ? "ask" : "glance";
    const id = db.tx(() => {
      const had = db.one<{ id: number }>("SELECT id FROM approvals WHERE task_id = ? AND attempt = ? AND tool_use_id = ? AND kind IN ('glance','ask')", p.task_id, p.attempt, p.request_id);
      if (had) return had.id;
      const detail = p.detail && typeof p.detail === "object" && !Array.isArray(p.detail) ? (p.detail as Record<string, unknown>) : { detail: p.detail };
      const a = submitApproval(db, {
        kind, title: p.title || (kind === "ask" ? "它在问你" : "它要权限"), origin_lane: lane(p.task_id), requester: `node:${device}`,
        request: redactDeep(detail), options: p.options.map((o) => ({ id: o.id, label: redact(o.label), ...(o.kind ? { kind: o.kind } : {}) })),
        task_id: p.task_id, attempt: p.attempt, session_ref: p.session_ref ?? (t.session_ref as string | null) ?? undefined, tool_use_id: p.request_id,
      });
      db.run("UPDATE tasks SET status = 'waiting' WHERE id = ? AND status IN ('running','waiting')", p.task_id);
      return a;
    });
    log("tasks", "card", { task: p.task_id, approval: id, kind });
    return { status: 200, body: { approval_id: id } };
  }

  /** POST /node/v1/tool-calls: the sbot MCP (02 Y2). tools.ts holds the gate; here only who may call for which task. */
  async toolCall(device: string, body: unknown, mcpOpen: boolean): Promise<Out> {
    const b = ToolCall.safeParse(body);
    if (!b.success) return { status: 400, body: { error: "bad tool call" } };
    const c = b.data;
    if (!c.task_id) {
      // an agent I started myself (05 反向开放): off unless console.yaml mcp_open (turning it on is a widening)
      if (!mcpOpen) return { status: 403, body: { error: "MCP 入口没开（console.yaml mcp_open）" } };
      return { status: 200, body: await callNodeTool(this.#d.db, this.#d.h, { device, call: c }) };
    }
    const t = this.#task(c.task_id);
    if (!t || t.node !== device) return { status: 403, body: { error: "这个任务不在这台节点上" } };
    if (c.attempt !== undefined && c.attempt !== Number(t.attempt)) return { status: 200, body: { text: "error: 这次调用属于旧的一次 session，没执行", is_error: true } };
    return { status: 200, body: await callNodeTool(this.#d.db, this.#d.h, { device, call: c, task: t, run_id: runId(String(t.id), Number(t.attempt), Number(t.turn)) }) };
  }

  // ── node presence (nodes.ts hooks) ────────────────────────────────────────────────────────────────────────

  /** The node is gone: its tasks wait for it (§办3.4 失联: no automatic move). Cards stay; the process may live. */
  offline(device: string) {
    const { db } = this.#d;
    db.tx(() => {
      for (const t of db.all<{ id: string }>("SELECT id FROM tasks WHERE node = ? AND status IN ('running','waiting')", device)) {
        db.kvSet(`task.was:${t.id}`, String(db.one<{ status: string }>("SELECT status FROM tasks WHERE id = ?", t.id)!.status));
        db.run("UPDATE tasks SET status = 'waiting_node' WHERE id = ?", t.id);
      }
    });
  }

  /**
   * The node said hello. With `sessions` (W4 nodes) the hub tells live sessions from lost ones: a task whose session
   * the node no longer holds was cut by a restart → interrupted (cards void, 「需要你处理」). Then whatever waited
   * for this node goes out: unopened tasks, answers, messages.
   */
  reconcile(device: string, hello: Hello) {
    const { db } = this.#d;
    const held = hello.sessions ? new Map(hello.sessions.map((s) => [s.ref, s])) : undefined;
    const lost: Row[] = [];
    db.tx(() => {
      for (const t of db.all<Row>(`SELECT * FROM tasks WHERE node = ? AND status IN ('running','waiting','waiting_node')`, device)) {
        const id = String(t.id);
        const was = db.kvGet(`task.was:${id}`) ?? (t.status === "waiting_node" ? "running" : String(t.status));
        db.run("DELETE FROM kv WHERE k = ?", `task.was:${id}`);
        // a session that waited for this node to be opened (move, resume, quota): reopenPending below does it
        if (db.kvGet(`task.reopen:${id}`) || !t.session_ref) { db.run("UPDATE tasks SET status = 'queued' WHERE id = ?", id); continue; }
        const s = held?.get(String(t.session_ref));
        if (held && (!s || s.state === "released")) { lost.push(t); continue; }
        const st = s?.state === "waiting" || was === "waiting" ? "waiting" : s?.state === "idle" ? "done" : "running";
        db.run("UPDATE tasks SET status = ? WHERE id = ?", st, id);
      }
    });
    for (const t of lost) {
      const id = String(t.id);
      voidTaskCards(db, id, { attempt: Number(t.attempt), status: "invalidated", by: "code:restart" });
      db.tx(() => {
        db.run("UPDATE tasks SET status = 'interrupted' WHERE id = ?", id);
        db.run("UPDATE task_sessions SET proc = 'released', released_at = ? WHERE task_id = ? AND node = ? AND session_ref = ?", Date.now(), id, device, String(t.session_ref));
        db.run("UPDATE runs SET status = 'interrupted', stop_reason = 'node_restart', ended = ? WHERE task_id = ? AND status = 'running'", Date.now(), id);
        this.#notice(id, runId(id, Number(t.attempt), Number(t.turn)), "task", "节点重启过，这个 session 的进程没了；你说一句我就续上");
      });
      log("tasks", "interrupted by node restart", { task: id });
    }
  }

  /** After the hello's answer: what waited for this node goes out. */
  online(device: string, _hello?: Hello) {
    const { db } = this.#d;
    this.reopenPending(device);
    for (const t of db.all<{ id: string }>("SELECT id FROM tasks WHERE node = ? AND status = 'queued' AND quota_until IS NULL AND attempt = 0", device)) {
      void this.#open(t.id).catch((e) => log("tasks", "open failed", { task: t.id, err: errText(e) }));
    }
    this.kick();
  }

  // ── opening sessions and sending turns ────────────────────────────────────────────────────────────────────

  /**
   * Open (or resume) the task's session: attempt + 1, turn 1. `resume`: the session_ref to resume; `handoff`: write
   * a handoff (moved machine or agent). The node's answer gives session_ref, the workdir and a worktree it made.
   */
  async #open(id: string, o: { resume?: string; prompt?: string; handoff?: boolean } = {}) {
    const { db, nodes, h } = this.#d;
    const t = this.#must(id);
    const node = String(t.node);
    if (!nodes.online(node) || !nodes.acceptsWork(node)) {
      db.tx(() => { db.run("UPDATE tasks SET status = 'waiting_node' WHERE id = ? AND status = 'queued'", id); });
      if (o.resume || o.handoff) db.kvSet(`task.reopen:${id}`, JSON.stringify(o));
      return;
    }
    const attempt = Number(t.attempt) + 1, now = Date.now();
    const agent = String(t.agent ?? nodes.helloOf(node)?.agents[0]?.kind ?? "");
    if (!agent) {
      db.tx(() => { db.run("UPDATE tasks SET status = 'failed', error = ?, ended = ? WHERE id = ?", "这台节点没报有哪个 agent", now, id); });
      return;
    }
    // a second task in the same repo on the same node gets a worktree (§办3.4)
    const busy = t.repo && !o.resume ? db.one("SELECT 1 FROM tasks WHERE node = ? AND repo = ? AND id != ? AND status IN ('running','waiting','waiting_node','interrupted')", node, String(t.repo), id) : undefined;
    const handoff = o.handoff || o.resume ? this.#handoff(t) : undefined;
    const handoffRef = handoff ? putBlob(h.blobs, handoff) : null;
    const prompt = o.prompt ?? (t.context ? `${String(t.goal)}\n\n${String(t.context)}` : String(t.goal));
    const cwd = String(t.workdir ?? t.repo ?? nodes.helloOf(node)?.cwd ?? "");
    db.tx(() => {
      db.run("UPDATE tasks SET status = 'running', attempt = ?, turn = 1, agent = ?, started = COALESCE(started, ?), ended = NULL, quota_until = NULL WHERE id = ?", attempt, agent, now, id);
      this.#runRow(id, attempt, 1, agent);
    });
    const req: SessionOpen = {
      task_id: id, attempt, agent, cwd, prompt: redact(prompt), ...(t.mode ? { mode: String(t.mode) } : {}),
      ...(busy ? { worktree: { repo: String(t.repo), branch: `sbot/${id}` } } : {}),
      ...(o.resume ? { resume_ref: o.resume } : {}),
      // ※ also on a resume: the node uses it only when the old session can't be resumed (res.fresh)
      ...(handoff ? { handoff } : {}),
    };
    let r;
    try { r = await expect(nodes.request(node, "POST", "/node/v1/sessions", req, TIMES.openTimeoutMs), SessionOpenRes, "开 session"); }
    catch (e) {
      const off = e instanceof NodeOffline;
      db.tx(() => {
        db.run("UPDATE runs SET status = 'failed', error = ?, ended = ? WHERE id = ? AND status = 'running'", redact(errText(e)), Date.now(), runId(id, attempt, 1));
        if (off) { db.run("UPDATE tasks SET status = 'waiting_node' WHERE id = ? AND status = 'running'", id); if (o.resume || o.handoff) db.kvSet(`task.reopen:${id}`, JSON.stringify(o)); }
        else db.run("UPDATE tasks SET status = 'failed', error = ?, ended = ? WHERE id = ? AND status = 'running'", redact(errText(e)), Date.now(), id);
      });
      log("tasks", "open failed", { task: id, err: errText(e) });
      return;
    }
    db.tx(() => {
      db.run("UPDATE tasks SET session_ref = ?, workdir = ? WHERE id = ?", r.session_ref, r.workdir, id);
      db.run(`INSERT INTO task_sessions(task_id, node, agent, session_ref, workdir, proc, last_attempt, handoff_ref, opened_at) VALUES (?,?,?,?,?, 'live', ?,?,?)
              ON CONFLICT(task_id, node, session_ref) DO UPDATE SET proc = 'live', last_attempt = excluded.last_attempt, released_at = NULL,
                handoff_ref = COALESCE(excluded.handoff_ref, task_sessions.handoff_ref)`,
        id, node, agent, r.session_ref, r.workdir, attempt, o.handoff || r.fresh ? handoffRef : null, Date.now());
      if (r.worktree) {
        db.run("INSERT OR IGNORE INTO worktrees(node, path, task_id, repo, branch, created_at) VALUES (?,?,?,?,?,?)", node, r.worktree.path, id, r.worktree.repo, r.worktree.branch, Date.now());
      }
      db.emit("task", id);
    });
    log("tasks", "session open", { task: id, attempt, fresh: !!r.fresh });
  }

  #runRow(id: string, attempt: number, turn: number, agent: string) {
    const { db } = this.#d;
    db.run("INSERT OR IGNORE INTO runs(id, lane, role, status, task_id, versions_json, started) VALUES (?,?, 'task', 'running', ?,?,?)",
      runId(id, attempt, turn), lane(id), id, JSON.stringify({ agent }), Date.now());
  }

  /**
   * §办3.4 交接: by budget, from the record — first request, the latest turns, command results, progress.md — with
   * what was left out said so. No model writes it.
   */
  #handoff(t: Row): string {
    const { db } = this.#d;
    const id = String(t.id);
    const parts: string[] = [`这是接着做的任务 ${id}（换了 session）。第一条要求：\n${String(t.goal)}${t.context ? `\n\n${String(t.context)}` : ""}`];
    const progress = db.one<{ body_json: string }>("SELECT body_json FROM run_items WHERE lane = ? AND kind = 'notice' AND name = 'progress' ORDER BY id DESC LIMIT 1", lane(id));
    if (progress) parts.push(`progress.md 最新：\n${String(json(progress.body_json).text ?? "")}`);
    const rows = db.all<Row>("SELECT kind, name, body_json, status FROM run_items WHERE lane = ? AND kind IN ('assistant','tool') ORDER BY id DESC LIMIT 40", lane(id)).reverse();
    const lines = rows.map((r) => {
      const b = json(r.body_json);
      if (r.kind === "assistant") return `[它] ${String(b.text ?? "")}`;
      const res = typeof b.result === "string" ? b.result : JSON.stringify(b.result ?? "");
      return `[${String(r.name ?? "工具")}${r.status === "error" ? " 出错" : ""}] ${JSON.stringify(b.args ?? "").slice(0, 300)} → ${res.slice(0, 600)}`;
    });
    const total = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM run_items WHERE lane = ? AND kind IN ('assistant','tool')", lane(id))!.n;
    let out = parts.join("\n\n"), kept = 0;
    const body: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length + body.join("\n").length + lines[i]!.length > HANDOFF_MAX) break;
      body.unshift(lines[i]!);
      kept++;
    }
    if (body.length) out += `\n\n最近几步：\n${body.join("\n")}`;
    if (total > kept) out += `\n\n（更早的 ${total - kept} 步省掉了；要看可以让我把记录发给你）`;
    return redact(out);
  }

  /** One turn into the current session (my message, a CI wake-up, a quota resume). */
  async #turn(t: Row, text: string): Promise<boolean> {
    const { db, nodes } = this.#d;
    const id = String(t.id), turn = Number(t.turn) + 1, attempt = Number(t.attempt);
    db.tx(() => {
      db.run("UPDATE tasks SET status = 'running', turn = ?, ended = NULL, error = NULL WHERE id = ?", turn, id);
      this.#runRow(id, attempt, turn, String(t.agent ?? ""));
      db.run("UPDATE timers SET status = 'cancelled' WHERE task_id = ? AND kind = 'task' AND status = 'pending' AND json_extract(payload_json, '$.op') = 'release'", id);
    });
    try {
      const r = await nodes.request(String(t.node), "POST", `/node/v1/sessions/${encodeURIComponent(String(t.session_ref))}/turns`, { text: redact(text), attempt });
      if (r.status === 200) return true;
      throw new TaskError(r.status, `节点回 ${r.status}`);
    } catch (e) {
      // back to where it was; the row stays for the next try (offline) or the task says why (refused)
      const off = e instanceof NodeOffline;
      db.tx(() => {
        db.run("UPDATE tasks SET status = ?, turn = ? WHERE id = ?", off ? "waiting_node" : String(t.status), Number(t.turn), id);
        db.run("DELETE FROM runs WHERE id = ? AND status = 'running'", runId(id, attempt, turn));
      });
      log("tasks", "turn failed", { task: id, err: errText(e) });
      return false;
    }
  }

  // ── the lane ─────────────────────────────────────────────────────────────────────────────────────────────

  #deliverable(): Row[] {
    return this.#d.db.all(`SELECT * FROM inbox WHERE status = 'received' AND lane LIKE 'task:%' AND COALESCE(not_before, 0) <= ? ORDER BY id`, Date.now());
  }

  async #tick() {
    const { db } = this.#d;
    const rows = this.#deliverable();
    const seen = new Set<string>();
    for (const r of rows) {
      const id = String(r.lane).slice(5);
      if (seen.has(id)) continue;          // one step per task per tick, in order
      const t = this.#task(id);
      const done = (status = "done") => db.run("UPDATE inbox SET status = ? WHERE id = ? AND status = 'received'", status, Number(r.id));
      if (!t || t.status === "cancelled") { done("dropped"); continue; }
      const p = json(r.payload_json);
      try {
        if (r.kind === "approval") { seen.add(id); await this.#answer(t, r, Number(p.approval_id), done); continue; }
        if (r.kind === "task" && p.op && p.op !== "turn") { await this.#timerOp(t, String(p.op), p, done); continue; }
        // a message or a wake-up turn: only between turns (a running turn got it as a steer, or it waits)
        if (r.kind === "user" || (r.kind === "task" && p.op === "turn")) {
          seen.add(id);
          await this.#deliverTurn(t);
          continue;
        }
        done("dropped");
      } catch (e) {
        log("tasks", "lane step failed", { task: id, kind: r.kind, err: errText(e) });
        db.run("UPDATE inbox SET not_before = ? WHERE id = ?", Date.now() + TIMES.retryMs, Number(r.id));
      }
    }
  }

  async #deliverTurn(t: Row): Promise<boolean> {
    const { db, nodes } = this.#d;
    const id = String(t.id), st = String(t.status), node = String(t.node);
    if (!nodes.online(node)) return false;
    if (st === "running" || st === "waiting" || st === "waiting_node") return false;   // next turn
    if (st === "queued" && (t.quota_until != null || Number(t.attempt) === 0)) return false;
    // every message waiting now goes in one turn, in order
    const all = db.all<Row>("SELECT * FROM inbox WHERE lane = ? AND status = 'received' AND (kind = 'user' OR (kind = 'task' AND json_extract(payload_json, '$.op') = 'turn')) ORDER BY id", lane(id));
    const text = all.map((x) => String(json(x.payload_json).text ?? "")).filter(Boolean).join("\n\n");
    if (st === "interrupted" || !t.session_ref) {
      // 「我再答时续上」(§办3.3): the same session, resumed; my message is the prompt
      for (const x of all) db.run("UPDATE inbox SET status = 'done' WHERE id = ?", Number(x.id));
      await this.#open(id, { resume: t.session_ref ? String(t.session_ref) : undefined, prompt: text, handoff: !t.session_ref });
      return true;
    }
    if (!(await this.#turn(t, text))) return false;
    for (const x of all) db.run("UPDATE inbox SET status = 'done' WHERE id = ?", Number(x.id));
    return true;
  }

  /**
   * My answer on a card → PermissionAnswer to the node. The decision is the authority: a rejected card always goes
   * out as a reject option, an approved one never as a reject (fail closed). An MCP `ask` (no request on the node)
   * is answered as a message into the session.
   */
  async #answer(t: Row, r: Row, approvalId: number, done: (s?: string) => void) {
    const { db, nodes } = this.#d;
    const a = db.one<Row>("SELECT * FROM approvals WHERE id = ?", approvalId);
    if (!a || a.task_id !== t.id || !["approved", "rejected"].includes(String(a.status))) return done("dropped");
    if (Number(a.attempt) !== Number(t.attempt)) return done("dropped");     // 04: an answer for an old attempt isn't sent
    const ans = answerFor(a);
    const reqId = String(a.tool_use_id ?? "");
    if (reqId.startsWith("mcp:")) {
      // the agent asked through the sbot MCP `ask`; the answer is my next message in that session
      ingest(db, { lane: lane(String(t.id)), kind: "task", source: "approval", source_msg_id: `${approvalId}:turn`,
        payload: { op: "turn", text: `（你问的「${String(a.title ?? "")}」，我的回答：${ans.text ?? ans.option_id ?? (a.status === "approved" ? "可以" : "不行")}）` } });
      if (t.status === "waiting") {
        const live = db.one("SELECT 1 FROM runs WHERE task_id = ? AND status = 'running'", String(t.id));
        this.#setStatus(String(t.id), live ? "running" : "done");
      }
      return done();
    }
    if (!nodes.online(String(t.node))) return;      // stays received; sent when the node is back
    const res = await expect(nodes.request(String(t.node), "POST", `/node/v1/permissions/${encodeURIComponent(reqId)}`,
      { task_id: String(t.id), attempt: Number(t.attempt), ...ans } satisfies PermissionAnswer), PermissionAnswerRes, "回答权限");
    done();
    const open = db.one("SELECT 1 FROM approvals WHERE task_id = ? AND attempt = ? AND status = 'pending' AND kind IN ('glance','ask')", String(t.id), Number(t.attempt));
    if (res.gone) {
      // the node lost the request (restarted): resume the same session and let it ask again (§办3.3)
      db.tx(() => { db.run("UPDATE tasks SET status = 'interrupted' WHERE id = ?", String(t.id)); });
      ingest(db, { lane: lane(String(t.id)), kind: "task", source: "approval", source_msg_id: `${approvalId}:reask`,
        payload: { op: "turn", text: `（刚才的请求「${String(a.title ?? "")}」在你那边没了；我的回答是「${a.status === "approved" ? "可以" : "不行"}」，需要的话再问一次）` } });
      return;
    }
    if (!open && t.status === "waiting") this.#setStatus(String(t.id), "running");
  }

  async #timerOp(t: Row, op: string, p: Record<string, unknown>, done: (s?: string) => void) {
    const { db, nodes } = this.#d;
    const id = String(t.id), node = String(t.node);
    if (op === "resume") {
      if (t.status !== "queued" || t.quota_until == null) return done("dropped");
      // the hub wakes it, not the node (§办3.4: an offline node doesn't wake up to run old tasks): wait for it
      if (!nodes.online(node)) { db.tx(() => db.run("UPDATE tasks SET status = 'waiting_node', quota_until = NULL WHERE id = ?", id)); db.kvSet(`task.reopen:${id}`, JSON.stringify({ quota: true })); return done(); }
      done();
      db.tx(() => db.run("UPDATE tasks SET quota_until = NULL, status = 'done' WHERE id = ?", id));
      const cur = this.#must(id);
      if (cur.session_ref) await this.#turn(cur, "（额度恢复了，接着做刚才没做完的）");
      else await this.#open(id);
      pushNotice(db, `task:${id}:resumed:${Number(t.quota_until)}`, lane(id), `任务 ${id} 额度恢复，接着跑了`);
      return;
    }
    if (op === "release") {
      // idle release (§办3.4): only a finished turn with no open card; the session stays
      if (!["done", "failed"].includes(String(t.status)) || !t.session_ref || Number(p.attempt) !== Number(t.attempt)) return done("dropped");
      if (!nodes.online(node)) return done("dropped");
      const r = await nodes.request(node, "DELETE", `/node/v1/sessions/${encodeURIComponent(String(t.session_ref))}`, undefined);
      done(r.status === 200 ? "done" : "dropped");
      if (r.status === 200) db.tx(() => {
        db.run("UPDATE task_sessions SET proc = 'released', released_at = ? WHERE task_id = ? AND node = ? AND session_ref = ?", Date.now(), id, node, String(t.session_ref));
        db.emit("task", id);
      });
      return;
    }
    if (op === "ci") return this.#ci(t, Number(p.pr_id), done);
    done("dropped");
  }

  /** One CI look (§办3.4, 04 §14). Red on a new head → wake the same session with the log; the 3rd red → a notice. */
  async #ci(t: Row, prId: number, done: (s?: string) => void) {
    const { db, nodes } = this.#d;
    const pr = db.one<Row>("SELECT * FROM task_prs WHERE id = ? AND task_id = ?", prId, String(t.id));
    if (!pr || pr.state !== "open") return done("dropped");
    const node = String(pr.node), id = String(t.id);
    if (!nodes.online(node)) { done(); this.#timer_(id, Date.now() + TIMES.ciSettledMs, { op: "ci", pr_id: prId }); return; }
    const r = await expect(nodes.request(node, "POST", "/node/v1/git/checks", { ...(pr.repo ? { repo: String(pr.repo) } : {}), pr: String(pr.url) }), GitChecksRes, "查 CI");
    done();
    const now = Date.now();
    const newRed = r.ci === "red" && (pr.ci !== "red" || r.head_sha !== pr.head_sha);
    const streak = r.ci === "green" ? 0 : newRed ? Number(pr.red_streak) + 1 : Number(pr.red_streak);
    db.tx(() => {
      db.run("UPDATE task_prs SET state = ?, ci = ?, head_sha = ?, red_streak = ?, checked_at = ?, closed_at = ? WHERE id = ?",
        r.state, r.ci, r.head_sha ?? null, streak, now, r.state === "open" ? null : now, prId);
      if (r.state === "merged") db.run("UPDATE worktrees SET state = 'cleanable', cleanable_at = ? WHERE task_id = ? AND node = ? AND state IN ('in_use','kept')", now, id, node);
      db.emit("task", id);
    });
    if (r.state === "open") this.#timer_(id, now + (r.ci === "pending" ? TIMES.ciPendingMs : TIMES.ciSettledMs), { op: "ci", pr_id: prId });
    if (!newRed || r.state !== "open") return;
    const logTail = redact(r.failed_log ?? "").slice(-FAILED_LOG_MAX);
    const failed = r.checks.filter((c) => c.state === "failure" || c.state === "fail" || c.state === "red").map((c) => c.name).join("、");
    ingest(db, { lane: lane(id), kind: "task", source: "ci", source_msg_id: `${prId}:${r.head_sha ?? now}`,
      payload: { op: "turn", text: `PR ${String(pr.url)} 的 CI 红了${failed ? `（${failed}）` : ""}。修好再推。\n\n失败日志（末尾）：\n${logTail || "（节点没拿到日志）"}` } });
    // §办3.4: no limit on wake-ups; the 3rd red in a row is a notification, not a stop
    if (streak === CI_RED_NOTIFY) pushNotice(db, `task_pr:${prId}:red:${CI_RED_NOTIFY}`, lane(id), `任务 ${id} 的 PR 连着红了 ${CI_RED_NOTIFY} 次：${String(pr.url)}`, "notice");
  }

  // ── small helpers ────────────────────────────────────────────────────────────────────────────────────────

  /** Refuse this task's open cards (§办3.4: my message while it waits), telling the node each was refused. */
  async #refuseCards(t: Row, why: "owner_message" | "stopped") {
    const { db, nodes } = this.#d;
    const rows = voidTaskCards(db, String(t.id), { attempt: Number(t.attempt), status: "rejected", by: `code:${why}` });
    for (const a of rows) {
      if (String(a.tool_use_id ?? "").startsWith("mcp:") || !nodes.online(String(t.node))) continue;
      const ans = answerFor({ ...a, status: "rejected" });
      try { await nodes.request(String(t.node), "POST", `/node/v1/permissions/${encodeURIComponent(String(a.tool_use_id))}`, { task_id: String(t.id), attempt: Number(t.attempt), ...ans }); }
      catch (e) { log("tasks", "refuse card failed", { task: String(t.id), err: errText(e) }); }
    }
    db.tx(() => db.run("UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'waiting'", String(t.id)));
  }

  #setStatus(id: string, status: string) { this.#d.db.tx(() => this.#d.db.run("UPDATE tasks SET status = ? WHERE id = ?", status, id)); }

  #notice(id: string, run: string, name: string, text: string) {
    itemStart(this.#d.db, this.#d.h.blobs, { lane: lane(id), run_id: run, kind: "notice", name, body: { text, ref: `task:${id}` }, status: "done" });
  }

  #timer_(id: string, due: number, payload: Record<string, unknown>) {
    this.#d.db.run("INSERT INTO timers(kind, lane, due_at, payload_json, status, created_by, task_id, ts) VALUES ('task', ?, ?, ?, 'pending', 'code', ?, ?)",
      lane(id), Math.round(due), JSON.stringify(payload), id, Date.now());
  }

  /** A reopen that waited for the node (move / resume while it was away): done when it says hello (online → kick). */
  reopenPending(device: string) {
    const { db } = this.#d;
    for (const t of db.all<{ id: string }>("SELECT id FROM tasks WHERE node = ? AND status = 'queued' AND quota_until IS NULL", device)) {
      const k = `task.reopen:${t.id}`, v = db.kvGet(k);
      if (!v) continue;
      db.run("DELETE FROM kv WHERE k = ?", k);
      const o = json(v);
      const cur = this.#must(t.id);
      if (o.quota && cur.session_ref) { db.tx(() => db.run("UPDATE tasks SET status = 'done' WHERE id = ?", t.id)); void this.#turn(this.#must(t.id), "（额度恢复了，接着做刚才没做完的）"); continue; }
      void this.#open(t.id, { resume: typeof o.resume === "string" ? o.resume : undefined, prompt: typeof o.prompt === "string" ? o.prompt : undefined, handoff: o.handoff === true });
    }
  }
}

/**
 * The answer the node gets for a decided card (fail closed): rejected → the chosen option if it is a reject kind,
 * else the agent's first reject option, else `reject`; approved → the chosen option unless it is a reject kind, else
 * the first allow option. An ask carries my text / answers.
 */
export function answerFor(a: Row): { option_id?: string; text?: string; answers?: Record<string, string> } {
  const opts = (() => { try { return JSON.parse(String(a.options_json ?? "[]")) as { id: string; kind?: string }[]; } catch { return []; } })();
  const ans = json(a.answer_json) as { option_id?: string; text?: string; answers?: Record<string, string> };
  const isReject = (o?: { id: string; kind?: string }) => !!o && (o.kind ? /^(reject|deny)/.test(o.kind) : /^(reject|deny)/.test(o.id));
  const picked = opts.find((o) => o.id === ans.option_id);
  const extra = { ...(ans.text ? { text: ans.text } : {}), ...(ans.answers ? { answers: ans.answers } : {}) };
  if (a.status === "rejected") {
    const o = isReject(picked) ? picked : opts.find((x) => isReject(x));
    return { option_id: o?.id ?? "reject" };
  }
  if (a.kind === "ask" && !picked) return extra;
  // what I picked goes as it is, a reject option too; only a bare approve (no pick) means the first allow option
  const o = picked ?? opts.find((x) => !isReject(x));
  return { ...(o ? { option_id: o.id } : {}), ...extra };
}

/** A line for push (push/queue.ts decides presence, night, quota from the route table). Once per ref. */
export function pushNotice(db: Db, ref: string, ln: string, text: string, cat = "notice") {
  enqueue(db, { cat, ref, lane: ln, domain: "work", text: redact(text).slice(0, 300) });
}

