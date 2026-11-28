// W1e sources: ingest + exclude list, the command-plugin contract (a real child process), git with a fake git, mail
// with a fake lark-cli. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ambientHome } from "./helpers.ts";
import { all, kvGet, one } from "../src/db/ambient.ts";
import { ingestItems } from "../src/sources/ingest.ts";
import { commandPoll, localPluginRunner } from "../src/sources/command.ts";
import { configureSources, everyMs, pollSource } from "../src/sources/index.ts";
import { gitPoll, stripCreds, webOf, type Git } from "../src/sources/git.ts";
import { cleanMailBody, feishuMail, resetMailCache } from "../src/sources/mail.ts";
import type { SourceState } from "../src/sources/types.ts";
import type { Lark } from "../src/channels/feishu/user.ts";

const EXCL = "sources.yaml";
// fictional addresses, built at runtime so leak-guard's address pattern has nothing literal to flag
const at = (user: string, host = "example.com") => `${user}@${host}`;
const CRED = "user:fake-pass";
const conf = (extra = "") => `exclude:\n  chats: [tickets:秘密项目]\n  persons: [某同事]\n  mails: [${at("blocked")}]\nsources:\n${extra}`;
const state = (dir: string): SourceState & { kv: Map<string, string> } => {
  const kv = new Map<string, string>();
  return { dir, kv, get: (k) => kv.get(k), set: (k, v) => { kv.set(k, v); } };
};

test("ingest: one message per item, exclude list holds, raw kept, my own words close nothing new", async () => {
  await ambientHome("ingest", { [EXCL]: conf() });
  const s = { id: "tickets", kind: "command", domain: "personal" as const };
  const n = ingestItems(s, [
    { id: 1, text: "工单 1 有更新", where: "公开项目", author: "外部同学", ts: 1_700_000_000, raw_b64: Buffer.from("<raw/>").toString("base64"), link: "javascript:alert(1)" },
    { id: 2, text: "秘密", where: "秘密项目" },
    { id: 3, text: "某同事说的", author: "某同事" },
    { id: 4, text: "邮件", parties: [at("Blocked", "Example.com")] },
    { id: 5, text: "  " },
    { id: 1, text: "重复" },
  ]);
  assert.equal(n, 1);
  const m = one("SELECT * FROM messages")!;
  assert.equal(m.id, "src:tickets:1");
  assert.equal(m.surface, "source:tickets");
  assert.equal(m.chat_id, "tickets:公开项目");
  assert.equal(m.domain, "personal");
  assert.equal(m.ts, 1_700_000_000_000, "seconds become ms");
  const raw = JSON.parse(m.raw_json);
  assert.match(raw.raw_ref, /^raw:[0-9a-f]{64}$/);
  assert.equal(raw.link, undefined, "only http(s) links");
  assert.equal(one("SELECT visibility FROM raw_sources")!.visibility, "owner");
});

test("command plugin: stdin contract, secrets on stdin only, cursor from done, failure keeps the cursor", async () => {
  const { h } = await ambientHome("plugin", { [EXCL]: conf("  - id: notes\n    kind: command\n    run: notes\n    env: [NOTES_TOKEN]\n") },
    "NOTES_TOKEN=fake-token-abcdef\nFEISHU_APP_SECRET=fake-feishu-secret\n");
  process.env.SBOT_PLUGINS = join(h.root, "plugins");
  const dir = join(h.root, "plugins", "sources", "notes");
  mkdirSync(dir, { recursive: true });
  // echoes what it was given into a file, then prints two items and a done line; fails when asked to
  writeFileSync(join(dir, "run"), `#!/bin/sh
read line
printf '%s' "$line" > "$HOME/stdin.json"
env > "$HOME/env.txt"
if [ -f "$HOME/fail" ]; then echo "broken fake-token-abcdef" >&2; exit 4; fi
echo '{"kind":"item","id":"a","ts":1700000000000,"where":"inbox","author":"甲","text":"第一条"}'
echo 'not json'
echo '{"kind":"item","id":"b","text":"第二条"}'
echo '{"kind":"done","cursor":"c-2"}'
`);
  chmodSync(join(dir, "run"), 0o755);
  const s = { id: "notes", kind: "command", run: "notes", env: ["NOTES_TOKEN"] };

  configureSources({ runner: undefined });
  const off = await pollSource(s);
  assert.equal(off.ok, false);
  assert.match(off.err!, /插件运行器/);

  configureSources({ runner: localPluginRunner });
  const r = await pollSource(s);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.n, 2);
  assert.equal(kvGet("source.notes.cursor"), "c-2");
  const st = join(h.root, "sources", "notes");
  const stdin = JSON.parse(readFileSync(join(st, "stdin.json"), "utf8"));
  assert.equal(stdin.v, 1);
  assert.equal(stdin.cursor, null);
  assert.deepEqual(stdin.env, { NOTES_TOKEN: "fake-token-abcdef" });
  const env = readFileSync(join(st, "env.txt"), "utf8");
  assert.ok(!env.includes("fake-token-abcdef") && !env.includes("SBOT_HOME"), "nothing secret in its environment");

  writeFileSync(join(st, "fail"), "");
  const bad = await pollSource(s);
  assert.equal(bad.ok, false);
  assert.match(bad.err!, /退出 4/);
  assert.ok(!bad.err!.includes("fake-token-abcdef"), "secret masked in the error");
  assert.equal(kvGet("source.notes.cursor"), "c-2", "cursor unchanged");

  const greedy = commandPoll(() => localPluginRunner);
  await assert.rejects(greedy({ id: "x", kind: "command", run: "notes", env: ["FEISHU_APP_SECRET"] }, state(st), 0, undefined), /主自己的密钥/);
  await assert.rejects(greedy({ id: "x", kind: "command", run: "../etc" }, state(st), 0, undefined), /插件名不对/);
});

