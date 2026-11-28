// W2a units: the role check, the pairing code, the hub key file, invites at the edges. Fictional data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { tempHome } from "./helpers.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { b64u, decodePairCode, deviceIdOf, encodePairLink, fromB64u, type PairCode } from "../../protocol/pair.ts";
import { authorize, roleCheck } from "../src/link/roles.ts";
import { hubKeyPath, loadOrCreateHubKey } from "../src/link/keys.ts";
import { createInvite, redeemInvite, INVITE_MS } from "../src/link/pairing.ts";
import { peerUrlOf } from "../src/link/service.ts";
import { openDb } from "../src/db/db.ts";

useCrypto({ aead: nodeAead, dh: nodeDh });

test("authorize: client → /api/v1 only, node → /node/v1 only, nothing for odd paths or roles", () => {
  assert.equal(roleCheck("client", "/api/v1/status"), null);
  assert.equal(roleCheck("client", "/api/v1"), null);
  assert.equal(roleCheck("node", "/node/v1/tasks/t1"), null);
  for (const p of ["/api/v1/approvals/a/decide", "/api/v1/glances/g/answer", "/api/v1/threads/t/messages", "/api/v1/self/x", "/api/v1"]) assert.equal(roleCheck("node", p), 403, p);
  for (const p of ["/node/v1/x", "/api/v1x", "/api/v2/x", "/", ""]) assert.equal(roleCheck("client", p), 403, p);
  for (const p of ["/node/v1/../api/v1/status", "/node/v1/./x", "/node/v1//x", "/node/v1/%2e%2e/x", "/node/v1\\x", "/api/v1/.."]) {
    assert.equal(roleCheck("node", p), 403, p);
    assert.equal(roleCheck("client", p), 403, p);
  }
  assert.equal(roleCheck("admin" as "client", "/api/v1/status"), 403);
  // the dispatcher's shape: the query string isn't the route (a cursor may well contain %)
  const q = (role: "client" | "node", path: string) => authorize({ device_id: "d1", role }, { method: "GET", path });
  assert.deepEqual(q("client", "/api/v1/threads/t1/items?before=a%3Db"), { ok: true });
  assert.equal(q("node", "/api/v1/devices?all=1").ok, false);
  assert.equal(q("client", "/api/v1/../node/v1/x?y=1").ok, false);
  const v = q("node", "/api/v1/self/x");
  assert.ok(!v.ok && v.status === 403 && !v.error.includes("self"), "the error names the API, not the route");
});

test("pairing code: link or bare code decode; tampering, other versions and sloppy base64url are refused", () => {
  const c: PairCode = { v: 1, hub_pk: b64u(randomBytes(32)), relay: "wss://relay.example.com/v1/peer", secret: b64u(randomBytes(32)), role: "client", exp: 1_800_000_000_000 };
  const link = encodePairLink(c);
  assert.match(link, /^sstudiobot:\/\/pair#v1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePairCode(link), c);
  assert.deepEqual(decodePairCode(`  ${link.slice("sstudiobot://pair#".length)}\n`), c);
  assert.throws(() => decodePairCode(link.replace("#v1.", "#v2.")));
  assert.throws(() => decodePairCode("https://example.com/#v1.abc"));
  assert.throws(() => decodePairCode(link + "="));
  const body = JSON.parse(Buffer.from(link.split("#v1.")[1]!, "base64url").toString());
  for (const bad of [{ ...body, hub_pk: "short" }, { ...body, role: "admin" }, { ...body, relay: "http://x/v1/peer" }, { ...body, v: 2 }]) {
    assert.throws(() => decodePairCode(`v1.${Buffer.from(JSON.stringify(bad)).toString("base64url")}`));
  }
  assert.throws(() => fromB64u("ab+c"));
  assert.throws(() => fromB64u("abd"), "non-canonical trailing bits");
  assert.equal(deviceIdOf(new Uint8Array(32)).length, 64);
  assert.equal(peerUrlOf("wss://relay.example.com/v1/hub"), "wss://relay.example.com/v1/peer");
  assert.throws(() => peerUrlOf("wss://relay.example.com/v1/other"));
});

test("hub.key: made once at 0600, put back to 0600, same key on the next start; a bad file names the file only", () => {
  const h = tempHome("keys");
  const a = loadOrCreateHubKey(h.keys);
  const f = hubKeyPath(h.keys);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(h.keys).mode & 0o077, 0);
  chmodSync(f, 0o644);
  const b = loadOrCreateHubKey(h.keys);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(b.publicB64u, a.publicB64u);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!readFileSync(f, "utf8").includes(a.publicB64u), "only the secret is stored; the public key is derived");
  writeFileSync(f, "not-a-key-but-secret-looking\n");
  assert.throws(() => loadOrCreateHubKey(h.keys), (e: Error) => /hub\.key/.test(e.message) && !e.message.includes("secret-looking"));
});

test("redeemInvite: once, in time, the right role, a new key; a failure is audited without the secret", () => {
  const h = tempHome("invite");
  const db = openDb(h.db);
  try {
    const now = 1_800_000_000_000;
    const mk = (role: "client" | "node" = "client") => {
      const r = createInvite(db, { role, created_by: "cli", hubPk: b64u(randomBytes(32)), relayUrl: "wss://relay.example.com/v1/peer", relayEnabled: false, now });
      return { r, secret: fromB64u(decodePairCode(r.link).secret) };
    };
    const pk = () => new Uint8Array(randomBytes(32));
    const base = { name: "测试", platform: "linux", ipMasked: "203.0.113.0/24" };
    const one = mk();
    assert.equal(one.r.expires, now + INVITE_MS);
    assert.ok(!db.one("SELECT 1 FROM device_audit WHERE detail LIKE ?", `%${decodePairCode(one.r.link).secret}%`));
    const k1 = pk();
    assert.ok(redeemInvite(db, { ...base, secret: one.secret, publicKey: k1, role: "client", now: now + 1 }));
    assert.equal(redeemInvite(db, { ...base, secret: one.secret, publicKey: pk(), role: "client", now: now + 2 }), undefined, "used");
    const two = mk();
    assert.equal(redeemInvite(db, { ...base, secret: two.secret, publicKey: pk(), role: "client", now: now + INVITE_MS }), undefined, "expired at exactly 10 min");
    const three = mk("node");
    assert.equal(redeemInvite(db, { ...base, secret: three.secret, publicKey: pk(), role: "client", now: now + 1 }), undefined, "role");
    assert.equal(redeemInvite(db, { ...base, secret: three.secret, publicKey: k1, role: "node", now: now + 1 }), undefined, "known key");
    assert.equal(redeemInvite(db, { ...base, secret: three.secret, publicKey: new Uint8Array(31), role: "node", now: now + 1 }), undefined, "short key");
    // the failures above didn't burn it: the right device still pairs
    assert.ok(redeemInvite(db, { ...base, secret: three.secret, publicKey: pk(), role: "node", now: now + 1 }));
    assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_audit WHERE action = 'pair_failed'")!.n, 5);
    assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices")!.n, 2);
  } finally { db.close(); }
});
