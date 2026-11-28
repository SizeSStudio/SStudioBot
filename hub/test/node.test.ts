// The local node over hub.sock with a real `sbot-node` process: hello, exec, fs, cancel (kills the process group),
// reconnect, and the three outcomes of the check contract (03 timers): skip, run with stdout, broken → run + alert.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.ts";
import { ensureNodeDir, gidOf, NodeLink, nodeSocketPath } from "../src/node-link.ts";
import { runCheck, checkText } from "../src/check.ts";
import { setAdminSink } from "../src/notify.ts";

const NODE_MAIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "node", "src", "main.ts");

async function setup() {
  const h = tempHome("node");
  const link = new NodeLink("dev");
  const sock = await link.listen(h.node);
  const child: ChildProcess = spawn(process.execPath, [NODE_MAIN], { env: { ...process.env, SBOT_NODE_SOCK: sock, SBOT_LOG: "off" }, stdio: "ignore" });
  await link.waitConnected(10_000);
  const notes: string[] = [];
  setAdminSink((t) => { notes.push(t); });
  return { h, link, child, notes, async done() { child.kill("SIGTERM"); await link.close(); } };
}

test("exec and fs through the local node", async () => {
  const s = await setup();
  const dir = mkdtempSync(join(tmpdir(), "sbot-node-fs-"));
  const r = await s.link.exec({ cmd: "echo 你好; echo oops >&2; exit 3", cwd: dir });
  assert.deepEqual([r.code, r.stdout.trim(), r.stderr.trim()], [3, "你好", "oops"]);
  await s.link.writeFile(join(dir, "a", "b.txt"), Buffer.from("第一行\n"));
  await s.link.writeFile(join(dir, "a", "b.txt"), Buffer.from("第二行\n"), true);
  assert.equal(readFileSync(join(dir, "a", "b.txt"), "utf8"), "第一行\n第二行\n");
  const part = await s.link.readFile(join(dir, "a", "b.txt"), { offset: 0, len: 4 });
  assert.equal(part.total, Buffer.byteLength("第一行\n第二行\n"));
  assert.equal(part.data.length, 4);
  assert.equal((await s.link.exec({ cmd: "pwd", cwd: dir })).stdout.trim().endsWith(dir.split("/").pop()!), true);
  await s.done();
});

test("cancel kills the whole process group", async () => {
  const s = await setup();
  const dir = mkdtempSync(join(tmpdir(), "sbot-node-kill-"));
  const marker = join(dir, "late");
  const ac = new AbortController();
  const t0 = Date.now();
  const p = s.link.exec({ cmd: `(sleep 2; touch ${marker}) & sleep 30`, cwd: dir }, ac.signal);
  setTimeout(() => ac.abort(), 300);
  await p.then(() => {}, () => {});
  assert.ok(Date.now() - t0 < 5_000, "returned soon after the stop");
  await new Promise((r) => setTimeout(r, 2_500));
  assert.ok(!existsSync(marker), "the background child was killed with the group");
  await s.done();
});

test("check: exit 0 + empty → skip; exit 0 + output → run with it; other exit → broken, runs anyway, ops alert", async () => {
  const s = await setup();
  const cwd = mkdtempSync(join(tmpdir(), "sbot-node-check-"));
  const base = { job: "morning", cwd, sbotHome: s.h.root };
  const skip = await runCheck(s.link, { ...base, cmd: "true" });
  assert.deepEqual(skip, { kind: "skip" });
  assert.equal(checkText(skip), "");
  const blank = await runCheck(s.link, { ...base, cmd: "echo '   '" });
  assert.equal(blank.kind, "skip", "whitespace only is nothing to do");
  const run = await runCheck(s.link, { ...base, cmd: "echo 3 new mails" });
  assert.deepEqual(run, { kind: "run", stdout: "3 new mails\n" });
  assert.match(checkText(run), /3 new mails/);
  assert.equal(s.notes.length, 0, "no alert for a working check");
  const broken = await runCheck(s.link, { ...base, cmd: "echo half >&1; echo 'no such file' >&2; exit 2" });
  assert.equal(broken.kind, "broken");
  assert.equal((broken as { code: number }).code, 2);
  assert.match((broken as { stderr: string }).stderr, /no such file/);
  assert.match(checkText(broken), /退出码 2/);
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0]!, /morning 的 check 脚本坏了（退出码 2）/);
  // stderr is cut to 2 KB
  const big = await runCheck(s.link, { ...base, cmd: "head -c 10000 /dev/zero | tr '\\0' x >&2; exit 1" });
  assert.equal((big as { stderr: string }).stderr.length, 2048);
  // a check that reaches the hub's own state is refused like bash, and counts as broken
  const guarded = await runCheck(s.link, { ...base, cmd: `cat ${s.h.root}/secrets.env` });
  assert.equal(guarded.kind, "broken");
  await s.done();
});

test("the node reconnects after the hub side drops", async () => {
  const s = await setup();
  const dir = mkdtempSync(join(tmpdir(), "sbot-node-re-"));
  await s.link.close();
  const link2 = new NodeLink("dev");
  await link2.listen(s.h.node);
  await link2.waitConnected(15_000);
  assert.equal((await link2.exec({ cmd: "echo back", cwd: dir })).stdout.trim(), "back");
  s.child.kill("SIGTERM");
  await link2.close();
});

test("hub.sock: its own dir 0750 (group = the node account's), socket 0660; run/ stays the admin socket's 0700", { skip: process.platform === "win32" }, async () => {
  const h = tempHome("nodesock");
  const before = process.env.SBOT_NODE_GROUP;
  // a group the test account is surely in: its own primary group, by number
  process.env.SBOT_NODE_GROUP = String(process.getgid!());
  const link = new NodeLink("dev");
  try {
    const sock = await link.listen(h.node);
    assert.equal(sock, nodeSocketPath(h.node));
    assert.ok(!sock.startsWith(h.run), "not under run/");
    const dir = statSync(h.node), file = statSync(sock);
    assert.equal(dir.mode & 0o777, 0o750);
    assert.equal(file.mode & 0o777, 0o660);
    assert.equal(dir.gid, process.getgid!());
    assert.equal(file.gid, process.getgid!());
    if (existsSync(h.run)) assert.equal(statSync(h.run).mode & 0o777, 0o700);
    // a loosened dir is put back
    const { chmodSync } = await import("node:fs");
    chmodSync(h.node, 0o777);
    ensureNodeDir(h.node);
    assert.equal(statSync(h.node).mode & 0o777, 0o750);
  } finally {
    if (before === undefined) delete process.env.SBOT_NODE_GROUP; else process.env.SBOT_NODE_GROUP = before;
    await link.close();
  }
});

test("SBOT_NODE_GROUP: a name from the group file, a number, or a refusal", () => {
  const f = join(mkdtempSync(join(tmpdir(), "sbot-group-")), "group");
  writeFileSync(f, "wheel:*:0:root\nsbot-fake:x:4321:\n");
  assert.equal(gidOf("sbot-fake", f), 4321);
  assert.equal(gidOf("77", f), 77);
  assert.throws(() => gidOf("nobody-fake", f), /no such group/);
});
