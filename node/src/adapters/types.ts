// The adapter interface (05 「适配器」, Paseo's shape) and what all four share: an event buffer per session and the
// open permission requests. Events are protocol/node/v1.ts AgentEvent; the session manager (sessions.ts) numbers and
// sends them. A request the agent makes for our own sbot MCP tool is marked `own`: the gate is on the hub, so the node
// answers it itself (08 P6/P8) and never makes a card of it.
import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionOption, PermissionRequest } from "../../../protocol/node/v1.ts";

export type { AgentEvent, PermissionOption, PermissionRequest };

export type Caps = { steer: boolean; resume: boolean; rewind: boolean; permissions: boolean; ask: boolean };

/** How an agent reaches the sbot MCP: the stdio program (`sbot-node mcp`) and its environment. */
export type McpMount = { command: string; args: string[]; env: Record<string, string>; tools: string[] };

export type Answer = { option_id?: string; text?: string; answers?: Record<string, string> };

export interface OpenOpts { cwd: string; mcp: McpMount; env: Record<string, string>; mode?: string }

export interface AgentAdapter {
  readonly kind: string;
  caps(): Caps;
  /** → session_ref. The first turn (prompt) is started; its events go to subscribe(). */
  createSession(o: OpenOpts & { prompt: string }): Promise<string>;
  /** Throws when the agent can't take this session back (the caller opens a fresh one with the handoff). */
  resumeSession(ref: string, o: OpenOpts): Promise<void>;
  startTurn(ref: string, text: string): Promise<void>;
  /** false = the agent can't take it this turn (ACP); the hub sends it as the next turn and the UI says so. */
  steer(ref: string, text: string): Promise<boolean>;
  interrupt(ref: string): Promise<void>;
  subscribe(ref: string, on: (e: AgentEvent) => void): () => void;
  getPendingPermissions(ref: string): PermissionRequest[];
  respondToPermission(ref: string, id: string, answer: Answer): Promise<void>;
  /** Let the process go, keep the session (the agent's own storage). */
  release(ref: string): Promise<void>;
  /** The agent's process for this session, when it has its own. */
  pid?(ref: string): number | undefined;
  /** Called once when the session's process ended on its own (crash, kill): sessions.ts reports it. */
  onExit?: (ref: string, why: string) => void;
}

/** A rejected answer: the agent's own reject option, or the bare `reject` the hub sends when the agent offered none. */
export function isReject(a: Answer, options: PermissionOption[]): boolean {
  // no option chosen is a no, even with text: my words alone (「别这样，换个办法」) are a reason, never a yes; asks
  // (answers) don't come through here
  if (!a.option_id) return true;
  if (a.option_id === "reject") return true;
  const o = options.find((x) => x.id === a.option_id);
  if (!o) return true;                                // an id the agent never offered: fail closed
  return /^(reject|deny)/.test(o.kind ?? o.id);
}

/** The options we show for agents that ask without offering any (Claude, Codex): once only, never "always" ※. */
export const ONCE: PermissionOption[] = [
  { id: "allow_once", label: "这次可以", kind: "allow_once" },
  { id: "reject_once", label: "不行", kind: "reject_once" },
];

type Pending = { request: PermissionRequest; resolve: (a: Answer) => void };

/**
 * One session's events and open requests. Events wait in a buffer until the first subscriber (an agent may speak
 * before createSession has returned its ref), then flow straight through.
 */
export class Channel {
  #buf: AgentEvent[] | null = [];
  #on = new Set<(e: AgentEvent) => void>();
  #pending = new Map<string, Pending>();

  emit(e: AgentEvent) {
    if (this.#buf) { this.#buf.push(e); return; }
    for (const on of this.#on) on(e);
  }

  subscribe(on: (e: AgentEvent) => void): () => void {
    this.#on.add(on);
    if (this.#buf) { const b = this.#buf; this.#buf = null; for (const e of b) on(e); }
    return () => { this.#on.delete(on); };
  }

  /** Ask the hub (through sessions.ts) and wait — no timeout (§办3.3). */
  request(kind: "permission" | "ask", r: Omit<PermissionRequest, "id" | "kind">): Promise<Answer> {
    const request: PermissionRequest = { id: randomUUID(), kind, ...r };
    return new Promise((resolve) => {
      this.#pending.set(request.id, { request, resolve });
      this.emit({ k: kind, request });
    });
  }

  pending(): PermissionRequest[] { return [...this.#pending.values()].map((p) => p.request); }

  respond(id: string, a: Answer): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);
    p.resolve(a);
    return true;
  }

  /** The process died: every open request is void (the agent can't take the answer any more). */
  dropPending() {
    for (const p of this.#pending.values()) p.resolve({ option_id: "reject" });
    this.#pending.clear();
  }
}

/** A session table every adapter keeps. */
export class Table<S> {
  #m = new Map<string, S>();
  get(ref: string): S { const s = this.#m.get(ref); if (!s) throw new Error(`没有这个 session：${ref}`); return s; }
  find(ref: string): S | undefined { return this.#m.get(ref); }
  set(ref: string, s: S) { this.#m.set(ref, s); }
  delete(ref: string) { this.#m.delete(ref); }
  get size() { return this.#m.size; }
}

/** Short text for an error, never the whole stack. */
export const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 2000);

/** A Unix time from an agent → ms (agents give seconds; anything already in ms passes). */
export const toMs = (t: unknown): number | undefined => {
  const n = typeof t === "number" ? t : typeof t === "string" && /^\d+(\.\d+)?$/.test(t) ? Number(t) : typeof t === "string" ? Date.parse(t) : NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n < 1e12 ? n * 1000 : n);
};
