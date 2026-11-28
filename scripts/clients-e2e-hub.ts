// A hub for the clients' end-to-end test (clients/app/test/e2e.test.ts), as a child process: clients/ may not import
// hub/, so the test spawns this and talks to it over stdio. Inside: the real /api/v1 dispatcher and pump (W2b) on a
// throwaway home, the real Noise responder, and a stand-in for W2a's link that checks auth and pair as 06 says
// (signature over prefix ‖ handshake hash ‖ challenge, invite by sha256(secret), single use, 10 minutes). When the
// link lands this stays a test fixture; the client side doesn't change. Fictional data only.
//
// stdio framing, both ways: u32 BE length | kind (1) | payload
//   test → hub: 0x00 open (a new WS), 0x01 data (one WS message), 0x02 client closed, 0x10 control JSON
//   hub → test: 0x01 data, 0x02 close JSON { code, reason }, 0x10 control reply JSON
import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { respond, generateNoiseKeyPair, type Transport } from "../protocol/noise/channel.ts";
import { encodeFrame, parseFrame, type Frame } from "../protocol/frames.ts";
import { CLOSE_HUB_OFFLINE } from "../protocol/envelope.ts";
import { AUTH_CLOSE_REASON, b64uDecode, b64uEncode, makePairCode, signedMessage } from "../protocol/link.ts";
import { PROTOCOL } from "../protocol/version.ts";
import { openDb } from "../hub/src/db/db.ts";
import { createApi, type Conn } from "../hub/src/api/index.ts";
import { ingest } from "../hub/src/inbox.ts";
import { itemStart } from "../hub/src/items.ts";
import { tempHome } from "../hub/test/helpers.ts";

const h = tempHome("clients-e2e");
const db = openDb(h.db);
const api = createApi({ db, blobs: h.blobs, hubSha: () => "e2esha", pump: { tickMs: 20, beatMs: 200 } });
api.start();
const hubKey = generateNoiseKeyPair();
const HUB_PK = b64uEncode(hubKey.publicKey);
const RELAY = "wss://relay.example";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest();

// ── stdio ────────────────────────────────────────────────────────────────────────────────────────────────────
function out(kind: number, payload: Uint8Array) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(payload.length + 1, 0);
  head[4] = kind;
  process.stdout.write(Buffer.concat([head, payload]));
}
const reply = (v: unknown) => out(0x10, Buffer.from(JSON.stringify(v)));

// ── one session (the test opens one WS at a time, like a device) ─────────────────────────────────────────────
type Session = {
  transport: Transport | null; challenge: Uint8Array; caller: { device_id: string; role: "client" | "node" } | null; conn: Conn; open: boolean;
};
let s: Session | null = null;
let offline = false;

function closeSession(code: number, reason: string) {
  if (!s) return;
  const old = s;
  s = null;
  old.open = false;
  api.closeConn(old.conn);
  out(0x02, Buffer.from(JSON.stringify({ code, reason })));
}

function sendFrame(sess: Session, f: Frame) {
  if (!sess.open || !sess.transport) return;
  for (const piece of sess.transport.seal(new TextEncoder().encode(encodeFrame(f)))) out(0x01, piece);
}

function onOpen() {
  if (s) { s.open = false; api.closeConn(s.conn); }
  if (offline) { s = null; out(0x02, Buffer.from(JSON.stringify({ code: CLOSE_HUB_OFFLINE, reason: "hub offline" }))); return; }
  const sess: Session = { transport: null, challenge: new Uint8Array(randomBytes(32)), caller: null, open: true, conn: null as unknown as Conn };
  sess.conn = { send: (f) => sendFrame(sess, f), writable: () => sess.open };
  s = sess;
}

function authFail() { closeSession(4401, AUTH_CLOSE_REASON); }

async function onData(msg: Uint8Array) {
  const sess = s;
  if (!sess) return;
  try {
    if (!sess.transport) {
      const r = respond(hubKey, msg, () => ({ v: PROTOCOL.current, challenge: b64uEncode(sess.challenge), hub_time: Date.now() }));
      sess.transport = r.transport;
      out(0x01, r.reply);
      return;
    }
    const whole = sess.transport.open(msg);
    if (!whole) return;
    const f = parseFrame(new TextDecoder().decode(whole));
    if (!f) return;
    if (!sess.caller) {
      if (f.t === "auth") {
        const row = db.one<{ public_key: Uint8Array; role: string; removed_at: number | null }>("SELECT public_key, role, removed_at FROM devices WHERE id = ?", f.device_id);
        const ok = row && row.removed_at === null &&
          ed25519.verify(b64uDecode(f.sig), signedMessage("auth", sess.transport.handshakeHash, sess.challenge), new Uint8Array(row.public_key));
        if (!ok) return authFail();
        sess.caller = { device_id: f.device_id, role: row.role as "client" };
        db.run("UPDATE devices SET last_seen = ? WHERE id = ?", Date.now(), f.device_id);
        return;
      }
      if (f.t === "pair") {
        const pk = b64uDecode(f.public_key);
        const inv = db.one<{ id: number; role: string; expires: number; used_at: number | null }>(
          "SELECT id, role, expires, used_at FROM device_invites WHERE secret_hash = ?", sha(b64uDecode(f.secret)));
        const ok = inv && inv.used_at === null && inv.expires > Date.now() && pk.length === 32 &&
          ed25519.verify(b64uDecode(f.sig), signedMessage("pair", sess.transport.handshakeHash, sess.challenge), pk);
        if (!ok) return authFail();
        const id = sha(pk).toString("hex");
        db.tx(() => {
          db.run("UPDATE device_invites SET used_at = ?, used_by = ? WHERE id = ?", Date.now(), id, inv.id);
          db.run("INSERT INTO devices(id, public_key, name, platform, role, invite_id, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?)",
            id, pk, f.name, f.platform, inv.role, inv.id, Date.now(), Date.now());
        });
        sess.caller = { device_id: id, role: inv.role as "client" };
        return;
      }
      return authFail(); // the first frame must be auth or pair (02)
    }
    if (f.t !== "req") return;
    const r = await api.dispatch(f, { ...sess.caller, conn: sess.conn });
    sendFrame(sess, { t: "res", id: f.id, status: r.status, ...(r.body !== undefined ? { body: r.body } : {}), ...(r.seq !== undefined ? { seq: r.seq } : {}) });
  } catch {
    closeSession(1011, "protocol");
  }
}

