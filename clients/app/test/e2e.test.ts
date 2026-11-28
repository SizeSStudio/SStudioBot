// End to end with nothing faked on the wire: the connection state machine and the store, over Node's WebSocket, through
// W2a's relay and the hub's RelayLink / Session to W2b's /api/v1 dispatcher and pump (scripts/clients-e2e-hub.ts, a
// child process since clients/ may not import hub/ or relay/). Pair with a code → bootstrap → live ev/delta → the
// network drops and it fills in by seq (nothing missing, nothing twice) → hub offline 4404 waits → W3a writes over the wire →
// W4 a task on a (fake) node: dispatch, steps, a diff, 看一眼 / 问我 cards, steer, 清理 → removed 4410 stops.
// Every wait is time-boxed: `until` per condition, `ctl` per harness answer, and --test-timeout for each test.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import { AUTH_PREFIX, b64u, fromB64u, PAIR_PREFIX, signedBytes } from "../../../protocol/pair.ts";
import { makeActions } from "../src/conn/actions.ts";
import { Connection, deviceIdOfKey, type ConnState, type Pairing, type Signer, type SocketLike } from "../src/conn/machine.ts";
import { readPairCode } from "../src/conn/pairCode.ts";
import { Writes } from "../src/conn/writes.ts";
import { pullAndOpenHtml, pullBlob } from "../src/html/pull.ts";
import { answersOf, detailOf, pick } from "../src/chat/permission.ts";
import { decodeText, shaOf, splitDiff } from "../src/task/diff.ts";
import { steerOutcome } from "../src/task/status.ts";
import { taskLane } from "../src/conn/actions.ts";
import type { Approval, Item, Task } from "../../../protocol/api/entities.ts";
import { Store } from "../src/store/store.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hub = spawn(process.execPath, [path.join(repo, "scripts/clients-e2e-hub.ts")], { stdio: ["pipe", "pipe", "pipe"] });
const hubLog: string[] = [];
hub.stderr.on("data", (d: Buffer) => { hubLog.push(d.toString()); if (hubLog.length > 40) hubLog.shift(); });
after(() => { hub.stdin.end(); setTimeout(() => hub.kill(), 2000).unref(); });

let ready: (port: number) => void;
const port = new Promise<number>((r) => { ready = r; });
const waiters = new Map<number, (v: Record<string, unknown>) => void>();
createInterface({ input: hub.stdout }).on("line", (line) => {
  let v: Record<string, unknown>;
  try { v = JSON.parse(line); } catch { return; }
  if (v.ready) ready(Number(v.port));
  else if (typeof v.id === "number") { waiters.get(v.id)?.(v); waiters.delete(v.id); }
});
let ctlId = 0;
const ctl = (cmd: string, args: Record<string, unknown> = {}, ms = 15_000): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const id = ++ctlId;
    // the harness answers in order; one that never does fails this test instead of hanging the run
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`harness didn't answer ${cmd} in ${ms} ms\n${hubLog.join("")}`)); }, ms);
    timer.unref();
    waiters.set(id, (v) => { clearTimeout(timer); resolve(v); });
    hub.stdin.write(JSON.stringify({ id, cmd, ...args }) + "\n");
  });

// every socket the machine opens is a real one; we only count them, and what goes out on them
const urls: string[] = [];
let sent = 0;
const openSocket = (u: string): SocketLike => {
  urls.push(u);
  const ws = new WebSocket(u);
  const send = ws.send.bind(ws);
  ws.send = (d) => { sent++; send(d); };
  return ws as unknown as SocketLike;
};

// a software Ed25519 key standing in for the Keystore / safeStorage ones; same bytes signed
const makeSigner = (): Signer => {
  const sk = ed25519.utils.randomSecretKey();
  return {
    publicKey: async () => b64u(ed25519.getPublicKey(sk)),
    sign: async (h, c, purpose) => b64u(ed25519.sign(signedBytes(purpose === "auth" ? AUTH_PREFIX : PAIR_PREFIX, fromB64u(h), fromB64u(c)), sk)),
  };
};
const signer = makeSigner();

// real timers, but the client's backoff is shrunk 100× so the test doesn't sit through 1–30 s (delays are recorded)
const delays: number[] = [];
const fastTimeout = (fn: () => void, ms: number) => { if (ms < 15_000) delays.push(ms); return setTimeout(fn, ms / 100); };

