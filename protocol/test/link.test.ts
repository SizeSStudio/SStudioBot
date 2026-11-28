// Pairing code, signed-message layout, base64url (06). Fictional keys and relay names only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { b64uDecode, b64uEncode, makePairCode, parsePairCode, peerUrl, signedMessage, type PairCode } from "../link.ts";

const key = () => b64uEncode(new Uint8Array(randomBytes(32)));
const code = (o: Partial<PairCode> = {}): PairCode =>
  ({ v: 1, hub_pk: key(), relay: "wss://relay.example", secret: key(), role: "client", exp: Date.now() + 600_000, ...o });

test("base64url matches Buffer's for every length 0..70, and refuses non-canonical input", () => {
  for (let n = 0; n <= 70; n++) {
    const b = new Uint8Array(randomBytes(n));
    const s = b64uEncode(b);
    assert.equal(s, Buffer.from(b).toString("base64url"));
    assert.deepEqual(b64uDecode(s), b);
  }
  for (const bad of ["a", "ab=", "a+b/", "AB", "a b"]) assert.throws(() => b64uDecode(bad), bad);
});

test("a pairing code round-trips as a link and as the bare v1. part", () => {
  const c = code();
  const link = makePairCode(c);
  assert.ok(link.startsWith("sstudiobot://pair#v1."));
  assert.deepEqual(parsePairCode(link), { ok: true, code: c });
  assert.deepEqual(parsePairCode(`  ${link.slice("sstudiobot://pair#".length)}\n`), { ok: true, code: c });
});

test("each wrong part is named", () => {
  const cases: [string, string][] = [
    ["https://x.example/pair#v1.abc", "format"],
    ["v1.%%%", "format"],
    ["v1." + b64uEncode(new TextEncoder().encode("[1]")), "json"],
    [makePairCode(code({ v: 2 as 1 })), "version"],
    [makePairCode(code({ hub_pk: key().slice(0, 20) })), "hub_pk"],
    [makePairCode(code({ secret: "AAAA" })), "secret"],
    [makePairCode(code({ role: "admin" as "client" })), "role"],
    [makePairCode(code({ exp: Date.now() - 1 })), "expired"],
    [makePairCode(code({ relay: "ws://relay.example" })), "relay"],
    [makePairCode(code({ relay: "wss://u:p@relay.example" })), "relay"],
    [makePairCode(code({ relay: "wss://relay.example/?x=1" })), "relay"],
    [makePairCode(code({ relay: "wss://relay_example" })), "relay"],
    [makePairCode(code({ relay: "wss://re lay.example" })), "relay"],
  ];
  for (const [input, error] of cases) assert.deepEqual(parsePairCode(input), { ok: false, error }, input);
});

test("relay keeps a port and a path prefix, loses the trailing slash; peerUrl builds the endpoint", () => {
  const p = parsePairCode(makePairCode(code({ relay: "wss://relay.example:8443/sbot/" })));
  assert.ok(p.ok);
  assert.equal(p.code.relay, "wss://relay.example:8443/sbot");
  assert.equal(peerUrl(p.code.relay, "PK"), "wss://relay.example:8443/sbot/v1/peer?hub=PK");
});

test("signed message: prefix ‖ hash ‖ challenge, and the two purposes differ", () => {
  const h = new Uint8Array(32).fill(1), c = new Uint8Array(32).fill(2);
  const a = signedMessage("auth", h, c), p = signedMessage("pair", h, c);
  assert.equal(new TextDecoder().decode(a.subarray(0, 11)), "sbot-auth/1");
  assert.equal(new TextDecoder().decode(p.subarray(0, 11)), "sbot-pair/1");
  assert.deepEqual(a.subarray(11, 43), h);
  assert.deepEqual(a.subarray(43), c);
  assert.throws(() => signedMessage("auth", h, new Uint8Array(16)));
  assert.throws(() => signedMessage("auth", new Uint8Array(31), c));
});
