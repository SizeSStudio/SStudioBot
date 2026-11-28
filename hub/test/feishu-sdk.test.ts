// The real SDK (1.77.0) against a local HTTP mock whose token endpoint fails: what reaches our log and our errors
// must not carry the app secret. The second test pins down why the masking logger exists: the SDK's own logging
// hands over the raw request, secret included. Fictional credentials only; nothing leaves 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { inspect } from "node:util";
import type { AddressInfo } from "node:net";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { SdkBackend, watchFrames } from "../src/channels/feishu/sdk.ts";

const APP_ID = "cli_fakeappid0001", SECRET = "fake-app-secret-not-real-654321";

async function mock(): Promise<{ url: string; server: Server; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 99991663, msg: "mock: token endpoint down" }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits };
}

test("SdkBackend: a failing token endpoint leaves no secret in our log or our error", async () => {
  const m = await mock();
  const said: string[] = [];
  try {
    const b = new SdkBackend({ appId: APP_ID, appSecret: SECRET, domain: m.url, say: (l) => said.push(l) });
    const err = await b.api("GET", "/open-apis/im/v1/chats").then(() => undefined, (e) => e as Error);
    assert.ok(err, "the call fails");
    assert.ok(m.hits.some((h) => h.includes("tenant_access_token")), "the SDK asked the mock for a token");
    const all = [...said, err!.message, inspect(err, { depth: 5 })].join("\n");
    assert.ok(!all.includes(SECRET), "secret not in our log or error");
    assert.match(err!.message, /^GET \/open-apis\/im\/v1\/chats: /);
  } finally { m.server.close(); }
});

test("characterisation: the SDK's own logging carries the secret (why it always gets safeSdkLogger)", async () => {
  const m = await mock();
  const raw: string[] = [];
  const rec = (parts: unknown) => { raw.push(inspect(parts, { depth: 8 })); };
  try {
    const c = new Client({ appId: APP_ID, appSecret: SECRET, domain: m.url, loggerLevel: LoggerLevel.info,
      logger: { error: rec, warn: rec, info: rec, debug: rec, trace: rec } });
    await c.request({ method: "GET", url: "/open-apis/im/v1/chats" }).catch(() => undefined);
    // the version is pinned; a bump that stops leaking makes this fail on purpose, so the note in 08 gets updated
    const leaked = raw.some((l) => l.includes(SECRET));
    assert.ok(leaked, "SDK 1.77.0 logs the raw request with app_secret in it; if this changes, update 08 P9 and this test");
    assert.ok(raw.length > 0, "the SDK logged the failure");
  } finally { m.server.close(); }
});

test("SdkBackend: after the SDK gives up (system busy from the endpoint) it starts again, backing off; close() stops that", async () => {
  // the SDK treats every endpoint code but internal_error as final; P9's netcut showed how long a give-up would last
  const hits: number[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.startsWith("/callback/ws/endpoint")) hits.push(Date.now());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 1, msg: "mock: system busy", data: {} }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const said: string[] = [], errors: string[] = [];
  // the WSClient only starts with an app id shaped like a real one (cli_ + 16 hex); made up, upper case so leak-guard
  // (lower-case ids) doesn't take it for a real one
  const b = new SdkBackend({ appId: "cli_0000000000FA4E00", appSecret: SECRET, domain: url, say: (l) => said.push(l), restartMs: 40, restartMaxMs: 160 });
  try {
    await b.start(() => {}, { ready() {}, reconnected() {}, error: (m) => errors.push(m) });
    const end = Date.now() + 5000;
    while (hits.length < 4 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.ok(hits.length >= 4, `asked for the endpoint again after giving up (${hits.length} times)`);
    assert.ok(errors.length >= 3 && errors.every((e) => !e.includes(SECRET)));
    const gaps = hits.slice(1).map((t, i) => t - hits[i]!);
    assert.ok(gaps[1]! >= 70, `backs off (gaps ${gaps.join(", ")} ms)`);
    assert.ok(said.some((l) => /starting it again in/.test(l)));
    await b.close();
    const n = hits.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(hits.length, n, "no new attempt after close()");
    assert.ok(!said.join("\n").includes(SECRET));
  } finally { await b.close(); server.close(); }
});

test("watchFrames: a data frame that isn't `event` is said once per type, and still handed to the SDK", async () => {
  const said: string[] = [], got: string[] = [];
  const ws = { handleEventData: async (d: any) => { got.push(d.headers[0].value); } };
  watchFrames(ws, (l) => said.push(l));
  const frame = (type: string) => ({ headers: [{ key: "type", value: type }], payload: new Uint8Array() });
  for (const t of ["event", "card", "card", "event"]) await ws.handleEventData(frame(t));
  assert.deepEqual(got, ["event", "card", "card", "event"], "every frame still reaches the SDK");
  assert.equal(said.length, 1);
  assert.match(said[0]!, /type card dropped by the SDK/);
});