const until = async (what: string, f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) assert.fail(`timed out: ${what}; state ${JSON.stringify(conn.state)}\n${hubLog.join("")}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const LANE = "console:t:th_e2e00001";
const store = new Store();
let saved: Pairing | null = null;
const states: ConnState["s"][] = [];
const conn = new Connection({ openSocket, signer, store, setTimeout: fastTimeout, onPaired: (p) => { saved = p; } });
conn.subscribe((s) => states.push(s.s));
const texts = () => store.timeline(LANE).map((r) => (r.rec.data as { text?: string | null }).text ?? (r.rec.data as { body?: { text?: string } }).body?.text);
const pairCode = async () => {
  const p = readPairCode(String((await ctl("invite")).link));
  assert.ok(p.ok, "the hub's code reads on the device");
  return p.code;
};

test("pair with a fresh code through the relay, then bootstrap and stream", async () => {
  const p = await port;
  await ctl("say", { lane: LANE, text: "早，今天先看样稿" });
  const code = await pairCode();
  assert.equal(code.relay, `ws://127.0.0.1:${p}/v1/peer`);
  conn.start({ pair: { code, name: "e2e 桌面", platform: "macos" } });
  await until("live after pairing", () => conn.state.s === "live");
  assert.deepEqual(states.slice(0, 5), ["connecting", "handshake", "auth", "sync", "live"]);
  assert.equal(urls[0], `ws://127.0.0.1:${p}/v1/peer?hub=${code.hub_pk}`);
  assert.ok(saved, "pairing stored");
  assert.equal(saved!.device_id, deviceIdOfKey(await signer.publicKey()));
  assert.deepEqual(Object.keys(saved!).sort(), ["device_id", "hub_pk", "relay", "role"], "no secret kept");
  const st = await ctl("state");
  assert.equal(st.invites_used, 1);
  assert.deepEqual((st.devices as { name: string }[]).map((d) => d.name), ["e2e 桌面"]);
  assert.ok(store.loaded && store.threadByLane(LANE), "the thread came with bootstrap");
  assert.deepEqual(texts(), ["早，今天先看样稿"]);
  assert.ok(store.list("device").some((d) => d.data.name === "e2e 桌面"));
});

test("live: a new input arrives as an ev; the reply streams as deltas and is replaced by its row", async () => {
  await ctl("say", { lane: LANE, text: "第二版发了吗" });
  await until("ev for the new input", () => texts().length === 2);
  const { run } = await ctl("run", { lane: LANE });
  await until("run ev", () => !!store.get("run", String(run)));
  for (const t of ["发了，", "在", "群里"]) await ctl("delta", { run, lane: LANE, text: t });
  await until("deltas", () => store.liveOn(LANE)[0]?.text === "发了，在群里");
  await ctl("message", { run, lane: LANE, text: "发了，在群里" });
  await until("row replaces live text", () => store.liveOn(LANE).length === 0 && texts().includes("发了，在群里"));
  await ctl("end_run", { run });
  await until("run done", () => store.get("run", String(run))?.data.status === "done");
});

test("a tool starts and ends live: the item ev comes as running, then done", async () => {
  const { run } = await ctl("run", { lane: LANE });
  const { item } = await ctl("tool_start", { run, lane: LANE, name: "bash" });
  const seen: string[] = [];
  const off = store.subscribe(() => { const s = store.get("item", String(item))?.data.status; if (s && seen.at(-1) !== s) seen.push(s); });
  await until("running", () => store.get("item", String(item))?.data.status === "running");
  await ctl("tool_end", { item });
  await until("done", () => store.get("item", String(item))?.data.status === "done");
  off();
  assert.deepEqual(seen, ["running", "done"]);
  await ctl("end_run", { run });
});

test("switching threads reads the store: both timelines are there, and nothing goes out on the socket", async () => {
  const OTHER = "console:t:th_e2e00002";
  await ctl("say", { lane: OTHER, text: "另一个线程里的一句" });
  await until("the second thread", () => !!store.threadByLane(OTHER) && store.timeline(OTHER).length === 1);
  await new Promise((r) => setTimeout(r, 100));
  const before = sent;
  // what thread/[id].tsx and Timeline read when I switch (useEntity / useTimeline): store only
  for (let i = 0; i < 5; i++) for (const lane of [LANE, OTHER]) {
    const th = store.threadByLane(lane)!;
    assert.ok(store.get("thread", th.data.id));
    assert.ok(store.timeline(lane).length > 0);
    store.liveOn(lane);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent, before, "no frame sent");
});

