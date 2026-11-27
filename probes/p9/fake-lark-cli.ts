#!/usr/bin/env node
// Test double for lark-cli, only as much as backend-cli.ts uses: `event consume <key>` and `api METHOD path`.
// It forwards to the mock server named by FAKE_LARK_BASE. It never prints any credential variable.
import { appendFileSync } from "node:fs";

const [cmd, ...rest] = process.argv.slice(2);
const base = process.env.FAKE_LARK_BASE!;
if (process.env.FAKE_LARK_DUMP) {
  appendFileSync(process.env.FAKE_LARK_DUMP, JSON.stringify({
    cmd, home: process.env.HOME, config_dir: process.env.LARKSUITE_CLI_CONFIG_DIR,
    has_app_env: !!process.env.LARKSUITE_CLI_APP_ID && !!process.env.LARKSUITE_CLI_APP_SECRET, proxy: process.env.HTTPS_PROXY ?? null,
  }) + "\n");
}

if (cmd === "event" && rest[0] === "consume") {
  const key = rest[1]!;
  const res = await fetch(`${base}/__fake/events?key=${encodeURIComponent(key)}`);
  process.stderr.write(`[event] ready event_key=${key}\n`);
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) process.stdout.write(line + "\n"); }
  }
  process.exit(1);
} else if (cmd === "event") {
  process.exit(0);                                  // event stop …
} else if (cmd === "api") {
  const [method, path] = rest as [string, string];
  const flag = (n: string) => { const i = rest.indexOf(n); return i < 0 ? undefined : rest[i + 1]; };
  const params = flag("--params");
  let body: string | undefined;
  if (flag("--data") === "-") { const cs: Buffer[] = []; for await (const c of process.stdin) cs.push(c as Buffer); body = Buffer.concat(cs).toString(); }
  const url = new URL(path, base);
  if (params) for (const [k, v] of Object.entries(JSON.parse(params))) url.searchParams.set(k, String(v));
  const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body });
  const j: any = await r.json().catch(() => ({ code: r.status, msg: "non-JSON" }));
  if (!r.ok || j.code !== 0) {
    console.error(JSON.stringify({ ok: false, identity: "bot", error: { type: "api_error", code: j.code, message: String(j.msg ?? "") } }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, identity: "bot", data: j.data ?? {} }));
} else {
  console.error("fake lark-cli: unsupported command");
  process.exit(64);
}
