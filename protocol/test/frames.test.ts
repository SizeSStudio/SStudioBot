import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrame, encodeFrame, fragment, Reassembler, PIECE_MAX, FRAME_MAX } from "../frames.ts";

test("known frames round-trip; unknown fields are dropped, not errors", () => {
  const f = parseFrame(JSON.stringify({ t: "req", id: 1, method: "GET", path: "/api/v1/meta", future_field: 1 }));
  assert.deepEqual(f, { t: "req", id: 1, method: "GET", path: "/api/v1/meta" });
  assert.deepEqual(parseFrame(encodeFrame(f!)), f);
});

test("unknown t is ignored", () => {
  assert.equal(parseFrame(JSON.stringify({ t: "hologram", x: 1 })), null);
  assert.equal(parseFrame(JSON.stringify({ x: 1 })), null);
});

test("a known t with a bad shape is a protocol error", () => {
  assert.throws(() => parseFrame(JSON.stringify({ t: "req", id: 1, method: "GET", path: "/etc/passwd" })));
  assert.throws(() => parseFrame(JSON.stringify({ t: "auth", device_id: "XYZ", sig: "a" })));
  assert.throws(() => parseFrame("[1]"));
});

test("fragment / reassemble at the edges", () => {
  for (const n of [0, 1, PIECE_MAX - 1, PIECE_MAX, PIECE_MAX + 1, 3 * PIECE_MAX + 7, FRAME_MAX]) {
    const buf = new Uint8Array(n).map((_, i) => i % 251);
    const pieces = fragment(buf);
    assert.equal(pieces.length, Math.max(1, Math.ceil(n / PIECE_MAX)));
    for (const p of pieces) assert.ok(p.length <= PIECE_MAX + 1);
    const r = new Reassembler();
    let out: Uint8Array | null = null;
    pieces.forEach((p, i) => { out = r.push(p); assert.equal(out === null, i < pieces.length - 1); });
    assert.deepEqual(out, buf);
  }
});

test("over 1 MiB and bad flags are rejected", () => {
  assert.throws(() => fragment(new Uint8Array(FRAME_MAX + 1)));
  const r = new Reassembler();
  const more = new Uint8Array(PIECE_MAX + 1); more[0] = 0;
  assert.throws(() => { for (let i = 0; i < 20; i++) r.push(more); });
  assert.throws(() => new Reassembler().push(Uint8Array.of(7, 1, 2)));
  assert.throws(() => new Reassembler().push(new Uint8Array(0)));
});