test("the network drops: reconnect authenticates (no pairing again) and fills in by seq — nothing missing, nothing twice", async () => {
  const before = store.seq;
  const sessions = urls.length;
  delays.length = 0;
  await ctl("drop");
  await until("noticed the drop", () => conn.state.s !== "live");
  // while it's down, things happen
  await ctl("say", { lane: LANE, text: "断线时说的一句" });
  await ctl("say", { lane: LANE, text: "又一句" });
  await until("live again", () => conn.state.s === "live" && urls.length > sessions, 15_000);
  assert.equal(delays[0], 1000, "first wait is 1 s");
  await until("filled in", () => texts().includes("又一句"));
  const t = texts();
  assert.equal(new Set(t).size, t.length, `no duplicates: ${t.join(" / ")}`);
  assert.deepEqual(t.slice(-2), ["断线时说的一句", "又一句"]);
  assert.ok(store.seq > before);
  assert.equal((await ctl("state")).invites_used, 1, "the code was not used twice");
});

test("five drops in a row, lines coming in while down and while up: nothing missing, nothing twice", async () => {
  delays.length = 0;
  for (let i = 1; i <= 5; i++) {
    const sessions = urls.length;
    await ctl("say", { lane: LANE, text: `第${i}轮连着时` });
    await until(`round ${i} live line`, () => texts().includes(`第${i}轮连着时`));
    await ctl("drop");
    await until(`round ${i} dropped`, () => conn.state.s !== "live");
    await ctl("say", { lane: LANE, text: `第${i}轮断着时甲` });
    await ctl("say", { lane: LANE, text: `第${i}轮断着时乙` });
    await until(`round ${i} live again`, () => conn.state.s === "live" && urls.length > sessions, 15_000);
    await until(`round ${i} filled in`, () => texts().includes(`第${i}轮断着时乙`));
  }
  const t = texts();
  assert.equal(new Set(t).size, t.length, `no duplicates: ${t.join(" / ")}`);
  const mine = t.filter((x) => /^第\d轮/.test(x ?? ""));
  assert.deepEqual(mine, [1, 2, 3, 4, 5].flatMap((i) => [`第${i}轮连着时`, `第${i}轮断着时甲`, `第${i}轮断着时乙`]), "all of them, in order");
  // the hub re-registers on its own 1 s timer (not shrunk), so a round waits 1, 2, 5 … meanwhile; each starts at 1 s again
  assert.equal(delays.filter((d) => d === 1000).length, 5, `the backoff starts over after each time it was live: ${delays.join(",")}`);
});

test("hub offline: 4404 → waiting_hub, backing off 1, 2, 5 …; it comes back on its own", async () => {
  delays.length = 0;
  await ctl("offline", { on: true });
  await until("waiting_hub", () => conn.state.s === "waiting_hub");
  await until("three waits", () => delays.length >= 3);
  assert.deepEqual(delays.slice(0, 3), [1000, 2000, 5000]);
  await ctl("offline", { on: false });
  await until("live after the hub is back", () => conn.state.s === "live", 15_000);
});

test("requests on the live connection: paging, a 404, and a write without client_op_id is refused", async () => {
  const th = store.threadByLane(LANE)!;
  const r = await conn.request("GET", `/api/v1/threads/${th.data.id}/items`, { query: { limit: "2" } });
  assert.equal(r.status, 200);
  assert.equal((await conn.request("GET", "/api/v1/nope")).status, 404);
  // W3a: device writes are on the relay path too, but every write needs its client_op_id (02)
  assert.equal((await conn.request("PATCH", `/api/v1/devices/${saved!.device_id}`, { body: { name: "e2e 桌面" } })).status, 400);
});

