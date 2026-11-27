// P9 runner. Needs a TEST app (never the live one). See README.md.
//   P9_CREDENTIALS=<path> node run.ts clicks|netcut|stream --backend sdk|cli [options]
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Deduper, loadCreds, makeRedactor, describeError } from "./core.ts";
import type { Backend } from "./core.ts";
import { SdkBackend } from "./backend-sdk.ts";
import { CliBackend } from "./backend-cli.ts";
import { CutProxy } from "./proxy.ts";
import type { CutMode } from "./proxy.ts";
import { assertNoOtherConnection, runClicks, runNetcut, runStream } from "./scenarios.ts";

const USAGE = `usage: P9_CREDENTIALS=<json path> node run.ts <clicks|netcut|stream> --backend <sdk|cli>
  clicks  [--clicks 50] [--timeout-s 900]
  netcut  [--baseline-s 20] [--cut-s 30] [--mode reset|stall] [--settle-s 360]
  stream  [--duration-s 120] [--rate 2]
  env: P9_LARK_CLI=<path to lark-cli> (cli backend), P9_STATE=<dir for the dedupe file>, P9_ALLOW_UNKNOWN_CONNECTIONS=1`;

async function main() {
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: { backend: { type: "string" }, clicks: { type: "string" }, "timeout-s": { type: "string" }, "baseline-s": { type: "string" },
      "cut-s": { type: "string" }, mode: { type: "string" }, "settle-s": { type: "string" }, "duration-s": { type: "string" }, rate: { type: "string" }, help: { type: "boolean" } },
  });
  const scenario = positionals[0];
  if (v.help || !["clicks", "netcut", "stream"].includes(scenario ?? "") || !["sdk", "cli"].includes(v.backend ?? "")) { console.error(USAGE); process.exit(v.help ? 0 : 64); }

  const creds = loadCreds(process.env.P9_CREDENTIALS);
  const redact = makeRedactor([creds.app_secret, creds.app_id, creds.chat_id]);
  const say = (l: string) => console.error(redact(l));
  const num = (s: string | undefined, d: number) => (s === undefined ? d : Number(s));
  const dedupe = new Deduper(join(process.env.P9_STATE ?? join(tmpdir(), "p9-state"), `dedupe-${v.backend}-${scenario}.txt`));

  const proxy = scenario === "netcut" ? new CutProxy() : undefined;
  if (proxy) await proxy.listen();
  const proxyUrl = proxy?.url;
  const b: Backend = v.backend === "sdk"
    ? new SdkBackend({ creds, say, proxyUrl })
    : new CliBackend({ creds, say, bin: process.env.P9_LARK_CLI ?? "lark-cli", proxyUrl });

  let report: Record<string, unknown>;
  try {
    await assertNoOtherConnection(b, say, process.env.P9_ALLOW_UNKNOWN_CONNECTIONS === "1");
    if (scenario === "clicks") report = await runClicks(b, { chatId: creds.chat_id, target: num(v.clicks, 50), timeoutMs: num(v["timeout-s"], 900) * 1000, dedupe, say });
    else if (scenario === "netcut") report = await runNetcut(b, proxy!, { chatId: creds.chat_id, baselineMs: num(v["baseline-s"], 20) * 1000, cutMs: num(v["cut-s"], 30) * 1000,
      mode: (v.mode ?? "reset") as CutMode, settleMs: num(v["settle-s"], 360) * 1000, dedupe, say });
    else report = await runStream(b, { chatId: creds.chat_id, durationMs: num(v["duration-s"], 120) * 1000, perSec: num(v.rate, 2), say });
  } finally {
    await b.close();
    await proxy?.close();
  }
  console.log(redact(JSON.stringify(report, null, 2)));
  const pass = Object.values((report.pass ?? {}) as Record<string, unknown>);
  process.exit(pass.every((x) => x === true) ? 0 : 2);
}

main().catch((e) => { console.error(`p9: ${describeError(e)}`); process.exit(1); });
