// 起主替身、造一次性 git 仓库、订阅事件、每项跑 3 次。
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentAdapter, AgentEvent, Answer, McpMount, PermissionRequest } from "../adapter.ts";
import { childEnv } from "./env.ts";
import { connect } from "./frames.ts";

export const ROOT = join(import.meta.dirname, "..");
export const nonce = (p: string) => `${p}${randomBytes(3).toString("hex").toUpperCase()}`;
export const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export type Hub = Awaited<ReturnType<typeof startHub>>;

export async function startHub() {
  // macOS 的 unix socket 路径上限约 104 字节，放 /tmp 短目录。
  const sock = join(mkdtempSync("/tmp/sbh-"), "hub.sock");
  const secret = nonce("S");
  const proc = spawn(process.execPath, [join(ROOT, "lib/hub.ts"), sock, secret], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((ok, fail) => {
    proc.stdout.once("data", () => ok());
    proc.once("exit", () => fail(new Error("hub died")));
  });
  return attachHub(sock, secret, () => proc.kill());
}

export async function attachHub(sock: string, secret: string, stop = () => {}) {
  const link = await connect(sock);
  const mount: McpMount = {
    command: process.execPath,
    args: [join(ROOT, "lib/mcp-stdio.ts"), "--session", "probe"],
    env: { SBOT_SOCK: sock },
    call: (name, args) => link.request<string>({ type: "tool_call", session: "inproc", name, args }),
  };
  return {
    sock,
    secret,
    mount,
    event: (agent: string, e: AgentEvent) => link.send({ type: "event", agent, t: process.hrtime.bigint().toString(), e }),
    calls: () => link.request<{ session: string; name: string; args: any }[]>({ type: "calls" }),
    stats: () => link.request<Record<string, { n: number; p50_ms: number; p95_ms: number; max_ms: number }>>({ type: "stats" }),
    stop: () => {
      link.close();
      stop();
    },
  };
}

// 每次尝试一个目录：repo/ 是 agent 的 cwd，state/ 放各家的会话文件。
export function scratch(): { cwd: string; state: string } {
  const base = mkdtempSync("/tmp/sbp-");
  const cwd = join(base, "repo");
  const state = join(base, "state");
  mkdirSync(cwd);
  mkdirSync(state);
  writeFileSync(join(cwd, "README.md"), "scratch\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=probe", "-c", "user.email=probe@localhost", "-c", "core.hooksPath=/dev/null", ...a], { cwd, env: childEnv() });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { cwd, state };
}

export type Policy = (r: PermissionRequest, k: "permission" | "ask") => Answer;

const SAFE = /^(sleep \d+|touch second\.txt)$/;
// 默认只放行探针要用的命令和 sbot 工具。
export const defaultPolicy: Policy = (r) => {
  if (/sbot/.test(r.title)) return { option_id: "allow" };
  const inner = r.detail.match(/-l?c\s+(['"])([\s\S]*)\1\s*$/)?.[2] ?? r.detail;
  const ok = inner.split(/&&|;|\n/).every((c) => SAFE.test(c.trim()));
  return { option_id: ok ? "allow" : "deny" };
};

export function watch(agent: string, hub: Hub, adapter: AgentAdapter, ref: string, policy: Policy = defaultPolicy) {
  const events: AgentEvent[] = [];
  const wake = new Set<() => void>();
  const dump = process.env.PROBE_DUMP;
  const t0 = Date.now();
  adapter.subscribe(ref, (e) => {
    hub.event(agent, e);
    events.push(e);
    // 排查用：PROBE_DUMP=<文件> 记下增量以外的事件。
    if (dump && e.k !== "text") appendFileSync(dump, `${Date.now() - t0} ${JSON.stringify(e).slice(0, 700)}\n`);
    if (e.k === "permission" || e.k === "ask") queueMicrotask(() => void adapter.respondToPermission(ref, e.request.request_id, policy(e.request, e.k as any)));
    for (const w of wake) w();
  });
  let cursor = 0;
  async function waitFor<T extends AgentEvent>(pred: (e: AgentEvent) => boolean, ms = 90_000, from = cursor): Promise<T> {
    const end = Date.now() + ms;
    let i = from;
    while (true) {
      for (; i < events.length; i++) if (pred(events[i])) return events[i] as T;
      if (Date.now() > end) throw new Error(`timeout after ${ms}ms; last events: ${JSON.stringify(events.slice(-4)).slice(0, 600)}`);
      await new Promise<void>((ok) => {
        const done = () => {
          clearTimeout(timer);
          wake.delete(done);
          ok();
        };
        const timer = setTimeout(done, 500);
        wake.add(done);
      });
    }
  }
  // 等当前这一轮结束，返回这一轮的全部事件和助手文字。
  async function turn(ms = 120_000) {
    const from = cursor;
    const end = await waitFor<Extract<AgentEvent, { k: "turn_end" }>>((e) => e.k === "turn_end", ms, from);
    cursor = events.indexOf(end) + 1;
    const slice = events.slice(from, cursor);
    const text = slice.flatMap((e) => (e.k === "message" ? [e.text] : [])).join("\n");
    return { end, text, events: slice };
  }
  return { events, waitFor, turn, cursor: () => cursor };
}

export type Verdict = { ok: boolean; note: string };
export type Case = { id: string; title: string; run: () => Promise<Verdict> };

export async function runCases(agent: string, cases: Case[], times = 3) {
  const out: { id: string; title: string; pass: string; attempts: (Verdict & { ms: number })[] }[] = [];
  for (const c of cases) {
    const attempts: (Verdict & { ms: number })[] = [];
    for (let n = 1; n <= times; n++) {
      const t0 = Date.now();
      let v: Verdict;
      let timer: NodeJS.Timeout | undefined;
      try {
        v = await Promise.race([
          c.run(),
          new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error("attempt timeout 240s")), 240_000))),
        ]);
      } catch (e) {
        v = { ok: false, note: String((e as Error).message ?? e).slice(0, 900) };
      } finally {
        clearTimeout(timer);
      }
      attempts.push({ ...v, ms: Date.now() - t0 });
      console.log(`[${agent}] ${c.id} #${n} ${v.ok ? "ok" : "FAIL"} ${attempts.at(-1)!.ms}ms ${v.note}`);
    }
    out.push({ id: c.id, title: c.title, pass: `${attempts.filter((a) => a.ok).length}/${times}`, attempts });
  }
  return out;
}
