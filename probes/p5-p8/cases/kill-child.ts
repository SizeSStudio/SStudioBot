// 被续接探针杀掉的那个「节点进程」。
import { make, type AgentName } from "../agents.ts";
import { attachHub, watch } from "../lib/harness.ts";

const [agent, cwd, state, sock, secret, codeword] = process.argv.slice(2);
const hub = await attachHub(sock, secret);
const { adapter } = make(agent as AgentName, state);
const ref = await adapter.createSession({ cwd, mcp: hub.mount, prompt: `My codeword is ${codeword}. Reply with just OK.` });
const w = watch(agent, hub, adapter, ref);
const first = await w.turn();
if (first.end.stop !== "done") throw new Error(`first turn: ${first.end.error}`);
await adapter.startTurn(ref, "Use your shell tool to run exactly `sleep 30`, then reply DONE.");
await w.waitFor((e) => e.k === "tool_start" && JSON.stringify(e.args ?? "").includes("sleep 30"));
await new Promise((ok) => setTimeout(ok, 2000));
process.stdout.write(`REF ${ref}\n`);
setInterval(() => {}, 1000);
