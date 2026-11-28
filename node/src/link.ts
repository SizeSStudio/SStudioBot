// The two ways to the hub (05 link.ts). Local: length-prefixed frames over hub.sock (protocol/lenframe.ts), no
// pairing — file permissions are the lock (03 link, veto 3). Remote: the relay's /v1/peer WebSocket, a Noise channel
// to the hub's key from the pairing, then `auth` signed with this device's key (06). Both hand application frames to a
// Peer and resolve when the connection is gone.
import { createConnection } from "node:net";
import { encodeLen, FrameReader } from "../../protocol/lenframe.ts";
import { finishInitiator, startInitiator, type HubHello, type Transport } from "../../protocol/noise/channel.ts";
import { encodeFrame } from "../../protocol/frames.ts";
import { AUTH_PREFIX, PAIR_PREFIX, b64u, fromB64u, signedBytes } from "../../protocol/pair.ts";
import { PROTOCOL } from "../../protocol/version.ts";
import { Peer, type Serve } from "./peer.ts";

export type Logger = (msg: string, fields?: Record<string, unknown>) => void;
export type Conn = { peer: Peer; done: Promise<{ code?: number; reason?: string }> };

/** hub.sock: resolves once connected (rejects if it can't). */
export function connectLocal(path: string, serve: Serve): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    const r = new FrameReader();
    let peer: Peer | undefined;
    const done = new Promise<{ code?: number; reason?: string }>((res) => sock.on("close", () => { peer?.ended(); res({}); }));
    sock.on("connect", () => {
      peer = new Peer((t) => { if (!sock.destroyed) sock.write(encodeLen(t)); }, () => sock.destroy(), serve);
      resolve({ peer, done });
    });
    sock.on("data", (chunk) => {
      let texts: string[];
      try { texts = r.push(chunk); } catch { sock.destroy(); return; }
      for (const t of texts) peer?.onText(t);
    });
    sock.on("error", (e) => { if (!peer) reject(e); });
  });
}

export interface Signer { publicKey: Uint8Array; deviceId: string; sign(msg: Uint8Array): Uint8Array }

/**
 * The relay: WebSocket to `<relay>?hub=<hub_pk>`, Noise message 1/2 (the hub's static key is the trust anchor; a
 * relay or a fake hub without that key can't finish it), then the first frame: `auth` (or `pair` when pairing).
 * Node 24's own WebSocket client, so no `ws` dependency on the node.
 */
export function connectRelay(
  o: { relay: string; hubPk: string; signer: Signer; pair?: { secret: string; name: string; platform: string } },
  serve: Serve,
): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${o.relay}?hub=${o.hubPk}`);
    ws.binaryType = "arraybuffer";
    const { hs, message } = startInitiator(fromB64u(o.hubPk), { v: PROTOCOL.current, role: "node", purpose: o.pair ? "pair" : "auth" });
    let t: Transport | undefined;
    let peer: Peer | undefined;
    let settled = false;
    let endDone!: (x: { code?: number; reason?: string }) => void;
    const done = new Promise<{ code?: number; reason?: string }>((res) => (endDone = res));
    const sendText = (text: string) => {
      if (!t || ws.readyState !== WebSocket.OPEN) return;
      for (const piece of t.seal(new TextEncoder().encode(text))) ws.send(piece);
    };
    ws.addEventListener("open", () => ws.send(message));
    ws.addEventListener("message", (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      if (!t) {
        let hello: HubHello;
        try { const r = finishInitiator(hs, data); t = r.transport; hello = r.hello; }
        catch (e) { settled = true; reject(e); ws.close(); return; }
        const challenge = fromB64u(hello.challenge);
        if (o.pair) {
          const sig = o.signer.sign(signedBytes(PAIR_PREFIX, t.handshakeHash, challenge));
          sendText(encodeFrame({ t: "pair", secret: o.pair.secret, public_key: b64u(o.signer.publicKey), name: o.pair.name, platform: o.pair.platform, sig: b64u(sig) }));
        } else {
          const sig = o.signer.sign(signedBytes(AUTH_PREFIX, t.handshakeHash, challenge));
          sendText(encodeFrame({ t: "auth", device_id: o.signer.deviceId, sig: b64u(sig) }));
        }
        peer = new Peer(sendText, () => ws.close(1000), serve);
        settled = true;
        resolve({ peer, done });
        return;
      }
      let bytes: Uint8Array | null;
      try { bytes = t.open(data); } catch { ws.close(4400); return; }   // replay, tamper, reorder: not the hub
      if (bytes) peer?.onText(new TextDecoder().decode(bytes));
    });
    ws.addEventListener("close", (ev) => {
      peer?.ended();
      if (!settled) { settled = true; reject(Object.assign(new Error(`relay closed ${ev.code}`), { code: ev.code })); }
      endDone({ code: ev.code, reason: ev.reason });
    });
    ws.addEventListener("error", () => { if (!settled) { settled = true; reject(new Error("relay 连不上")); } });
  });
}