test("W3 over the real wire: chunked blob pull for HTML and client_op_id write rollback on unmerged W3 routes", async () => {
  // 1) Real GET /api/v1/blobs/:sha over Noise: a >16 KB item stores a real blob on the hub
  const { run } = await ctl("run", { lane: LANE });
  const big = `<!doctype html><p>${"样稿正文".repeat(2200)}</p>`;
  await ctl("message", { lane: LANE, run, text: big });
  await ctl("end_run", { run });
  await until("big item with blob ref arrived", () =>
    store.timeline(LANE).some((r) => r.entity === "item" && !!(r.rec.data as { blob?: { ref: string } | null }).blob));
  const blobItem = store.timeline(LANE).find((r) => r.entity === "item" && !!(r.rec.data as { blob?: { ref: string } | null }).blob)!;
  const blob = (blobItem.rec.data as { blob: { ref: string; size: number } }).blob;
  const sha = blob.ref.slice("blob:".length);
  let pulledLen = 0;
  const opened = await pullAndOpenHtml({ sha, name: "draft.html", size: blob.size }, {
    chunkBytes: 8192,
    request: (m, p, o) => conn.request(m, p, o),
    open: async (s, bytes) => {
      assert.equal(s, sha);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
      pulledLen = bytes.byteLength;
      return true;
    },
  });
  assert.deepEqual(opened, { ok: true });
  assert.equal(pulledLen, blob.size);

  // 2) Writes + client_op_id over real Noise/relay to the W3a hub: the optimistic title shows at once and the hub's
  // row (seq) settles it; presence (W3b, no client_ops) answers 200
  const th = store.threadByLane(LANE)!;
  const w = new Writes({ conn, store });
  const act = makeActions(w, store, () => saved?.device_id ?? null);
  const p = act.patchThread(th.data.id, { title: "乐观改名" });
  assert.equal(store.get("thread", th.data.id)?.data.title, "乐观改名");
  const r = await p;
  assert.equal(r.ok, true, `patch: ${JSON.stringify(r)}`);
  await until("the hub's row settles it", () => store.base("thread", th.data.id)?.data.title === "乐观改名");
  const pr = await act.presence({ foreground: true, viewing: `thread:${th.data.id}` });
  assert.equal(pr.ok, true, `presence (W3b): ${JSON.stringify(pr)}`);
  assert.equal(conn.state.s, "live", "connection stays healthy after writes");
  w.clear();
});

