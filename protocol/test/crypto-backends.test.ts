// The backends must be byte-for-byte interchangeable: a hub on node:crypto talks to a web client on noble.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { nobleAead, nobleDh, type Aead, type Dh } from "../noise/crypto.ts";
import { nodeAead, nodeDh } from "../noise/node-crypto.ts";

const rnd = (n: number) => new Uint8Array(randomBytes(n));
const pairs: [string, Aead, Aead][] = [["noble→node", nobleAead, nodeAead], ["node→noble", nodeAead, nobleAead]];

test("AEAD: sealed by one backend, opened by the other; same bytes", () => {
  for (const [name, a, b] of pairs) {
    for (const n of [0, 1, 63, 64, 65, 65518, 1 << 20]) {
      const key = rnd(32), nonce = rnd(12), ad = rnd(32), pt = rnd(n);
      const ct = a.seal(key, nonce, ad, pt);
      assert.deepEqual(ct, b.seal(key, nonce, ad, pt), `${name} ${n}`);
      assert.deepEqual(b.open(key, nonce, ad, ct), pt, `${name} ${n}`);
    }
  }
});

test("AEAD: both backends reject a flipped bit in body, tag or AD, and a short ciphertext", () => {
  for (const aead of [nobleAead, nodeAead]) {
    const key = rnd(32), nonce = rnd(12), ad = rnd(8), ct = aead.seal(key, nonce, ad, rnd(40));
    for (const i of [0, 39, 40, 55]) {
      const bad = ct.slice();
      bad[i]! ^= 0x80;
      assert.throws(() => aead.open(key, nonce, ad, bad));
    }
    const badAd = ad.slice();
    badAd[0]! ^= 1;
    assert.throws(() => aead.open(key, nonce, badAd, ct));
    assert.throws(() => aead.open(key, nonce, ad, ct.subarray(0, 15)));
  }
});

test("X25519: keys and shared secrets agree across backends", () => {
  const backends: Dh[] = [nobleDh, nodeDh];
  for (const gen of backends) {
    const a = gen.generateKeyPair(), b = gen.generateKeyPair();
    assert.equal(a.secretKey.byteLength, 32);
    assert.equal(a.publicKey.byteLength, 32);
    for (const x of backends) {
      assert.deepEqual(x.publicKey(a.secretKey), a.publicKey);
      assert.deepEqual(x.dh(a.secretKey, b.publicKey), gen.dh(b.secretKey, a.publicKey));
    }
  }
});

test("X25519: a low-order peer key never yields a usable secret", () => {
  // all-zero and the order-8 point from RFC 7748 §6.1's list; the handshake also rejects an all-zero output
  const lowOrder = [new Uint8Array(32), Uint8Array.from(Buffer.from("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800", "hex"))];
  for (const d of [nobleDh, nodeDh]) {
    const me = d.generateKeyPair();
    for (const pk of lowOrder) {
      let out: Uint8Array | null = null;
      try { out = d.dh(me.secretKey, pk); } catch { /* rejected */ }
      if (out) assert.ok(out.every((b) => b === 0), "low-order key gave a non-zero secret");
    }
  }
});
