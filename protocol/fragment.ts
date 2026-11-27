// Splitting one application frame into Noise-sized pieces and back (docs/tech/02 「Noise」). No imports, so the
// Noise channel and the clients can use it without pulling in zod.
// one Noise message ≤ 65535 bytes incl. the 16-byte tag; each piece starts with a flag
// byte (0x00 more follow, 0x01 last). A reassembled frame is at most 1 MiB; bigger payloads go through blob pulls.
export const NOISE_MAX = 65535;
export const PIECE_MAX = NOISE_MAX - 16 - 1;
export const FRAME_MAX = 1024 * 1024;
const MORE = 0x00, LAST = 0x01;

export function fragment(frame: Uint8Array): Uint8Array[] {
  if (frame.length > FRAME_MAX) throw new Error(`frame too large: ${frame.length} > ${FRAME_MAX}`);
  const out: Uint8Array[] = [];
  for (let off = 0; off < frame.length || out.length === 0; off += PIECE_MAX) {
    const chunk = frame.subarray(off, Math.min(off + PIECE_MAX, frame.length));
    const piece = new Uint8Array(chunk.length + 1);
    piece[0] = off + PIECE_MAX >= frame.length ? LAST : MORE;
    piece.set(chunk, 1);
    out.push(piece);
  }
  return out;
}

/** Feed decrypted pieces in order; returns a whole frame when the last piece arrives. Throws on a bad flag or > 1 MiB. */
export class Reassembler {
  #parts: Uint8Array[] = [];
  #size = 0;
  push(piece: Uint8Array): Uint8Array | null {
    if (piece.length < 1) throw new Error("empty piece");
    const flag = piece[0];
    if (flag !== MORE && flag !== LAST) throw new Error(`bad piece flag ${flag}`);
    if (piece.length - 1 > PIECE_MAX) throw new Error("piece too large");
    this.#size += piece.length - 1;
    if (this.#size > FRAME_MAX) throw new Error("frame too large");
    this.#parts.push(piece.subarray(1));
    if (flag === MORE) return null;
    const whole = new Uint8Array(this.#size);
    let off = 0;
    for (const p of this.#parts) { whole.set(p, off); off += p.length; }
    this.#parts = []; this.#size = 0;
    return whole;
  }
}
