// Which agents this machine has and how to start them (05 「配置」: node.yaml, else PATH). Capabilities are the P5–P8
// results (only what passed 3/3 is true, 08); hello reports them as they are, never what we wish.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { argv, type NodeConf } from "../config.ts";
import type { AgentAdapter, Caps } from "./types.ts";
import { claudeAdapter } from "./claude.ts";
import { codexAdapter } from "./codex.ts";
import { piAdapter } from "./pi.ts";
import { acpAdapter } from "./acp.ts";

export type Found = { kind: string; version?: string; caps: Caps; make: () => AgentAdapter };

function onPath(bin: string): string | undefined {
  if (bin.includes("/")) return existsSync(bin) ? bin : undefined;
  const r = spawnSync(process.platform === "win32" ? "where" : "sh", process.platform === "win32" ? [bin] : ["-c", `command -v -- "$0"`, bin], { encoding: "utf8", timeout: 5000 });
  const p = r.status === 0 ? r.stdout.split("\n")[0]?.trim() : "";
  return p || undefined;
}

function version(bin: string, args: string[] = []): string | undefined {
  const r = spawnSync(bin, [...args, "--version"], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  const m = /\d+\.\d+\.\d+[\w.-]*/.exec(`${r.stdout ?? ""}`);
  return r.status === 0 && m ? m[0] : undefined;
}

/** The SDK's own bundled Claude Code, when its platform package is installed. */
function sdkBundled(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const v = (req(pkg) as { version?: string }).version;
    return v ? `sdk ${v}` : undefined;
  } catch { return undefined; }
}

export function detect(conf: NodeConf, stateDir: string): Found[] {
  const ag = conf.agents ?? {};
  const want = (k: string) => !conf.only || conf.only.includes(k) || conf.only.includes(k.split(":")[0]!);
  const out: Found[] = [];
  const workerExec = conf.linux?.worker_exec;

  if (want("claude")) {
    const bin = ag.claude?.bin ? onPath(ag.claude.bin) : undefined;
    const sdk = sdkBundled();
    const v = bin ? version(bin) : sdk;
    if (bin || sdk) {
      out.push({
        kind: "claude", ...(v ? { version: v } : {}), caps: claudeAdapter().caps(),
        make: () => claudeAdapter({ ...(bin ? { bin } : {}), ...(ag.claude?.model ? { model: ag.claude.model } : {}), ...(workerExec ? { workerExec } : {}) }),
      });
    }
  }
  if (want("codex")) {
    const bin = onPath(ag.codex?.bin ?? "codex");
    if (bin) {
      const args = ag.codex?.args ?? [];
      out.push({ kind: "codex", ...(version(bin, args) ? { version: version(bin, args)! } : {}), caps: codexAdapter({ bin }).caps(), make: () => codexAdapter({ bin, args, ...(ag.codex?.model ? { model: ag.codex.model } : {}) }) });
    }
  }
  if (want("pi")) {
    const bin = onPath(ag.pi?.bin ?? "pi");
    if (bin) {
      const args = ag.pi?.args ?? [];
      const sessionDir = join(stateDir, "pi");
      out.push({ kind: "pi", ...(version(bin, args) ? { version: version(bin, args)! } : {}), caps: piAdapter({ bin, sessionDir }).caps(), make: () => piAdapter({ bin, args, sessionDir }) });
    }
  }
  for (const x of ag.acp ?? []) {
    const cmd = argv(x.cmd);
    if (!want(`acp:${x.name}`) || !cmd[0] || !onPath(cmd[0])) continue;
    out.push({ kind: `acp:${x.name}`, caps: acpAdapter({ name: x.name, cmd }).caps(), make: () => acpAdapter({ name: x.name, cmd }) });
  }
  return out;
}
