// The sbot channel on top of Noise: hello payloads, fragmenting, 1 MiB cap, every error fatal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  finishInitiator,
  generateNoiseKeyPair,
  MAX_FRAME_BYTES,
  MAX_PIECE_DATA,
  NoiseProtocolError,
  respond,
  startInitiator,
} from "../noise/channel.ts";

function connect() {
  const hub = generateNoiseKeyPair();
  const { hs, message } = startInitiator(hub.publicKey, { v: 1, role: "client", purpose: "auth" });
  assert.ok(message.byteLength <= 65535);
  const r = respond(hub, message, () => ({ v: 1, challenge: "c", hub_time: 1 }));
  assert.deepEqual(r.client, { v: 1, role: "client", purpose: "auth" });
  const { transport, hello } = finishInitiator(hs, r.reply);
  assert.equal(hello.challenge, "c");
  assert.deepEqual(transport.handshakeHash, r.transport.handshakeHash);
  return { device: transport, hub: r.transport, hubKey: hub };
}

function roundTrip(size: number) {
  const { device, hub } = connect();
  const frame = new Uint8Array(randomBytes(size));
  const pieces = device.seal(frame);
  assert.equal(pieces.length, Math.max(1, Math.ceil(size / MAX_PIECE_DATA)));
  for (const p of pieces) assert.ok(p.byteLength <= 65535);
  let out: Uint8Array | null = null;
  pieces.forEach((p, i) => {
    out = hub.open(p);
    if (i < pieces.length - 1) assert.equal(out, null);
  });
  assert.deepEqual(out, frame);
}

test("frames of 0, 1, piece boundary, 64 KiB and 1 MiB round-trip", () => {
  for (const n of [0, 1, MAX_PIECE_DATA, MAX_PIECE_DATA + 1, 65536, MAX_FRAME_BYTES]) roundTrip(n);
});

test("frames over 1 MiB are refused on both ends", () => {
  const { device } = connect();
  assert.throws(() => device.seal(new Uint8Array(MAX_FRAME_BYTES + 1)), NoiseProtocolError);
  // A sender that ignores the limit (17 full "more" pieces): the receiver dies once past 1 MiB.
  const evil = connect();
  const send = (evil.device as any).send;
  const piece = new Uint8Array(1 + MAX_PIECE_DATA); // flag 0x00 = more
  assert.throws(() => {
    for (let i = 0; i < 17; i++) evil.hub.open(send.encryptWithAd(new Uint8Array(0), piece));
  }, /too large/);
});

test("any tampered byte kills the channel", () => {
  for (let i = 0; i < 50; i++) {
    const { device, hub } = connect();
    const p = device.seal(new TextEncoder().encode('{"t":"req"}'))[0]!;
    const bad = p.slice();
    bad[Math.floor(Math.random() * bad.byteLength)]! ^= 1 << Math.floor(Math.random() * 8);
    assert.throws(() => hub.open(bad), NoiseProtocolError);
    assert.throws(() => hub.open(p), NoiseProtocolError); // dead afterwards, even for the genuine message
  }
});

test("a bad flag byte kills the channel", () => {
  const { device, hub } = connect();
  const send = (device as any).send;
  assert.throws(() => hub.open(send.encryptWithAd(new Uint8Array(0), new Uint8Array([0x02, 1]))), /flag/);
});

test("pairing code with a different hub key: the hub cannot read message 1", () => {
  const real = generateNoiseKeyPair();
  const fake = generateNoiseKeyPair();
  for (let i = 0; i < 10; i++) {
    const { message } = startInitiator(fake.publicKey, { v: 1, role: "client", purpose: "pair" });
    assert.throws(() => respond(real, message, () => ({ v: 1, challenge: "c", hub_time: 1 })), NoiseProtocolError);
  }
});
