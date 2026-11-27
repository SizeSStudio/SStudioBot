// 代理单独一个进程：只有它读密钥文件（SBOT_SECRETS）。发两个 run 令牌给探针进程。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { P, PROXY_PORT } from "../../core/src/config.ts";
import { startProxy, issueToken, revokeToken } from "../../core/src/proxy.ts";

const dir = join(P.home, "run");
mkdirSync(dir, { recursive: true, mode: 0o700 });
await startProxy(PROXY_PORT);

// 令牌绑一个档（另可用 light）：同家用 work 令牌（light↔work），跨家用 expert 令牌（light↔expert）
const issue = (tier: "work" | "expert") => issueToken({ runId: `p10_${tier}`, tier, requester: "system", budgetOutput: 30_000, ttlMs: 60 * 60_000 });
const tokens = { work: issue("work"), expert: issue("expert") };
writeFileSync(join(dir, "proxy.pid"), String(process.pid));
writeFileSync(join(dir, "tokens.json"), JSON.stringify(tokens), { mode: 0o600 });

const stop = () => { Object.values(tokens).forEach(revokeToken); process.exit(0); };
process.on("SIGTERM", stop);
setTimeout(stop, 60 * 60_000);
