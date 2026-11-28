// 各家通用的三项：轮内插话、杀进程后续接、sbot MCP。
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { make, type AgentName } from "../agents.ts";
import { nonce, ROOT, scratch, sleep, watch, type Case, type Hub } from "../lib/harness.ts";

const argText = (args: unknown) => JSON.stringify(args ?? "");

export const steerCase = (agent: AgentName, hub: Hub): Case => ({
  id: "steer",
  title: "插话在本轮的下一个工具边界生效",
  async run() {
    const { cwd, state } = scratch();
    const { adapter, dispose } = make(agent, state);
    const word = nonce("W");
    const ref = await adapter.createSession({
      cwd,
      mcp: hub.mount,
      // 两条命令必须分在两次回复里：并行发出就没有工具边界可言（探针第一版踩过）。
      prompt: "Step 1: use your shell tool to run exactly `sleep 6`, and issue no other tool call in that same response. Step 2: only after step 1 has returned its result, in a later response, run exactly `touch second.txt`. Then reply DONE.",
    });
    try {
      const w = watch(agent, hub, adapter, ref);
      await w.waitFor((e) => e.k === "tool_start" && argText(e.args).includes("sleep 6"));
      await sleep(1500);
      const sent = await adapter.steer(ref, `Change of plan from me: do not run the touch command. Reply with exactly the word ${word} and stop.`);
      const t = await w.turn();
      await sleep(4000); // 被排成下一轮的话，这里会多出第二个 turn_end
      const turns = w.events.filter((e) => e.k === "turn_end").length;
      const touched = existsSync(join(cwd, "second.txt"));
      const said = t.text.includes(word);
      return { ok: sent && said && !touched && turns === 1, note: `sent=${sent} said_in_turn=${said} second_cmd_ran=${touched} turns=${turns} stop=${t.end.stop}` };
    } finally {
      await adapter.release(ref);
      dispose();
    }
  },
});

export const mcpCase = (agent: AgentName, hub: Hub): Case => ({
  id: "mcp",
  title: "sbot MCP 工具能调",
  async run() {
    const { cwd, state } = scratch();
    const { adapter, dispose } = make(agent, state);
    const note = nonce("N");
    const ref = await adapter.createSession({
      cwd,
      mcp: hub.mount,
      prompt: `Call the MCP tool sbot_ping (server "sbot") with note "${note}". Then reply with exactly the text the tool returned.`,
    });
    try {
      const w = watch(agent, hub, adapter, ref);
      const t = await w.turn();
      const called = (await hub.calls()).some((c) => c.args?.note === note);
      const echoed = t.text.includes(hub.secret);
      const asked = t.events.flatMap((e) => (e.k === "permission" ? [e.request.title] : []));
      return { ok: called && echoed, note: `hub_called=${called} reply_has_token=${echoed} permission_requests=${JSON.stringify(asked)} ${t.end.error ?? ""}` };
    } finally {
      await adapter.release(ref);
      dispose();
    }
  },
});

function descendants(pid: number): number[] {
  const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid="]).toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const all = [pid];
  for (let i = 0; i < all.length; i++) for (const [c, p] of rows) if (p === all[i]) all.push(c);
  return all;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// 子进程里起 session，跑到一半把整棵进程树 SIGKILL，返回 session_ref。
export async function startAndKill(agent: AgentName, hub: Hub, cwd: string, state: string, codeword: string) {
  const child = spawn(process.execPath, [join(ROOT, "cases/kill-child.ts"), agent, cwd, state, hub.sock, hub.secret, codeword], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const ref = await new Promise<string>((ok, fail) => {
    child.stdout.on("data", (d) => {
      out += d;
      const m = out.match(/^REF (.+)$/m);
      if (m) ok(m[1]);
    });
    child.on("exit", (code) => fail(new Error(`child exited ${code}: ${err.slice(-500)}`)));
  });
  const tree = descendants(child.pid!);
  for (const p of tree) if (alive(p)) process.kill(p, "SIGKILL");
  await sleep(1500);
  const left = tree.filter(alive);
  if (left.length) throw new Error(`processes survived: ${left}`);
  return { ref, killed: tree.length };
}

export const resumeCase = (agent: AgentName, hub: Hub, extra?: (a: unknown) => string): Case => ({
  id: "resume",
  title: "轮次中途杀进程后续接，问得出我之前说了什么",
  async run() {
    const { cwd, state } = scratch();
    const codeword = nonce("C");
    const { ref, killed } = await startAndKill(agent, hub, cwd, state, codeword);
    const { adapter, dispose } = make(agent, state);
    try {
      await adapter.resumeSession(ref, { cwd, mcp: hub.mount });
      const w = watch(agent, hub, adapter, ref, () => ({ option_id: "deny" }));
      await adapter.startTurn(ref, "Without running any tools: quote my previous two messages to you, verbatim.");
      const t = await w.turn();
      const first = t.text.includes(codeword);
      const second = t.text.includes("sleep 30");
      return { ok: first && second, note: `killed_processes=${killed} recalls_codeword=${first} recalls_interrupted_msg=${second} ${extra?.(adapter) ?? ""} ${t.end.error ?? ""}` };
    } finally {
      await adapter.release(ref).catch(() => {});
      dispose();
    }
  },
});
