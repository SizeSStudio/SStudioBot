// 本机的主替身：unix socket 收事件、记延迟，答 sbot 工具调用。用法：node lib/hub.ts <sock> <secret>
import net from "node:net";
import { readFrames, writeFrame } from "./frames.ts";

const [sock, secret] = process.argv.slice(2);
if (!sock || !secret) throw new Error("usage: hub.ts <sock> <secret>");

const latency = new Map<string, number[]>();
const calls: { session: string; name: string; args: any }[] = [];

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

net
  .createServer((s) => {
    s.on("error", () => {});
    readFrames(s, (m) => {
      // hrtime 是机器级单调时钟，跨进程可比。
      const now = process.hrtime.bigint();
      if (m.type === "event") {
        const xs = latency.get(m.agent) ?? [];
        xs.push(Number(now - BigInt(m.t)) / 1e6);
        latency.set(m.agent, xs);
      } else if (m.type === "tool_call") {
        calls.push({ session: m.session, name: m.name, args: m.args });
        writeFrame(s, { id: m.id, result: `pong ${secret} ${m.args?.note ?? ""}` });
      } else if (m.type === "calls") {
        writeFrame(s, { id: m.id, result: calls });
      } else if (m.type === "stats") {
        const out: Record<string, object> = {};
        for (const [agent, raw] of latency) {
          const xs = [...raw].sort((a, b) => a - b);
          out[agent] = { n: xs.length, p50_ms: pct(xs, 50), p95_ms: pct(xs, 95), max_ms: xs.at(-1) };
        }
        writeFrame(s, { id: m.id, result: out });
      }
    });
  })
  .listen(sock, () => process.stdout.write("ready\n"));
