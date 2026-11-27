// Hub-side relay envelope (06): type(1) | sid(4, big-endian) | payload. Device sockets carry bare Noise messages.
export const OPEN = 0x01;
export const DATA = 0x02;
export const CLOSE = 0x03;
export const MAX_NOISE = 65535;
export const MAX_ENVELOPE = MAX_NOISE + 5;

export type Envelope = { type: number; sid: number; payload: Uint8Array };

export function encode(type: number, sid: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, sid >>> 0, false);
  out.set(payload, 5);
  return out;
}

export function decode(buf: Uint8Array): Envelope | null {
  if (buf.byteLength < 5 || buf.byteLength > MAX_ENVELOPE) return null;
  const type = buf[0];
  if (type !== OPEN && type !== DATA && type !== CLOSE) return null;
  const sid = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
  return { type, sid, payload: buf.subarray(5) };
}

export const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
export function parseJson(b: Uint8Array): any {
  try {
    return JSON.parse(new TextDecoder().decode(b));
  } catch {
    return null;
  }
}

/** IPv4 keeps /24, IPv6 keeps /48 (06). */
export function maskIp(ip: string): string {
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split(".").slice(0, 3).join(".") + ".0/24";
  const parts = ip.split("::")[0].split(":").slice(0, 3);
  return parts.join(":") + "::/48";
}
