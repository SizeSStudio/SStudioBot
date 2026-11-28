// The node's exec and fs pieces on their own (the link is covered from the hub side, hub/test/node.test.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync as put } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, runExec, writeFile } from "../src/exec.ts";
import { sockPath } from "../src/main.ts";

test("exec: exit code, both streams, long output is cut and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbot-exec-"));
  const r = await runExec({ cmd: "echo out; echo err >&2; exit 4", cwd: dir });
  assert.deepEqual([r.code, r.stdout, r.stderr], [4, "out\n", "err\n"]);
  const big = await runExec({ cmd: "head -c 400000 /dev/zero | tr '\\0' a", cwd: dir });
  assert.match(big.stdout, /截掉 \d+ 字节，共 400000/);
});

test("exec: kill stops the process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbot-exec-"));
  const t0 = Date.now();
  const r = await runExec({ cmd: "sleep 30", cwd: dir }, (run) => setTimeout(() => run.kill(), 100));
  assert.ok(Date.now() - t0 < 5000);
  assert.ok(r.code !== 0);
});

test("fs: write, append, ranged read", () => {
  const dir = mkdtempSync(join(tmpdir(), "sbot-fs-"));
  const f = join(dir, "x", "y.txt");
  writeFile(f, Buffer.from("abc").toString("base64"), false);
  writeFile(f, Buffer.from("def").toString("base64"), true);
  const r = readFile(f, 2, 3);
  assert.equal(Buffer.from(r.data_b64, "base64").toString(), "cde");
  assert.equal(r.total, 6);
  put(join(dir, "z"), "");
  assert.equal(readFile(join(dir, "z")).total, 0);
});

test("socket path: SBOT_NODE_SOCK, else SBOT_HOME/run/hub.sock", () => {
  assert.equal(sockPath({ SBOT_NODE_SOCK: "/tmp/x.sock" }), "/tmp/x.sock");
  if (process.platform !== "win32") assert.equal(sockPath({ SBOT_HOME: "/home/fake/sbot" }), "/home/fake/sbot/run/hub.sock");
  assert.throws(() => sockPath({}));
});
