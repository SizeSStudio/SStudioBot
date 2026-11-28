import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers.ts";
import { Usage, parseArgs, run } from "../src/cli.ts";
import { FRAME_MAX, FrameReader, adminRequest, adminSocketPath, encodeLen, startAdminSocket } from "../src/admin-socket.ts";
import { boot } from "../src/main.ts";
import { StatusRes } from "../../protocol/api/status.ts";

test("parseArgs: the commands 03 lists", () => {
  assert.deepEqual(parseArgs(["status"]), { cmd: "status" });
  assert.deepEqual(parseArgs(["restore", "f.age", "--identity", "k.txt"]), { cmd: "restore", file: "f.age", identity: "k.txt", force: false });
  assert.deepEqual(parseArgs(["restore", "--force", "-i", "k", "f"]), { cmd: "restore", file: "f", identity: "k", force: true });
  assert.deepEqual(parseArgs(["pair"]), { cmd: "pair", role: "client" });
  assert.deepEqual(parseArgs(["pair", "--node"]), { cmd: "pair", role: "node" });
  assert.deepEqual(parseArgs(["devices"]), { cmd: "devices" });
  assert.deepEqual(parseArgs(["devices", "rm", "d1"]), { cmd: "devices-rm", id: "d1" });
  assert.equal((parseArgs(["chat"]) as { wave: string }).wave, "W3");
  assert.equal((parseArgs(["upgrade", "--ref", "abc"]) as { wave: string }).wave, "W4");
  assert.equal((parseArgs(["import", "anything"]) as { wave: string }).wave, "W6");
  for (const bad of [["restore", "f"], ["restore"], ["upgrade"], ["devices", "x"], ["pair", "-x"], ["pair", "--node", "--node"], ["devices", "rm"], ["nope"], ["status", "x"]]) assert.throws(() => parseArgs(bad), Usage, bad.join(" "));
  assert.deepEqual(parseArgs([]), { cmd: "help" });
});

test("exit codes: not yet = 3, bad arguments = 2, no hub = 1", async () => {
  const h = tempHome("cli");
  process.env.SBOT_HOME = h.root;
  const err: string[] = [];
  assert.equal(await run(["chat"], () => {}, (s) => err.push(s)), 3);
  assert.match(err.pop()!, /not yet \(W3\)/);
  assert.equal(await run(["bogus"], () => {}, () => {}), 2);
  assert.equal(await run(["status"], () => {}, (s) => err.push(s)), 1);
  assert.match(err.pop()!, /hub 没在运行/);
});

test("hub boots and answers status over hub-admin.sock; socket 0600, run dir 0700", async () => {
  const h = tempHome("cli");
  process.env.SBOT_HOME = h.root;
  const hub = await boot(h);
  try {
    assert.equal(statSync(adminSocketPath(h.run)).mode & 0o777, 0o600);
    assert.equal(statSync(h.run).mode & 0o777, 0o700);
    const r = await adminRequest(h.run, "GET", "/api/v1/status");
    assert.equal(r.status, 200);
    const s = StatusRes.parse(r.body);
    // 06: the key is made on first start, 0600; status shows its fingerprint and the public half, never the secret
    assert.match(s.hub_key_fingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.match(s.hub_pk ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(statSync(join(h.keys, "hub.key")).mode & 0o777, 0o600);
    assert.deepEqual(s.relay, { enabled: false, connected: false });
    assert.equal(s.db_version, 1);
    assert.equal((await adminRequest(h.run, "GET", "/api/v1/nope")).status, 404);
    const out: string[] = [];
    assert.equal(await run(["status"], (x) => out.push(x), () => {}), 0);
    assert.match(out.join("\n"), /数据库\s+v1/);
    assert.equal(await run(["restore", "x.age", "--identity", "k"], () => {}, () => {}), 1, "refuses while a hub runs");
    // a second hub on the same home is refused
    await assert.rejects(startAdminSocket(h.run, async () => ({ status: 200 })), /already listening/);
  } finally { await hub.close(); }
});

test("frames: oversize length drops the connection; split chunks reassemble", async () => {
  const r = new FrameReader();
  const buf = encodeLen('{"a":1}');
  assert.deepEqual(r.push(buf.subarray(0, 3)), []);
  assert.deepEqual(r.push(buf.subarray(3)), ['{"a":1}']);
  const head = Buffer.alloc(4); head.writeUInt32BE(FRAME_MAX + 1);
  assert.throws(() => new FrameReader().push(head), /too large/);

  const h = tempHome("cli");
  const server = await startAdminSocket(h.run, async () => ({ status: 200 }));
  try {
    const closed = await new Promise<boolean>((res) => {
      const s = createConnection(adminSocketPath(h.run), () => s.write(head));
      s.on("close", () => res(true));
      s.on("error", () => {});
    });
    assert.ok(closed);
  } finally { await new Promise<void>((res) => server.close(() => res())); }
});