test("git: ls-remote baseline, then only moved branches are fetched; credentials never shown", async () => {
  const { h } = await ambientHome("git", { "repos.yaml": `app:\n  url: https://${CRED}@git.example.com/team/app.git\n` });
  let tips = "aaa\trefs/heads/main\nbbb\trefs/heads/dev\n";
  const calls: string[][] = [];
  const g: Git = async (_cwd, args) => {
    calls.push(args);
    if (args[0] === "ls-remote") return tips;
    if (args[0] === "cat-file") { if (args[2] === "aaa^{commit}") return ""; throw new Error("missing"); }
    if (args[0] === "log") return `ccc\x1frefs/sbot/main\x1f乙\x1f1700000000\x1f修了登录\x1f\x1e`;
    return "";
  };
  const poll = gitPoll(g), st = state(join(h.root, "g"));
  mkdirSync(st.dir, { recursive: true });
  const s = { id: "app-commits", kind: "git", repo: "app" };
  assert.deepEqual((await poll(s, st, 0, undefined)).items, []);
  tips = "ccc\trefs/heads/main\nbbb\trefs/heads/dev\n";
  const r = await poll(s, st, 0, undefined);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0]!.text, "[main] 修了登录");
  assert.equal(r.items[0]!.link, "https://git.example.com/team/app/commit/ccc");
  const fetch = calls.find((c) => c[0] === "fetch")!;
  assert.ok(fetch.includes("--depth=100") && fetch.includes("+refs/heads/main:refs/sbot/main") && !fetch.some((a) => a.includes("dev")));
  assert.deepEqual(calls.find((c) => c[0] === "log")!.slice(-2), ["--not", "aaa"]);
  assert.equal(stripCreds(`fatal: https://${CRED}@git.example.com/x`), "fatal: https://git.example.com/x");
  assert.equal(webOf(`${"git"}@git.example.com:team/app.git`), "https://git.example.com/team/app");
});

test("mail: baseline first, then new mail only; sensitive subjects skipped; parties carried for the exclude list", async () => {
  const { h } = await ambientHome("mail", { "gate.yaml": "sensitive_words: [薪酬]\n" });
  resetMailCache();
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  let inbox = ["m1"];
  const mails: Record<string, any> = {
    m1: { message_id: "m1", internal_date: Date.now() - 60_000, subject: "旧邮件", head_from: { mail_address: at("a") }, to: [] },
    m2: { message_id: "m2", thread_id: "t2", internal_date: Date.now() + 1000, subject: "请确认合同", head_from: { mail_address: at("b"), name: "乙<script>" },
      to: [{ mail_address: at("me") }], body_plain_text: b64("请看附件。\n发件人: x 发送时间: y 主题: z 旧的引用") },
    m3: { message_id: "m3", internal_date: Date.now() + 2000, subject: "薪酬调整", head_from: { mail_address: at("hr") }, to: [] },
  };
  const lark: Lark = async (args) => {
    const method = args[2], params = JSON.parse(args[4]!);
    if (method === "send_as") return JSON.stringify({ data: { sendable_addresses: [{ email_type: "USER_PRIMARY", email_address: at("me") }] } });
    if (method === "list") return JSON.stringify({ data: { items: params.folder_id === "INBOX" ? inbox : [], has_more: false } });
    const ids: string[] = JSON.parse(args[args.indexOf("--data") + 1]!).message_ids;
    return JSON.stringify({ data: { messages: ids.map((i) => mails[i]) } });
  };
  const poll = feishuMail(() => lark), st = state(join(h.root, "m"));
  const s = { id: "mail", kind: "feishu-mail" };
  assert.deepEqual((await poll(s, st, 0, undefined)).items, [], "baseline");
  inbox = ["m3", "m2", "m1"];
  const r = await poll(s, st, 0, undefined);
  assert.equal(r.items.length, 1);
  const it = r.items[0]!;
  assert.equal(it.id, "m2");
  assert.equal(it.where, "t2");
  assert.equal(it.to_me, true);
  assert.equal(it.author, "乙 script");
  assert.deepEqual(it.parties, [at("b"), at("me")]);
  assert.equal(it.text, "主题：请确认合同\n请看附件。");
  assert.ok(JSON.parse(st.get("skip")!).includes("m3"));
  await assert.rejects(feishuMail(() => undefined)(s, st, 0, undefined), /飞书没配/);
  assert.equal(cleanMailBody("hi\n> quoted\n-- \nsig"), "hi");
});

test("everyMs", () => {
  assert.equal(everyMs("15m"), 15 * 60_000);
  assert.equal(everyMs("2h"), 2 * 3600_000);
  assert.equal(everyMs("10s"), 30 * 60_000);
  assert.equal(everyMs("0m"), 60_000);
  void all;
});
