// 用法：node run.ts <claude|codex|pi|acp> [项…]；TIMES=1 先试跑。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acpAdapter } from "./adapters/acp.ts";
import { acpCommand, acpEnv } from "./agents.ts";
import { p5 } from "./cases/p5-claude.ts";
import { p6 } from "./cases/p6-codex.ts";
import { p7 } from "./cases/p7-pi.ts";
import { p8 } from "./cases/p8-acp.ts";
import { childEnv } from "./lib/env.ts";
import { ROOT, runCases, scratch, startHub } from "./lib/harness.ts";

const groups = { claude: p5, codex: p6, pi: p7, acp: p8 };
const [name, ...only] = process.argv.slice(2);
const group = groups[name as keyof typeof groups];
if (!group) throw new Error(`usage: node run.ts <${Object.keys(groups).join("|")}> [case…]`);

const pkg = (n: string) => JSON.parse(readFileSync(join(ROOT, "node_modules", n, "package.json"), "utf8")).version as string;
const cli = (n: string) => execFileSync(n, ["--version"], { env: childEnv(), stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const versions: Record<string, string> = { node: process.version };
if (name === "claude") Object.assign(versions, { "claude-agent-sdk": pkg("@anthropic-ai/claude-agent-sdk") });
if (name === "codex") versions.codex = cli("codex");
if (name === "pi") versions.pi = cli("pi") || "see pi --version";
if (name === "acp")
  Object.assign(versions, { acpx: pkg("acpx"), "acp-sdk": pkg("@agentclientprotocol/sdk"), "claude-agent-acp": pkg("@agentclientprotocol/claude-agent-acp") });

const hub = await startHub();
const extra: Record<string, unknown> = {};
if (name === "acp") {
  const a = acpAdapter({ command: acpCommand, env: acpEnv(scratch().state) });
  const ref = await a.createSession({ cwd: scratch().cwd, mcp: hub.mount, prompt: "Reply with just OK." });
  extra.agentCapabilities = a.agentCapabilities();
  await a.release(ref);
}
const cases = group(hub).filter((c) => !only.length || only.includes(c.id));
const results = await runCases(name, cases, Number(process.env.TIMES ?? 3));
const latency = await hub.stats();
hub.stop();

mkdirSync(join(ROOT, "results"), { recursive: true });
const out = { versions, ...extra, results, latency };
writeFileSync(join(ROOT, "results", `${name}${only.length ? `-${only.join("+").replaceAll(":", "_")}` : ""}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ versions, ...extra, summary: Object.fromEntries(results.map((r) => [r.id, r.pass])), latency }, null, 2));
process.exit(0);
