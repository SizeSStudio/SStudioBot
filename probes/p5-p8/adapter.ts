// 适配器接口（05「适配器」，Paseo 的形状）和统一事件。四家探针共用，W4 搬进 node/src/adapters/。
import { randomUUID } from "node:crypto";

export type PermissionRequest = {
  request_id: string;
  title: string;
  detail: string; // 完整的命令、路径、参数，不截断
  options: { id: string; label: string }[];
  questions?: unknown; // 只有 ask 带
};
export type Answer = { option_id: string; text?: string };

export type AgentEvent =
  | { k: "text"; item: string; delta: string }
  | { k: "message"; item: string; text: string }
  | { k: "tool_start"; item: string; name: string; args: unknown }
  | { k: "tool_end"; item: string; ok: boolean; result?: unknown; diff?: string }
  | { k: "permission"; request: PermissionRequest }
  | { k: "ask"; request: PermissionRequest }
  | { k: "turn_end"; stop: "done" | "interrupted" | "error"; error?: string }
  | { k: "usage"; input_tokens?: number; output_tokens?: number; ms?: number }
  | { k: "quota"; resets_at?: number; remaining?: unknown }
  | { k: "progress"; text: string };

// 一个 session 要挂的 sbot MCP：stdio 小程序的起法，加 in-process 调用（只有 Claude 用）。
export type McpMount = {
  command: string;
  args: string[];
  env: Record<string, string>;
  call(name: string, args: Record<string, unknown>): Promise<string>;
};

export type Caps = { steer: boolean; resume: boolean; rewind: boolean; permissions: boolean; ask: boolean };

export interface AgentAdapter {
  caps(): Caps;
  createSession(o: { cwd: string; prompt: string; mcp: McpMount }): Promise<string>;
  resumeSession(ref: string, o: { cwd: string; mcp: McpMount }): Promise<void>;
  startTurn(ref: string, text: string): Promise<void>;
  steer(ref: string, text: string): Promise<boolean>;
  interrupt(ref: string): Promise<void>;
  subscribe(ref: string, on: (e: AgentEvent) => void): () => void;
  getPendingPermissions(ref: string): PermissionRequest[];
  respondToPermission(ref: string, id: string, answer: Answer): Promise<void>;
  release(ref: string): Promise<void>;
}

// 事件缓冲（订阅晚了也不丢）和未答的权限请求。
export class Channel {
  private history: AgentEvent[] = [];
  private listeners = new Set<(e: AgentEvent) => void>();
  private pending = new Map<string, { request: PermissionRequest; resolve: (a: Answer) => void }>();

  emit(e: AgentEvent): void {
    this.history.push(e);
    for (const on of this.listeners) on(e);
  }
  subscribe(on: (e: AgentEvent) => void): () => void {
    for (const e of this.history) on(e);
    this.listeners.add(on);
    return () => this.listeners.delete(on);
  }
  request(k: "permission" | "ask", r: Omit<PermissionRequest, "request_id">): Promise<Answer> {
    const request = { request_id: randomUUID(), ...r };
    return new Promise((resolve) => {
      this.pending.set(request.request_id, { request, resolve });
      this.emit({ k, request });
    });
  }
  pendingList(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }
  respond(id: string, answer: Answer): void {
    const p = this.pending.get(id);
    if (!p) throw new Error(`no pending request ${id}`);
    this.pending.delete(id);
    p.resolve(answer);
  }
}

export const ALLOW_DENY = [
  { id: "allow", label: "允许" },
  { id: "deny", label: "拒绝" },
];
