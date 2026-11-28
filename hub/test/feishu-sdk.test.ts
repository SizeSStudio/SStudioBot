// The real SDK (1.77.0) against a local HTTP mock whose token endpoint fails: what reaches our log and our errors
// must not carry the app secret. The second test pins down why the masking logger exists: the SDK's own logging
// hands over the raw request, secret included. Fictional credentials only; nothing leaves 127.0.0.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { inspect } from "node:util";
import type { AddressInfo } from "node:net";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { SdkBackend } from "../src/channels/feishu/sdk.ts";

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