// ── controls the test sends ──────────────────────────────────────────────────────────────────────────────────
type Ctl = { id: number; cmd: string; [k: string]: unknown };
function control(c: Ctl) {
  const ok = (v: object = {}) => reply({ id: c.id, ...v });
  switch (c.cmd) {
    case "hub": return ok({ hub_pk: HUB_PK });
    case "invite": {
      const secret = new Uint8Array(randomBytes(32));
      const exp = Date.now() + 10 * 60_000;
      db.run("INSERT INTO device_invites(secret_hash, role, created_by, created_at, expires) VALUES (?, 'client', 'cli', ?, ?)", sha(secret), Date.now(), exp);
      return ok({ link: makePairCode({ v: 1, hub_pk: HUB_PK, relay: RELAY, secret: b64uEncode(secret), role: "client", exp }) });
    }
    case "say": {
      ingest(db, { lane: String(c.lane), kind: "user", source: "feishu", source_msg_id: `om_${randomBytes(6).toString("hex")}`, payload: { text: String(c.text), owner: true } });
      api.pump.kick();
      return ok();
    }
    case "run": {
      const run = `r_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
      db.run("INSERT INTO runs(id, lane, role, tier, status, started) VALUES (?, ?, 'main', 'chat', 'running', ?)", run, String(c.lane), Date.now());
      api.pump.kick();
      return ok({ run });
    }
    case "delta": api.pump.onItem(String(c.run), String(c.lane), { k: "delta", text: String(c.text) }); return ok();
    case "message": {
      itemStart(db, h.blobs, { lane: String(c.lane), run_id: String(c.run), kind: "assistant", status: "done", body: { text: String(c.text) } });
      api.pump.onItem(String(c.run), String(c.lane), { k: "message", text: String(c.text) });
      api.pump.kick();
      return ok();
    }
    case "end_run": db.run("UPDATE runs SET status = 'done', ended = ? WHERE id = ?", Date.now(), String(c.run)); api.pump.kick(); return ok();
    case "drop": closeSession(1006, ""); return ok();
    case "offline": offline = Boolean(c.on); if (offline) closeSession(CLOSE_HUB_OFFLINE, "hub offline"); return ok();
    case "remove": {
      db.run("UPDATE devices SET removed_at = ?, removed_by = 'cli' WHERE id = ?", Date.now(), String(c.device_id));
      if (s?.caller?.device_id === c.device_id) closeSession(4401, AUTH_CLOSE_REASON);
      return ok();
    }
    case "state": return ok({
      streams: api.pump.streams, authed: s?.caller?.device_id ?? null,
      devices: db.all<{ id: string; name: string; platform: string }>("SELECT id, name, platform FROM devices"),
      invites_used: db.one<{ n: number }>("SELECT count(*) AS n FROM device_invites WHERE used_at IS NOT NULL")!.n,
    });
    case "quit": api.stop(); db.close?.(); process.exit(0);
    default: return ok({ error: `unknown ${c.cmd}` });
  }
}

let buf = Buffer.alloc(0);
let chain = Promise.resolve();
process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const n = buf.readUInt32BE(0);
    if (buf.length < 4 + n) break;
    const kind = buf[4]!, payload = new Uint8Array(buf.subarray(5, 4 + n));
    buf = buf.subarray(4 + n);
    // in order, one at a time: the dispatcher is async and frames on one connection must not overtake each other
    chain = chain.then(async () => {
      if (kind === 0x00) onOpen();
      else if (kind === 0x01) await onData(payload);
      else if (kind === 0x02) { if (s) { s.open = false; api.closeConn(s.conn); s = null; } }
      else if (kind === 0x10) control(JSON.parse(Buffer.from(payload).toString()) as Ctl);
    });
  }
});
process.stdin.on("end", () => { api.stop(); process.exit(0); });
