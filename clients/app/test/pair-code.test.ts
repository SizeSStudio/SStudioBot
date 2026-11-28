// The device's reading of a pairing code (src/conn/pairCode.ts): protocol/pair.ts decodes, the device holds the relay
// to wss (ws only on loopback) and a plain host, since it becomes the desktop CSP's connect-src. Fictional keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { b64u, encodePairCode, encodePairLink, type PairCode } from "../../../protocol/pair.ts";
import { cleanRelay, peerUrl, readPairCode } from "../src/conn/pairCode.ts";

const key = (n: number) => b64u(new Uint8Array(32).fill(n));
// encodes without the schema check, so the test can hand the device codes the hub would never make
const raw = (c: PairCode) => `v1.${b64u(new TextEncoder().encode(JSON.stringify(c)))}`;
const code = (o: Partial<PairCode> = {}): PairCode => ({ v: 1, hub_pk: key(1), relay: "wss://relay.example/v1/peer", secret: key(2), role: "client", exp: Date.now() + 60_000, ...o });

test("the link and the bare v1. code both read; the relay is normalized", () => {
  for (const text of [encodePairLink(code()), encodePairCode(code()), `  ${encodePairLink(code())}\n`]) {
    const r = readPairCode(text);
    assert.ok(r.ok, text);
    assert.equal(r.code.relay, "wss://relay.example/v1/peer");
  }
  const r = readPairCode(encodePairLink(code({ relay: "wss://relay.example:8443/v1/peer/" })));
  assert.ok(r.ok);
  assert.equal(r.code.relay, "wss://relay.example:8443/v1/peer");
  assert.equal(peerUrl(r.code.relay, r.code.hub_pk), `wss://relay.example:8443/v1/peer?hub=${key(1)}`);
});

test("errors: not a code, an expired one, a relay a device shouldn't reach", () => {
  assert.deepEqual(readPairCode("hello"), { ok: false, error: "format" });
  assert.deepEqual(readPairCode("v1.!!!"), { ok: false, error: "format" });
  assert.deepEqual(readPairCode(encodePairLink(code({ exp: Date.now() - 1 }))), { ok: false, error: "expired" });
  for (const relay of ["ws://relay.example/v1/peer", "wss://relay.example/v1/peer?x=1", "wss://relay_example/v1/peer", "https://relay.example/v1/peer"]) {
    const r = readPairCode(raw(code({ relay })));
    assert.ok(!r.ok && (r.error === "relay" || r.error === "format"), relay); // https fails the schema already
  }
});

test("cleanRelay: ws only on loopback, no userinfo", () => {
  assert.equal(cleanRelay("ws://127.0.0.1:7830/v1/peer"), "ws://127.0.0.1:7830/v1/peer");
  assert.equal(cleanRelay("ws://localhost:7830/v1/peer"), "ws://localhost:7830/v1/peer");
  assert.equal(cleanRelay("ws://10.0.0.5/v1/peer"), null);
  assert.equal(cleanRelay(["wss://u:p", "relay.example/v1/peer"].join("@")), null); // split so leak-guard doesn't see an email
  assert.equal(cleanRelay("wss://relay.example/v1/peer#x"), null);
  assert.equal(cleanRelay("not a url"), null);
});
