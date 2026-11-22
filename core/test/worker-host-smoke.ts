// Host-mode worker smoke on the VPS (DESIGN §办1.3, §底3.6), after deploy/worker/install.sh has created sbot-h:
//
//   ssh <server> 'bash -s' < test/vps-test-home.sh test/worker-host-smoke.ts 7830
//
// Uses its own shared dir (/srv/data/sbot-shared/test-<stamp>) so the live skills plugin isn't touched. Checks:
//   1. the worker runs as sbot-h on the host: sudo works, the root fs is writable through sudo (not the core's
//      read-only namespace), public HTTPS and the tailnet (100.100.100.100) are reachable
//   2. a skill from config/skills is loaded and used
//   3. the core guard denies reading the core's files (secrets.env) even with sudo
//   4. the task finishes with a report

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

process.env.SBOT_SHARED = `/srv/data/sbot-shared/test-${Date.now().toString(36)}`;
const { P } = await import("../src/config.ts");
const { one, kvSet } = await import("../src/db.ts");
const { startProxy } = await import("../src/proxy.ts");
const { ensureAgentHome } = await import("../src/memory.ts");
const { hooks } = await import("../src/approvals.ts");
const { TaskEngine, startTask, getTask } = await import("../src/tasks.ts");

const ok = (cond: unknown, what: string) => { console.log(`${cond ? "PASS" : "FAIL"} ${what}`); if (!cond) process.exitCode = 1; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, f: () => boolean, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (f()) return true; await sleep(1000); }
  console.log(`  (timed out waiting for ${what})`);
  return false;
}

for (const d of [P.sessions, P.logs]) mkdirSync(d, { recursive: true });
ensureAgentHome(join(import.meta.dirname, "..", "seed", "agent-home"));
mkdirSync(join(P.config, "skills", "sbot-probe"), { recursive: true });
writeFileSync(join(P.config, "skills", "sbot-probe", "SKILL.md"), `---
name: sbot-probe
description: Probe skill for the SStudioBot host-worker smoke test. Use when the task says to use sbot-probe.
---
Write exactly the text PINEAPPLE-42 (and nothing else) into ./skill.txt in the current directory.
`);
writeFileSync(join(P.config, "worker.yaml"), "default_mode: host\nssh_hosts:\n  - name: probe\n    host: 127.0.0.1\n");

// task dirs live outside the test home: start at a random high id so we never reuse an old or a live task's dir
kvSet("task.seq", String(900_000 + Math.floor(Math.random() * 99_000)));
const proxy = await startProxy();
hooks.kickDispatcher = () => {};
const engine = new TaskEngine();
engine.start();

const script = [
  "whoami", "sudo -n id -u",
  "sudo -n touch /usr/local/sbin/.sbot-h-probe && sudo -n rm /usr/local/sbin/.sbot-h-probe && echo rootfs-writable",
  "echo https-$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://example.com)",
  "ping -c1 -W3 100.100.100.100 >/dev/null && echo tailnet-ok",
].join("; ");
const id = startTask({
  goal: `测试任务，严格按步骤做：
1. 用 Bash 跑这一行，把完整输出写进 ./results.txt：${script}
2. 用 sbot-probe 这个 skill，按它说的做。
3. 用 Bash 跑 \`wc -c /srv/sbot/secrets.env\`。不管成功还是被拒，把发生了什么用一句话写进 ./guard.txt。不要尝试任何别的办法读它。
4. 交报告。`,
  originLane: "test:host", timeoutMin: 15,
});
console.log(`task #${id}`);
ok(getTask(id)?.mode === "host", "default mode from worker.yaml is host");
await until("done", () => ["done", "failed", "cancelled", "needs_input"].includes(getTask(id)?.status), 12 * 60_000);
const t = getTask(id)!;
ok(t.status === "done", `task done (${t.status} ${t.error ?? ""})`);
ok(/^\/srv\/data\/sbot-h\/tasks\//.test(t.workdir ?? ""), `task dir under sbot-h (${t.workdir})`);
const rd = (f: string) => { try { return readFileSync(join(t.workdir, f), "utf8"); } catch { return ""; } };
const res = rd("results.txt");
console.log(res.trim().split("\n").map((l) => `  | ${l}`).join("\n"));
ok(/^sbot-h$/m.test(res), "runs as sbot-h");
ok(/^0$/m.test(res), "sudo works");
ok(/rootfs-writable/.test(res), "root fs writable through sudo (host namespace, not the core's)");
ok(/https-(200|30\d)/.test(res), "public HTTPS reachable");
ok(/tailnet-ok/.test(res), "tailnet reachable");
ok(rd("skill.txt").trim() === "PINEAPPLE-42", "skill from config/skills loaded and used");
const guard = rd("guard.txt");
console.log(`  guard.txt: ${guard.trim()}`);
ok(guard && !/^\s*\d+\s+\/srv\/sbot\/secrets\.env/m.test(guard) && /拒|deny|denied|核心|不碰|block/i.test(guard), "core guard denied secrets.env");
ok(existsSync(join(process.env.SBOT_SHARED!, "ssh_config")) && /Host probe/.test(readFileSync(join(process.env.SBOT_SHARED!, "ssh_config"), "utf8")), "ssh_config written from worker.yaml");
const u = one("SELECT COUNT(*) n, SUM(output_tokens) o FROM usage WHERE run_id LIKE ?", `tr_${id}_%`)!;
console.log(`  worker usage: ${u.n} calls, out ${u.o}`);

await engine.stop(5000);
proxy.close();
console.log(process.exitCode ? "HOST SMOKE FAILED" : "HOST SMOKE OK");
process.exit();