test("W4 over the real wire: dispatch to a node, its steps and diff arrive, 看一眼 / 问我 answered, steer, 清理, cancel", async () => {
  const w = new Writes({ conn, store });
  const act = makeActions(w, store, () => saved?.device_id ?? null);
  /** what the hub sent down to the node (it goes out from the engine's loop: polled, time-boxed) */
  const sentTo = async (re: string, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const got = (await ctl("node_sent", { re })).got as { body: Record<string, unknown> }[];
      if (got.length) return got;
      if (Date.now() > end) assert.fail(`the node never got ${re}\n${hubLog.join("")}`);
      await new Promise((r) => setTimeout(r, 30));
    }
  };
  assert.equal((await ctl("node_hello", { steer: true })).status, 200);
  await until("the node in the store", () => store.get("node", "local")?.data.status === "online");
  assert.deepEqual(store.get("node", "local")!.data.agents, [{ kind: "claude", version: "0.0.1" }, { kind: "codex", version: "0.0.2" }]);

  // 派活: confirmed; the answer is the task, the stream brings its thread
  const r = await act.startTask({ goal: "把示例仓库的 README 改通顺", node: "local", agent: "claude", repo: "/home/demo/repo" });
  assert.equal(r.ok, true, JSON.stringify(r));
  const id = ((r as { body: { task: Task } }).body.task).id;
  const lane = taskLane(id);
  await until("running on the node", () => store.get("task", id)?.data.status === "running" && !!store.get("task", id)?.data.session_ref);
  await until("its thread", () => !!store.threadByLane(lane));
  assert.equal(store.get("task", id)!.data.caps?.steer, true, "caps from the node's hello");

  // steps: progress, a tool with its diff, a message, the edit's diff as a blob
  const DIFF = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-旧的一句\n+<img src=https://evil.example/x.png>新的一句";
  assert.equal((await ctl("node_events", { task: id, events: [
    { k: "progress", text: "在读 README" },
    { k: "tool_start", item: "tu1", name: "Edit", args: { path: "README.md" } },
    { k: "tool_end", item: "tu1", ok: true, result: "ok", diff: DIFF },
    { k: "diff", item: "tu1", text: DIFF, stat: { files: [{ path: "README.md", added: 1, removed: 1 }], added: 1, removed: 1 } },
    { k: "message", item: "m1", text: "改好了第一段" },
  ] })).status, 200);
  const items = () => store.timeline(lane).filter((x) => x.entity === "item").map((x) => x.rec.data as Item);
  await until("steps in the task thread", () => items().some((i) => i.kind === "assistant") && items().some((i) => i.name === "diff"));
  assert.ok(items().some((i) => i.kind === "notice" && (i.body as { text?: string }).text === "在读 README"));
  const tool = items().find((i) => i.kind === "tool")!;
  assert.equal(tool.status, "done");
  assert.equal(splitDiff(String((tool.body as { diff?: string }).diff)).files[0]!.path, "README.md");
  // the diff step points at a blob: pulled over the relay in chunks, split, shown as text
  const sha = shaOf((items().find((i) => i.name === "diff")!.body as { diff_ref?: string }).diff_ref);
  assert.ok(sha);
  const got = await pullBlob(sha!, 4 * 1024 * 1024, { request: (m, p, o) => conn.request(m, p, o), chunkBytes: 64 });
  assert.ok(got.ok);
  const d = splitDiff(decodeText((got as { bytes: Uint8Array }).bytes));
  assert.deepEqual([d.files.length, d.added, d.removed], [1, 1, 1]);
  assert.ok(d.files[0]!.text.includes("<img src=https://evil.example/x.png>"), "kept as text (never rendered)");

  // 看一眼: the whole command reaches the card; the answer is locked to the version on screen
  const long = `rm -rf build && echo ${"示".repeat(3000)} && echo 尾巴`;
  const opts = [{ id: "allow_once", label: "这次可以", kind: "allow_once" }, { id: "reject_once", label: "不行", kind: "reject_once" }];
  const g = await ctl("node_permission", { task: id, request_id: "perm-e2e-1", title: "要跑一条长命令", detail: { tool: "Bash", command: long, cwd: "/home/demo/repo" }, options: opts });
  const gid = String(g.approval_id);
  await until("the glance card", () => store.get("approval", gid)?.data.status === "pending");
  await until("the task waits on it", () => store.get("task", id)?.data.waiting_approval === gid);
  const ga = store.get("approval", gid)!.data as Approval;
  assert.equal(ga.kind, "glance");
  assert.equal(detailOf(ga.request).command, long, "not cut: its tail is there");
  const wrong = await act.decide(ga, ga.draft_version + 1, { action: "answer", option_id: "allow_once" });
  assert.equal(wrong.ok, false, "a version I wasn't shown is refused");
  w.dismiss(wrong.op);
  const ok = await act.decide(ga, ga.draft_version, { action: "answer", option_id: "allow_once" });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  await until("approved", () => store.get("approval", gid)?.data.status === "approved");
  await until("the node got the answer", () => store.get("task", id)?.data.status === "running");
  assert.equal((await sentTo("permissions/perm-e2e-1$"))[0]!.body.option_id, "allow_once");

  // 问我 with two questions (one multiSelect): `answers`, only once each has one
  const QS = [{ question: "标题用哪种？", options: [{ label: "短的" }, { label: "长的" }] }, { question: "顺便改哪些？", multiSelect: true, options: [{ label: "错字" }, { label: "链接" }] }];
  const q = await ctl("node_permission", { task: id, kind: "ask", request_id: "ask-e2e-1", title: "两个问题", detail: { questions: QS }, options: [] });
  const qid = String(q.approval_id);
  await until("the ask card", () => store.get("approval", qid)?.data.status === "pending");
  const qa = store.get("approval", qid)!.data as Approval;
  const qs = detailOf(qa.request).questions;
  assert.equal(qs.length, 2);
  let picks = pick({}, qs[0]!, "短的");
  assert.equal(answersOf(qs, picks), null, "not until both are answered");
  picks = pick(pick(picks, qs[1]!, "错字"), qs[1]!, "链接");
  const answers = answersOf(qs, picks)!;
  assert.equal((await act.decide(qa, qa.draft_version, { action: "answer", answers })).ok, true);
  await until("ask answered", () => store.get("approval", qid)?.data.status !== "pending");
  const sentAsk = (await sentTo("permissions/ask-e2e-1$"))[0]!.body;
  assert.deepEqual(sentAsk.answers, { "标题用哪种？": "短的", "顺便改哪些？": "错字, 链接" });

  // steer: optimistic in the lane; the hub's answer says whether it went into this turn
  await until("running again", () => store.get("task", id)?.data.status === "running" && !store.get("task", id)?.data.waiting_approval);
  const s1 = await act.steerTask(id, "顺便把标题也改了");
  assert.equal(s1.ok, true, JSON.stringify(s1));
  assert.equal(steerOutcome(s1.ok ? s1.body as { applied: boolean } : null), "插进这一轮了");
  await ctl("node_steer", { applied: false });
  const s2 = await act.steerTask(id, "再加一段致谢");
  assert.equal(steerOutcome(s2.ok ? s2.body as { applied: boolean } : null), "这一轮接不了，排到下一轮开头");
  await until("my lines in the task thread", () => store.timeline(lane).filter((x) => x.entity === "input").length >= 2);

  // move while a turn runs: refused in place (先停)
  const mv = await act.moveTask(id, { agent: "codex" });
  assert.equal(mv.ok, false);
  assert.equal(mv.status, 409);
  w.dismiss(mv.op);

  // 清理 a worktree that's cleanable, from the node page's list
  await ctl("worktree_cleanable", { task: id, path: "/home/demo/repo/.sbot-wt/demo" });
  const n = await conn.request("GET", "/api/v1/nodes");
  const wts = (n.body as { worktrees: { path: string }[] }).worktrees;
  assert.ok(wts.some((x) => x.path === "/home/demo/repo/.sbot-wt/demo"));
  const cl = await act.cleanupWorktree("local", "/home/demo/repo/.sbot-wt/demo");
  assert.equal(cl.ok, true, JSON.stringify(cl));
  assert.equal((await sentTo("worktrees/cleanup$")).length, 1);

  // cancel: it ends, and the task thread says so
  assert.equal((await act.cancelTask(id)).ok, true);
  await until("cancelled", () => store.get("task", id)?.data.status === "cancelled");
  w.clear();
});

