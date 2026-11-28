// Events on their way to the hub (05 「统一事件」): one outbox per task:attempt, a monotonic seq from 0, a spool file
// so nothing is lost while the hub is away or the node restarts, resent oldest first; the hub is idempotent on
// task:attempt:seq, its `acked` drops what it has, `dropped` (an old attempt) drops the whole outbox.
import { appendFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentEvent, NodeEvent, TaskEventsRes } from "../../protocol/node/v1.ts";
import { ensureDir } from "./config.ts";

export type Send = (task: string, body: { attempt: number; session_ref?: string; from_seq: number; events: NodeEvent[] }) => Promise<TaskEventsRes | undefined>;

const BATCH = 500;

class Box {
  readonly task: string;
  readonly attempt: number;
  ref: string | undefined;
  next = 0;
  q: NodeEvent[] = [];
  busy = false;
  gone = false;
  readonly file: string;
  constructor(task: string, attempt: number, file: string) { this.task = task; this.attempt = attempt; this.file = file; }
}

export class Outbox {
  readonly #dir: string;
  readonly #boxes = new Map<string, Box>();
  #send: Send | undefined;
  /** the next seq each task:attempt starts at after a restart (sessions.json keeps it once the spool is empty) */
  onSeq: (key: string, next: number) => void = () => {};

  constructor(dir: string, seqs: Record<string, number> = {}) {
    this.#dir = ensureDir(dir);
    for (const f of readdirSync(this.#dir)) {
      const m = /^(t\d+)-(\d+)\.jsonl$/.exec(f);
      if (!m) continue;
      const b = this.#box(m[1]!, Number(m[2]));
      for (const line of readFileSync(join(this.#dir, f), "utf8").split("\n")) {
        if (!line) continue;
        try { const e = JSON.parse(line) as NodeEvent & { ref?: string }; if (e.ref) b.ref = e.ref; b.q.push({ seq: e.seq, ts: e.ts, e: e.e }); b.next = e.seq + 1; } catch { /* a torn last line */ }
      }
    }
    for (const [k, n] of Object.entries(seqs)) {
      const [task, att] = k.split(":");
      if (!task || !att) continue;
      const b = this.#box(task, Number(att));
      b.next = Math.max(b.next, n);
    }
  }

  #box(task: string, attempt: number): Box {
    const k = `${task}:${attempt}`;
    let b = this.#boxes.get(k);
    if (!b) { b = new Box(task, attempt, join(this.#dir, `${task}-${attempt}.jsonl`)); this.#boxes.set(k, b); }
    return b;
  }

  /** The connection to the hub (undefined while it is away). Setting one sends what waited. */
  connect(send: Send | undefined) { this.#send = send; if (send) for (const b of this.#boxes.values()) void this.#flush(b); }

  push(task: string, attempt: number, ref: string | undefined, e: AgentEvent) {
    const b = this.#box(task, attempt);
    if (b.gone) return;
    if (ref) b.ref = ref;
    const ne: NodeEvent = { seq: b.next++, ts: Date.now(), e };
    b.q.push(ne);
    appendFileSync(b.file, JSON.stringify({ ...ne, ...(ref ? { ref } : {}) }) + "\n", { mode: 0o600 });
    void this.#flush(b);
  }

  /** Nothing waiting for this task (tests, drain). */
  empty(task?: string) { return [...this.#boxes.values()].every((b) => (task && b.task !== task) || b.q.length === 0); }

  async #flush(b: Box) {
    if (b.busy || !this.#send) return;
    b.busy = true;
    try {
      while (b.q.length && !b.gone) {
        const send = this.#send as Send | undefined;
        if (!send) break;
        const events = b.q.slice(0, BATCH);
        let r: TaskEventsRes | undefined;
        try { r = await send(b.task, { attempt: b.attempt, ...(b.ref ? { session_ref: b.ref } : {}), from_seq: events[0]!.seq, events }); }
        catch { r = undefined; }
        if (!r) break;                                  // hub away or refused: the spool keeps them, connect() retries
        if (r.dropped) { b.gone = true; b.q = []; }
        else b.q = b.q.filter((e) => e.seq > r.acked);
        this.#rewrite(b);
        this.onSeq(`${b.task}:${b.attempt}`, b.next);
      }
    } finally { b.busy = false; }
  }

  #rewrite(b: Box) {
    if (!b.q.length) { if (existsSync(b.file)) unlinkSync(b.file); return; }
    writeFileSync(b.file, b.q.map((e, i) => JSON.stringify({ ...e, ...(i === 0 && b.ref ? { ref: b.ref } : {}) }) + "\n").join(""), { mode: 0o600 });
  }
}
