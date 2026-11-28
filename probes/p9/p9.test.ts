// Verifies the harness without a Feishu app: a mock server speaks the long-connection protocol and the REST bits, a
// fake lark-cli stands in for the subprocess. Run: npm test (node --test).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Client, LoggerLevel, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { ApiError, Deduper, describeError, loadCreds, makeRedactor, pct, sleep } from "./core.ts";
import type { Creds, Incoming } from "./core.ts";
import { SdkBackend } from "./backend-sdk.ts";
import { CliBackend } from "./backend-cli.ts";
import { CutProxy } from "./proxy.ts";
import { MockFeishu, decodeFrame, encodeFrame } from "./mock-feishu.ts";
import { assertNoOtherConnection, runClicks, runNetcut, runStream } from "./scenarios.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = "s3cr3t-" + "0123456789abcdef";
const waitFor = async (f: () => unknown, ms = 8000, what = "condition") => {
  const t = Date.now();
  while (!f()) { if (Date.now() - t > ms) throw new Error(`timeout: ${what}`); await sleep(20); }
};

let mock: MockFeishu;
let creds: Creds;
let said: string[];
const say = (l: string) => said.push(l);
const resetHttp = () => { const d = (defaultHttpInstance as any).defaults; d.httpAgent = undefined; d.httpsAgent = undefined; d.proxy = undefined; };

async function fresh() {
  if (mock) await mock.close();
  said = [];
  mock = await new MockFeishu().listen();
  creds = { app_id: mock.appId, app_secret: SECRET, chat_id: "oc_mock", test_app: true, domain: mock.domain };
}

