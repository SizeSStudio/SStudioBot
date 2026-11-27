// The only part of the wire the relay understands (docs/tech/06 「信封」). The relay imports nothing else from
// protocol/, so this file imports nothing at all.
//   device / node WS: each binary message is one Noise message, forwarded as is, no header.
//   hub WS:           type(1) | sid(4, big endian) | payload
export const OPEN = 0x01;  // relay → hub, new session; payload JSON { ip_masked, ts }
export const DATA = 0x02;  // both ways; payload is a Noise message
export const CLOSE = 0x03; // both ways; payload JSON { code, reason }; hub sends reason "auth" for a failed auth
export type EnvType = typeof OPEN | typeof DATA | typeof CLOSE;

export const HEADER = 5;
export const NOISE_MAX = 65535;
export const ENVELOPE_MAX = NOISE_MAX + HEADER; // a bigger message makes the relay drop the connection

// close codes the relay uses towards a peer
export const CLOSE_HUB_OFFLINE = 4404;

export type Envelope = { type: EnvType; sid: number; payload: Uint8Array };

export function encodeEnvelope(type: EnvType, sid: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(sid) || sid < 0 || sid > 0xffffffff) throw new Error("bad sid");
  if (payload.length > NOISE_MAX) throw new Error("payload too large");
  const out = new Uint8Array(HEADER + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, sid, false);
  out.set(payload, HEADER);
  return out;
}

/** null = not a valid envelope (unknown type, short, too long): the receiver closes the connection. */
export function decodeEnvelope(msg: Uint8Array): Envelope | null {
  if (msg.length < HEADER || msg.length > ENVELOPE_MAX) return null;
  const type = msg[0];
  if (type !== OPEN && type !== DATA && type !== CLOSE) return null;
  const sid = new DataView(msg.buffer, msg.byteOffset, msg.byteLength).getUint32(1, false);
  return { type, sid, payload: msg.subarray(HEADER) };
}

const enc = new TextEncoder(), dec = new TextDecoder();
export const jsonPayload = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));
export const readJsonPayload = (p: Uint8Array): unknown => JSON.parse(dec.decode(p));

/** IPv4 keeps /24, IPv6 keeps /48 (06): enough for device_audit and "new IP range", not a full address. */
export function maskIp(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/i.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (ip.includes(":")) {
    const [head = "", tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
    const full = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
    return `${full.slice(0, 3).map((x) => x || "0").join(":")}::/48`;
  }
  return "unknown";
}
