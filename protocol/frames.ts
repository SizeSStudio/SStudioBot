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
// chunk_seq (W2b): how many chunks `text` already holds, so the next delta to take is chunk_seq + 1
export const Snap = z.object({ t: z.literal("snapshot"), run: z.string(), item: z.string(), text: z.string(), tool: z.string().optional(), chunk_seq: seq.optional() });
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

// Fragmenting lives in fragment.ts (no deps, so protocol/noise/ stays free of zod); re-exported for callers.
export { NOISE_MAX, PIECE_MAX, FRAME_MAX, fragment, Reassembler } from "./fragment.ts";