describe("pure parts", () => {
  it("frame codec round-trips", () => {
    const f = { SeqID: 3, LogID: 1_700_000_000_123, service: 7, method: 1, headers: [{ key: "type", value: "event" }, { key: "sum", value: "2" }], payload: Buffer.from("héllo") };
    assert.deepEqual(decodeFrame(encodeFrame(f)), f);
  });

  it("redaction masks secrets, ids, tokens, ticket query values", () => {
    const r = makeRedactor([SECRET]);
    const out = r(`${SECRET} ou_abcdef123456 Bearer t-abcdefghijklmnop1234 wss://x/ws?ticket=zzz&device_id=d1 {"app_secret":"${SECRET}"}`);
    for (const bad of [SECRET, "abcdef123456", "t-abcdefghij", "zzz", "d1"]) assert.ok(!out.includes(bad), `still contains ${bad}`);
  });

  it("describeError keeps status and code, drops request config", () => {
    const e: any = new Error("Request failed"); e.name = "AxiosError";
    e.response = { status: 400, data: { code: 10003 } }; e.config = { data: JSON.stringify({ app_secret: SECRET }) };
    const s = describeError(e);
    assert.match(s, /http=400/); assert.match(s, /code=10003/); assert.ok(!s.includes(SECRET));
  });

  it("deduper: first sighting wins, and survives a restart through its file", () => {
    const dir = mkdtempSync(join(tmpdir(), "p9t-")), file = join(dir, "seen.txt");
    try {
      const a = new Deduper(file);
      assert.equal(a.seen("e1"), false); assert.equal(a.seen("e1"), true); assert.equal(a.seen("e2"), false);
      const b = new Deduper(file);
      assert.equal(b.seen("e1"), true); assert.equal(b.dupes, 1); assert.equal(b.seen("e3"), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("percentile", () => { assert.equal(pct([5, 1, 3, 2, 4], 50), 3); assert.equal(pct([], 50), null); });

  it("credentials: needs test_app, refuses the instance config dirs, reads but never echoes", () => {
    const dir = mkdtempSync(join(tmpdir(), "p9t-"));
    try {
      const good = join(dir, "c.json");
      writeFileSync(good, JSON.stringify({ app_id: "a", app_secret: SECRET, chat_id: "c", test_app: true }));
      assert.equal(loadCreds(good).chat_id, "c");
      writeFileSync(good, JSON.stringify({ app_id: "a", app_secret: SECRET, chat_id: "c" }));
      assert.throws(() => loadCreds(good), /test_app/);
      writeFileSync(good, JSON.stringify({ app_id: "a", app_secret: SECRET, chat_id: "c", test_app: true, domain: "https://evil.example" }));
      assert.throws(() => loadCreds(good), /domain/);
      assert.throws(() => loadCreds("/srv/sbot/config/feishu.json"), /instance config/);
      assert.throws(() => loadCreds(join(homedir(), ".config/sbot/x.json")), /instance config/);
      assert.throws(() => loadCreds(undefined), /P9_CREDENTIALS/);
      for (const f of [() => loadCreds(join(dir, "missing.json"))]) assert.throws(f, (e: Error) => !e.message.includes(SECRET));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("run.ts refuses a credentials file without test_app and prints nothing secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "p9t-"));
    try {
      const f = join(dir, "c.json");
      writeFileSync(f, JSON.stringify({ app_id: "a", app_secret: SECRET, chat_id: "c" }));
      let err: any;
      try { execFileSync("node", [join(here, "run.ts"), "stream", "--backend", "sdk"], { env: { ...process.env, P9_CREDENTIALS: f }, stdio: "pipe" }); } catch (e) { err = e; }
      assert.ok(err, "should exit non-zero");
      assert.equal(err.status, 1);
      assert.match(String(err.stderr), /test_app/);
      assert.ok(!String(err.stderr).includes(SECRET) && !String(err.stdout).includes(SECRET));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("SDK backend against the mock long connection", () => {
  before(fresh);
  after(async () => { await mock.close(); });

  it("acks 200 after the handler, with the handler's return value as the callback response and operator_id visible", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    const got: Incoming[] = [];
    await b.start(async (e) => { got.push(e); await sleep(300); return { toast: { type: "success", content: "ok" } }; });
    const t0 = Date.now();
    const { messageId } = mock.pushClick({ messageId: "om_card1" });
    const ack = await mock.waitAck(messageId);
    assert.equal(ack.code, 200);
    assert.deepEqual(ack.data, { toast: { type: "success", content: "ok" } });
    assert.ok(ack.at - t0 >= 280, "the ack must wait for the handler");
    assert.equal(got.length, 1);
    assert.equal(got[0]!.kind, "card"); assert.equal(got[0]!.operatorId, "ou_mock"); assert.equal(got[0]!.messageId, "om_card1");
    assert.equal(got[0]!.value.k, "p9"); assert.equal(got[0]!.token, "c-upd"); assert.ok(got[0]!.eventId.startsWith("ev-"));
    assert.ok(b.ackMs()[0]! >= 280 && b.ackMs()[0]! < 3000);
    await b.close();
  });

  it("a card event without operator comes through as no operator id", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    const got: Incoming[] = [];
    await b.start((e) => { got.push(e); });
    await mock.waitAck(mock.pushClick({ messageId: "om_c", operator: null }).messageId);
    assert.equal(got[0]!.operatorId, undefined);
    await b.close();
  });

  it("a handler that throws is acked 500 (Feishu would show the failure toast)", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    await b.start(() => { throw new Error("boom"); });
    const ack = await mock.waitAck(mock.pushClick({ messageId: "om_c" }).messageId);
    assert.equal(ack.code, 500);
    await b.close();
  });

  it("events split over frames arrive once, and messages parse", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    const got: Incoming[] = [];
    await b.start((e) => { got.push(e); });
    const m = mock.pushMessage({ messageId: "om_x1", createTimeMs: 1_700_000_000_000 });
    await mock.waitAck(m.messageId);
    mock.push("im.message.receive_v1", { sender: { sender_id: { open_id: "ou_mock" } }, message: { message_id: "om_x2", chat_id: "oc_mock", create_time: "1" } }, { fragments: 3 });
    await waitFor(() => got.length === 2, 3000, "two events");
    assert.equal(got[0]!.kind, "message"); assert.equal(got[0]!.messageId, "om_x1"); assert.equal(got[0]!.eventTs, 1_700_000_000_000);
    assert.equal(got[1]!.messageId, "om_x2");
    await b.close();
  });

  it("an unregistered event type is acked 200 and lost: harness registers every subscribed type", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    await b.start(() => {});
    const ack = await mock.waitAck(mock.push("im.message.message_read_v1", { reader: {} }).messageId);
    assert.equal(ack.code, 200);
    assert.match(String(ack.data), /no .* handle/);
    await b.close();
  });

  it("reconnects after the server drops the connection; a redelivered event_id is caught by the deduper", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    const dedupe = new Deduper();
    const got: string[] = [];
    await b.start((e) => { if (!dedupe.seen(e.eventId)) got.push(e.eventId); });
    await mock.waitAck(mock.pushMessage({ eventId: "ev-a" }).messageId);
    mock.dropConnections();
    await waitFor(() => mock.connects === 2 && mock.clients === 1, 10_000, "reconnect");
    await mock.waitAck(mock.pushMessage({ eventId: "ev-a" }).messageId);   // Feishu-side retry of the same event
    await mock.waitAck(mock.pushMessage({ eventId: "ev-b" }).messageId);
    assert.deepEqual(got, ["ev-a", "ev-b"]);
    assert.equal(dedupe.dupes, 1);
    const tl = b.timeline().map((x) => x.ev);
    assert.ok(tl.includes("reconnecting") && tl.includes("reconnected"), tl.join());
    await b.close();
  });

  it("a half-open path is noticed by the ping watchdog (stall), not by TCP", async () => {
    await fresh();
    mock.pingIntervalS = 1;
    const proxy = new CutProxy(); await proxy.listen();
    const b = new SdkBackend({ creds, say, proxyUrl: proxy.url, pingTimeoutSec: 1 });
    try {
      await b.start(() => {});
      proxy.cut("stall");
      await waitFor(() => b.timeline().some((x) => x.ev === "reconnecting"), 8000, "watchdog reconnect");
    } finally { proxy.restore(); await b.close(); await proxy.close(); }
  });

  it("with the harness logger a failed token request leaks no secret (and the raw SDK does: why the logger exists)", async () => {
    await fresh();
    mock.tokenFails = true;
    const b = new SdkBackend({ creds, say });
    await assert.rejects(b.api("GET", "/open-apis/im/v1/messages/om_abc"), (e: any) => e instanceof ApiError && !e.message.includes(SECRET));
    assert.ok(said.length > 0, "the SDK did log the failure");
    assert.ok(!said.join("\n").includes(SECRET), "secret in harness log");

    resetHttp();
    const parts: string[] = [];
    const raw = new Client({ appId: creds.app_id, appSecret: SECRET, domain: mock.domain, loggerLevel: LoggerLevel.error,
      logger: { error: (m: unknown) => parts.push(inspect(m, { depth: 8 })), warn() {}, info() {}, debug() {}, trace() {} } as any });
    await raw.request({ method: "GET", url: "/open-apis/x" }).catch(() => {});
    assert.ok(parts.join("\n").includes(SECRET), "characterisation: SDK 1.77.0 logs the AxiosError including app_secret");
  });

  it("connection preflight: refuses when another long connection is online", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    await assertNoOtherConnection(b, say);
    mock.online = 1;
    await assert.rejects(assertNoOtherConnection(b, say), /already has 1/);
  });
});

describe("scenarios on the SDK backend", () => {
  after(async () => { await mock.close(); });

  it("clicks: 50 clicks, one duplicate delivery, all acked, all updates and the read-back agree", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    const dedupe = new Deduper();
    const run = runClicks(b, { chatId: "oc_mock", target: 50, timeoutMs: 30_000, dedupe, say });
    await waitFor(() => mock.clients === 1 && mock.lastMsgId, 10_000, "connected");
    const card = mock.lastMsgId;
    for (let i = 0; i < 50; i++) {
      const { messageId } = mock.pushClick({ messageId: card, eventId: `click-${i}` });
      if (i === 10) mock.pushClick({ messageId: card, eventId: "click-10" });   // a repeat of one event
      if (i % 5 === 0) await mock.waitAck(messageId);
    }
    const r: any = await run;
    await b.close();
    assert.equal(r.clicks_unique, 50); assert.equal(r.duplicate_event_ids, 1);
    assert.equal(r.with_operator_id, 50); assert.equal(r.handled_under_3s, "50/50");
    assert.equal(r.card_updates.ok, 50); assert.equal(r.card_updates.failed, 0); assert.equal(r.card_readback_shows_final_count, true);
    assert.deepEqual(r.pass, { clicks: true, ack_3s: true, operator_id: true, updates: true });
    assert.ok(!JSON.stringify(r).includes("om_"), "report must not carry message ids");
  });

  it("clicks: missing operator_id fails that criterion", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    const run = runClicks(b, { chatId: "oc_mock", target: 2, timeoutMs: 10_000, dedupe: new Deduper(), say });
    await waitFor(() => mock.clients === 1 && mock.lastMsgId, 10_000, "connected");
    mock.pushClick({ messageId: mock.lastMsgId, operator: null });
    mock.pushClick({ messageId: mock.lastMsgId });
    const r: any = await run; await b.close();
    assert.equal(r.pass.operator_id, false); assert.equal(r.without_operator_id, 1);
  });

  it("stream: strictly increasing sequence, no throttling at 5/s", async () => {
    await fresh();
    const b = new SdkBackend({ creds, say });
    const r: any = await runStream(b, { chatId: "oc_mock", durationMs: 2000, perSec: 5, say });
    assert.equal(r.planned, 10); assert.equal(r.ok, 10); assert.equal(r.failed, 0); assert.equal(r.streaming_closed, true);
    assert.deepEqual(r.pass, { all_ok: true, not_throttled: true, kept_pace: true });
    await b.close();
  });

  it("stream: a rate-limited server is reported as throttled", async () => {
    await fresh();
    mock.rateLimitPerSec = 3;
    const b = new SdkBackend({ creds, say });
    const r: any = await runStream(b, { chatId: "oc_mock", durationMs: 2000, perSec: 8, say });
    assert.ok(r.throttled > 0, JSON.stringify(r.error_codes));
    assert.equal(r.pass.not_throttled, false); assert.equal(r.pass.all_ok, false);
    assert.ok(r.error_codes["99991400"] > 0);
    await b.close();
  });

  it("netcut: cut, restore, redelivery with repeats; a message that never came back is counted missing", async () => {
    await fresh();
    mock.pingIntervalS = 1;
    const proxy = new CutProxy(); await proxy.listen();
    const b = new SdkBackend({ creds, say, proxyUrl: proxy.url, pingTimeoutSec: 2 });
    const run = runNetcut(b, proxy, { chatId: "oc_mock", baselineMs: 1500, cutMs: 2000, mode: "reset", settleMs: 4000, dedupe: new Deduper(), say });
    await waitFor(() => mock.clients === 1, 10_000, "connected");
    const user = { sender_type: "user" };
    mock.chat.push({ message_id: "om_h1", create_time: String(Date.now()), sender: user });
    await mock.waitAck(mock.pushMessage({ messageId: "om_h1", eventId: "ev-h1" }).messageId);
    await waitFor(() => proxy.isCut, 10_000, "cut starts");
    const t = Date.now();
    for (const id of ["om_h2", "om_h3", "om_h4"]) mock.chat.push({ message_id: id, create_time: String(t), sender: user });
    await waitFor(() => !proxy.isCut, 10_000, "cut ends");
    await waitFor(() => mock.clients === 1, 15_000, "reconnected");
    await mock.waitAck(mock.pushMessage({ messageId: "om_h2", eventId: "ev-h2", createTimeMs: t }).messageId);
    await mock.waitAck(mock.pushMessage({ messageId: "om_h2", eventId: "ev-h2", createTimeMs: t }).messageId);   // Feishu retried it again
    await mock.waitAck(mock.pushMessage({ messageId: "om_h3", eventId: "ev-h3", createTimeMs: t }).messageId);
    const r: any = await run;
    await b.close(); await proxy.close();
    assert.deepEqual(r.messages_by_phase.before, { sent: 1, received: 1, missing: 0 });
    assert.deepEqual(r.messages_by_phase.during, { sent: 3, received: 2, missing: 1 });
    assert.equal(r.duplicate_event_ids_dropped, 1);
    assert.equal(r.message_ids_delivered_under_two_event_ids, 0);
    assert.equal(r.delivered_late.messages_created_during_cut, 2);
    assert.equal(r.pass.through_proxy, true); assert.ok(r.proxy.connects_refused_during_cut >= 0);
    assert.equal(r.pass.reconnected, true); assert.equal(r.pass.no_message_lost, false); assert.equal(r.pass.no_duplicate_after_dedupe, true);
    assert.ok(typeof r.reconnect_after_restore_s === "number");
  });
});

describe("CLI backend against the fake lark-cli", () => {
  const bin = join(here, "fake-lark-cli.ts");
  after(async () => { await mock.close(); });

  const cliClick = (eventId: string, messageId: string, extra: object = {}) => ({
    type: "card.action.trigger", event_id: eventId, timestamp: String(Date.now()), operator_id: "ou_mock", message_id: messageId, chat_id: "oc_mock",
    token: "c-upd", action_tag: "button", action_value: JSON.stringify({ k: "p9", t: 5 }), ...extra });

  it("runs in an isolated HOME with the credentials only in the child env, parses events, and cleans up", async () => {
    await fresh();
    const dir = mkdtempSync(join(tmpdir(), "p9t-")), dump = join(dir, "dump.jsonl");
    const b = new CliBackend({ creds, say, bin, env: { FAKE_LARK_BASE: mock.domain, FAKE_LARK_DUMP: dump, FAKE_EXPECT_SECRET: SECRET } });
    try {
      const got: Incoming[] = [];
      await b.start((e) => { got.push(e); });
      mock.feed("card.action.trigger", cliClick("ev-1", "om_card"));
      mock.feed("im.message.receive_v1", { type: "im.message.receive_v1", event_id: "ev-2", message_id: "om_m", chat_id: "oc_mock", sender_id: "ou_u", timestamp: "5" });
      await waitFor(() => got.length === 2, 5000, "two events");
      // the two keys are separate processes: arrival order is not defined
      const card = got.find((e) => e.kind === "card")!, msg = got.find((e) => e.kind === "message")!;
      assert.deepEqual([card.operatorId, card.value, card.messageId], ["ou_mock", { k: "p9", t: 5 }, "om_card"]);
      assert.deepEqual([msg.messageId, msg.operatorId, msg.eventTs], ["om_m", "ou_u", 5]);
      const d = await b.api("POST", "/open-apis/im/v1/messages", { receive_id: "oc_mock" }, { receive_id_type: "chat_id" });
      assert.ok(d.message_id);
      await assert.rejects(b.api("PUT", "/open-apis/cardkit/v1/cards/7000000099/elements/md/content", { sequence: 1 }), (e: any) => e instanceof ApiError && e.apiCode === 300301);
      const all = readFileSync(dump, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      // config init once, the secret on stdin, never in argv
      assert.equal(all.filter((r) => r.cmd === "config").length, 1);
      assert.equal(all.filter((r) => r.init_secret_on_stdin === true).length, 1);
      assert.ok(!all.some((r) => JSON.stringify(r.argv ?? []).includes(SECRET)));
      const rows = all.filter((r) => r.cmd);
      assert.ok(rows.length >= 3);
      for (const r of rows) {
        assert.equal(r.has_app_env, false, "credentials only through config init's stdin");
        assert.notEqual(r.home, process.env.HOME);
        assert.ok(r.config_dir.startsWith(r.home), "config dir inside the throw-away home");
        assert.ok(!here.startsWith(r.home) && !r.home.startsWith(here));
      }
      assert.ok(!said.join("\n").includes(SECRET));
      const home = rows[0].home;
      await b.close();
      assert.equal(existsSync(home), false, "temp home removed");
    } finally { await b.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("restarts a consumer that exits, like core/src/feishu.ts does", async () => {
    await fresh();
    const b = new CliBackend({ creds, say, bin, env: { FAKE_LARK_BASE: mock.domain } });
    await b.start(() => {});
    assert.equal(mock.feedClients, 2);
    for (const set of (mock as any).feeds.values()) for (const res of set) res.destroy();   // the "network" ends the stream
    await waitFor(() => b.timeline().some((x) => x.ev.startsWith("restart:")), 8000, "restart");
    await waitFor(() => mock.feedClients === 2, 8000, "consumers back");
    await b.close();
  });

  it("clicks scenario: acked before delivery, so the 3 s criterion rests on the backend; updates go through REST", async () => {
    await fresh();
    const b = new CliBackend({ creds, say, bin, env: { FAKE_LARK_BASE: mock.domain } });
    const run = runClicks(b, { chatId: "oc_mock", target: 5, timeoutMs: 20_000, dedupe: new Deduper(), say });
    await waitFor(() => mock.feedClients === 2 && mock.lastMsgId, 10_000, "consumers ready");
    for (let i = 0; i < 5; i++) { mock.feed("card.action.trigger", cliClick(`c-${i}`, mock.lastMsgId)); if (i === 2) mock.feed("card.action.trigger", cliClick("c-2", mock.lastMsgId)); }
    const r: any = await run; await b.close();
    assert.equal(r.clicks_unique, 5); assert.equal(r.duplicate_event_ids, 1);
    assert.equal(r.ack_semantics, "before-delivery"); assert.match(String(r.sdk_ack_ms), /n\/a/);
    assert.equal(r.card_updates.ok, 5); assert.equal(r.card_readback_shows_final_count, true);
    assert.deepEqual(r.pass, { clicks: true, ack_3s: true, operator_id: true, updates: true });
  });
});
