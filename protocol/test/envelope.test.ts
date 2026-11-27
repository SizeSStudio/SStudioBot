import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeEnvelope, decodeEnvelope, OPEN, DATA, CLOSE, NOISE_MAX, maskIp, jsonPayload, readJsonPayload } from "../envelope.ts";

test("envelope round-trip", () => {
  for (const [type, sid] of [[OPEN, 0], [DATA, 1], [CLOSE, 0xffffffff]] as const) {
    const p = jsonPayload({ code: 1, reason: "auth" });
    const e = decodeEnvelope(encodeEnvelope(type, sid, p))!;
    assert.equal(e.type, type); assert.equal(e.sid, sid);
    assert.deepEqual(readJsonPayload(e.payload), { code: 1, reason: "auth" });
  }
});

test("decoding works on a view into a bigger buffer", () => {
  const raw = encodeEnvelope(DATA, 42, Uint8Array.of(9, 9));
  const big = new Uint8Array(raw.length + 10); big.set(raw, 10);
  const e = decodeEnvelope(big.subarray(10))!;
  assert.equal(e.sid, 42); assert.deepEqual([...e.payload], [9, 9]);
});

test("invalid envelopes are null; oversize is refused", () => {
  assert.equal(decodeEnvelope(Uint8Array.of(1, 0, 0)), null);
  assert.equal(decodeEnvelope(Uint8Array.of(9, 0, 0, 0, 1)), null);
  assert.equal(decodeEnvelope(new Uint8Array(NOISE_MAX + 6).fill(2)), null);
  assert.throws(() => encodeEnvelope(DATA, 1, new Uint8Array(NOISE_MAX + 1)));
  assert.throws(() => encodeEnvelope(DATA, -1, new Uint8Array(1)));
});

test("ip masking keeps /24 and /48", () => {
  assert.equal(maskIp("203.0.113.77"), "203.0.113.0/24");
  assert.equal(maskIp("::ffff:198.51.100.9"), "198.51.100.0/24");
  assert.equal(maskIp("2001:db8:abcd:12::1"), "2001:db8:abcd::/48");
  assert.equal(maskIp("2001:db8::1"), "2001:db8:0::/48");
  assert.equal(maskIp("garbage"), "unknown");
});
