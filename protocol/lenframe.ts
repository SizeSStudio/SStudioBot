// Local sockets (hub-admin.sock for the CLI, hub.sock for the local node; docs/tech/02 本机): a u32 big-endian length,
// then one application frame as UTF-8 JSON. No Noise, no envelope: file permissions are the authentication (03 link).
// Shared here because the hub and node/ may not import each other.
import { Buffer } from "node:buffer";
import { FRAME_MAX } from "./fragment.ts";

export { FRAME_MAX };

export function encodeLen(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  if (body.length > FRAME_MAX) throw new Error(`frame too large (${body.length} bytes)`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames' texts. Throws on an oversize length (the caller then drops the connection). */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): string[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: string[] = [];
    while (this.#buf.length >= 4) {
      const n = this.#buf.readUInt32BE(0);
      if (n > FRAME_MAX) throw new Error(`frame too large (${n} bytes)`);
      if (this.#buf.length < 4 + n) break;
      out.push(this.#buf.subarray(4, 4 + n).toString("utf8"));
      this.#buf = this.#buf.subarray(4 + n);
    }
    return out;
  }
}
