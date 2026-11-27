// Application frames inside the channel (docs/tech/02 「应用帧」). UTF-8 JSON, the same in all three places:
// client ↔ hub, node ↔ hub, local node / CLI ↔ hub. Unknown fields and unknown `t` are ignored, never an error:
// that is what lets v1 only grow.
import { z } from "zod";

const json = z.unknown();
const seq = z.number().int().nonnegative();

export const Req = z.object({
  t: z.literal("req"), id: z.number().int().nonnegative(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().regex(/^\/(api|node)\/v1(\/|$)/),
  query: z.record(z.string(), z.string()).optional(),
  body: json.optional(),
  client_op_id: z.string().min(1).max(128).optional(),
});
export const Res = z.object({ t: z.literal("res"), id: z.number().int().nonnegative(), status: z.number().int(), body: json.optional(), seq: seq.optional() });
export const Cancel = z.object({ t: z.literal("cancel"), id: z.number().int().nonnegative() });
export const Ev = z.object({
  t: z.literal("ev"), seq, ts: z.number().int(), entity: z.string(), id: z.string(),
  op: z.enum(["upsert", "delete"]), data: json.optional(),
});
export const Delta = z.object({ t: z.literal("delta"), run: z.string(), item: z.string(), chunk_seq: seq, text: z.string() });
export const Snap = z.object({ t: z.literal("snapshot"), run: z.string(), item: z.string(), text: z.string(), tool: z.string().optional() });
export const Beat = z.object({ t: z.literal("beat"), seq, status: json.optional() });
export const Reset = z.object({ t: z.literal("reset") });
// 06: device_id = hex(sha256(Ed25519 public key)); signatures are base64url
const b64u = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const Auth = z.object({ t: z.literal("auth"), device_id: z.string().regex(/^[0-9a-f]{64}$/), sig: b64u });
export const Pair = z.object({
  t: z.literal("pair"), secret: z.string().min(1), public_key: b64u, name: z.string().max(100), platform: z.string().max(40), sig: b64u,
});

export const Frame = z.discriminatedUnion("t", [Req, Res, Cancel, Ev, Delta, Snap, Beat, Reset, Auth, Pair]);
export type Frame = z.infer<typeof Frame>;
export type Req = z.infer<typeof Req>;
export type Res = z.infer<typeof Res>;
export type Ev = z.infer<typeof Ev>;
export type Delta = z.infer<typeof Delta>;
export type Snap = z.infer<typeof Snap>;
export type Auth = z.infer<typeof Auth>;
export type Pair = z.infer<typeof Pair>;

const KNOWN: ReadonlySet<string> = new Set(Frame.options.map((o) => o.shape.t.value));

/** Parse one frame. Unknown `t` → null (ignore it). A known `t` with a bad shape → throws (protocol error). */
export function parseFrame(text: string): Frame | null {
  const v: unknown = JSON.parse(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("frame is not an object");
  const t = (v as { t?: unknown }).t;
  if (typeof t !== "string" || !KNOWN.has(t)) return null;
  return Frame.parse(v);
}

export const encodeFrame = (f: Frame): string => JSON.stringify(f);

// ── Fragmenting (02 「Noise」): one Noise message ≤ 65535 bytes incl. the 16-byte tag; each piece starts with a flag
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
