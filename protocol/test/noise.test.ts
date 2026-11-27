// Noise state machine against the cacophony vector plus the fatal-failure rules of 02. noise-node.test.ts runs
// this file again with the node:crypto backend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dh } from "../noise/crypto.ts";
import {
  CipherState,
  createNoiseInitiator,
  createNoiseResponder,
  generateNoiseKeyPair,
  NoiseProtocolError,
  NOISE_NK_PROTOCOL_NAME,
} from "../noise/handshake.ts";

const vectors = JSON.parse(
  readFileSync(new URL("../noise/fixtures/cacophony-nk-25519-chachapoly-sha256.json", import.meta.url), "utf8"),
).vectors;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));
const kp = (secretHex: string) => {
  const secretKey = fromHex(secretHex);
  return { secretKey, publicKey: dh().publicKey(secretKey) };
};
const empty = new Uint8Array(0);

test("cacophony has vectors for our pattern", () => {
  assert.ok(vectors.length >= 1);
  for (const v of vectors) assert.equal(v.protocol_name, NOISE_NK_PROTOCOL_NAME);
});

for (const [i, v] of vectors.entries()) {
  test(`cacophony vector #${i}: handshake, hash and all transport messages`, () => {
    const resp = kp(v.resp_static);
    assert.equal(hex(resp.publicKey), v.init_remote_static);
    const ini = createNoiseInitiator({
      remoteStatic: fromHex(v.init_remote_static),
      prologue: fromHex(v.init_prologue),
      ephemeral: kp(v.init_ephemeral),
    });
    const res = createNoiseResponder({ localStatic: resp, prologue: fromHex(v.resp_prologue), ephemeral: kp(v.resp_ephemeral) });
    const [m1, m2, ...rest] = v.messages;
    const c1 = ini.writeMessage(fromHex(m1.payload));
    assert.equal(hex(c1), m1.ciphertext);
    assert.equal(hex(res.readMessage(c1)), m1.payload);
    const c2 = res.writeMessage(fromHex(m2.payload));
    assert.equal(hex(c2), m2.ciphertext);
    assert.equal(hex(ini.readMessage(c2)), m2.payload);
    assert.equal(hex(ini.handshakeHash()), v.handshake_hash);
    assert.equal(hex(res.handshakeHash()), v.handshake_hash);
    const a = ini.split();
    const b = res.split();
    rest.forEach((m: { payload: string; ciphertext: string }, j: number) => {
      const [tx, rx] = j % 2 === 0 ? [a.send, b.receive] : [b.send, a.receive];
      const c = tx.encryptWithAd(empty, fromHex(m.payload));
      assert.equal(hex(c), m.ciphertext);
      assert.equal(hex(rx.decryptWithAd(empty, c)), m.payload);
    });
  });
}

function pair() {
  const hub = generateNoiseKeyPair();
  const prologue = new TextEncoder().encode("t");
  const ini = createNoiseInitiator({ remoteStatic: hub.publicKey, prologue });
  const res = createNoiseResponder({ localStatic: hub, prologue });
  res.readMessage(ini.writeMessage(empty));
  ini.readMessage(res.writeMessage(empty));
  return { client: ini.split(), server: res.split() };
}

test("a failed decrypt kills the receive state (02: fatal)", () => {
  const { client, server } = pair();
  const first = client.send.encryptWithAd(empty, new Uint8Array([1]));
  const bad = first.slice();
  bad[0]! ^= 1;
  assert.throws(() => server.receive.decryptWithAd(empty, bad), NoiseProtocolError);
  assert.throws(() => server.receive.decryptWithAd(empty, first), /cleared/);
});

test("replay, reflection and reordering fail", () => {
  for (const attack of ["replay", "reflect", "reorder"]) {
    const { client, server } = pair();
    const m1 = client.send.encryptWithAd(empty, new Uint8Array([1]));
    const m2 = client.send.encryptWithAd(empty, new Uint8Array([2]));
    if (attack === "replay") {
      server.receive.decryptWithAd(empty, m1);
      assert.throws(() => server.receive.decryptWithAd(empty, m1), NoiseProtocolError);
    } else if (attack === "reflect") {
      assert.throws(() => client.receive.decryptWithAd(empty, m1), NoiseProtocolError);
    } else {
      assert.throws(() => server.receive.decryptWithAd(empty, m2), NoiseProtocolError);
    }
  }
});

test("a recorded first message cannot derive a fresh responder's keys", () => {
  const hub = generateNoiseKeyPair();
  const prologue = new TextEncoder().encode("t");
  const ini = createNoiseInitiator({ remoteStatic: hub.publicKey, prologue });
  const msg1 = ini.writeMessage(empty);
  const orig = createNoiseResponder({ localStatic: hub, prologue });
  orig.readMessage(msg1);
  ini.readMessage(orig.writeMessage(empty));
  const record = ini.split().send.encryptWithAd(empty, new Uint8Array([7]));
  const replay = createNoiseResponder({ localStatic: hub, prologue });
  replay.readMessage(msg1);
  replay.writeMessage(empty);
  assert.throws(() => replay.split().receive.decryptWithAd(empty, record), NoiseProtocolError);
});

test("low-order ephemeral, wrong responder key and wrong prologue are rejected", () => {
  const hub = generateNoiseKeyPair();
  const prologue = new TextEncoder().encode("t");
  assert.throws(() => createNoiseResponder({ localStatic: hub, prologue }).readMessage(new Uint8Array(48)), NoiseProtocolError);
  const other = generateNoiseKeyPair();
  const ini = createNoiseInitiator({ remoteStatic: other.publicKey, prologue });
  assert.throws(() => createNoiseResponder({ localStatic: hub, prologue }).readMessage(ini.writeMessage(empty)), NoiseProtocolError);
  const ini2 = createNoiseInitiator({ remoteStatic: hub.publicKey, prologue: new TextEncoder().encode("u") });
  assert.throws(() => createNoiseResponder({ localStatic: hub, prologue }).readMessage(ini2.writeMessage(empty)), NoiseProtocolError);
});

test("nonce exhaustion in both directions", () => {
  const MAX = (1n << 64n) - 1n;
  const key = new Uint8Array(32).map((_, i) => i + 1);
  const tx = new CipherState();
  const rx = new CipherState();
  tx.initializeKey(key.slice(), MAX - 1n);
  rx.initializeKey(key.slice(), MAX - 1n);
  const last = tx.encryptWithAd(empty, new Uint8Array([1, 2, 3]));
  assert.throws(() => tx.encryptWithAd(empty, new Uint8Array([4])), /nonce exhausted/);
  assert.deepEqual(Array.from(rx.decryptWithAd(empty, last)), [1, 2, 3]);
  assert.throws(() => rx.decryptWithAd(empty, last), /nonce exhausted/);
});

test("handshake refuses out-of-turn and post-completion use", () => {
  const hub = generateNoiseKeyPair();
  const ini = createNoiseInitiator({ remoteStatic: hub.publicKey, prologue: empty });
  const res = createNoiseResponder({ localStatic: hub, prologue: empty });
  assert.throws(() => res.writeMessage(empty), NoiseProtocolError);
  assert.throws(() => ini.split(), NoiseProtocolError);
  res.readMessage(ini.writeMessage(empty));
  assert.throws(() => ini.writeMessage(empty), NoiseProtocolError);
  ini.readMessage(res.writeMessage(empty));
  assert.throws(() => ini.readMessage(empty), NoiseProtocolError);
  ini.split();
  assert.throws(() => ini.split(), NoiseProtocolError);
});