test("a removed device: CLOSE 4410 → auth_failed (removed), and it stops retrying; a new connection gets 4401", async () => {
  await ctl("remove", { device_id: saved!.device_id });
  await until("auth_failed", () => conn.state.s === "auth_failed");
  assert.deepEqual(conn.state, { s: "auth_failed", why: "removed" });
  const n = urls.length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(urls.length, n, "no reconnects after an auth failure");
  const c2 = new Connection({ openSocket, signer, store: new Store(), setTimeout: fastTimeout });
  c2.start({ pairing: saved! });
  await until("auth_failed on a new connection", () => c2.state.s === "auth_failed");
  assert.deepEqual(c2.state, { s: "auth_failed", why: "refused" });
  c2.stop();
});

test("pairing again needs a fresh key: the old key is refused, a new one pairs", async () => {
  const old = new Connection({ openSocket, signer, store: new Store(), setTimeout: fastTimeout });
  old.start({ pair: { code: await pairCode(), name: "旧钥匙", platform: "macos" } });
  await until("old key refused", () => old.state.s === "pair_failed");
  old.stop();
  const fresh = new Connection({ openSocket, signer: makeSigner(), store: new Store(), setTimeout: fastTimeout });
  fresh.start({ pair: { code: await pairCode(), name: "新钥匙", platform: "macos" } });
  await until("new key paired", () => fresh.state.s === "live");
  fresh.stop();
});

test("a forged code: pair_failed, no device written", async () => {
  const code = await pairCode();
  const forged = { ...code, secret: b64u(new Uint8Array(32).fill(9)) };
  const c3 = new Connection({ openSocket, signer: makeSigner(), store: new Store(), setTimeout: fastTimeout });
  c3.start({ pair: { code: forged, name: "冒名", platform: "linux" } });
  await until("pair_failed", () => c3.state.s === "pair_failed");
  c3.stop();
  const st = await ctl("state");
  assert.ok(!(st.devices as { name: string }[]).some((d) => d.name === "冒名"));
  conn.stop();
  void ctl("quit"); // it exits without answering
});
