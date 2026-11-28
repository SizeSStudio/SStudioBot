// The read-only /api/v1 routes of W2 (docs/tech/02 「/api/v1 路由」). Query values are strings (frames.ts Req.query).
// Every list carries `seq`: the change_log position it was read at, so a client can keep the newest of a GET and the
// stream (same rule as `ev`: keep the higher seq).
import { z } from "zod";
import { Approval, Device, Thread, TimelineEntry } from "./entities.ts";

const seq = z.number().int().nonnegative();
const uint = z.string().regex(/^\d{1,15}$/);

/** Any non-2xx body. */
export const ErrorRes = z.object({ error: z.string() });
export type ErrorRes = z.infer<typeof ErrorRes>;

/** GET /api/v1/threads?status= (open | archived | all; default all) */
export const ThreadsQuery = z.object({ status: z.string().optional() });
export const ThreadsRes = z.object({ seq, threads: z.array(Thread) });
export type ThreadsRes = z.infer<typeof ThreadsRes>;

/**
 * GET /api/v1/threads/:id/items?before=&limit= : older timeline lines of one thread, oldest first. `before` is the
 * `next_before` of the previous page or of the bootstrap timeline (opaque); none = the newest. limit default 50, max 200.
 */
export const ThreadItemsQuery = z.object({ before: z.string().max(100).optional(), limit: uint.optional() });
export const ThreadItemsRes = z.object({
  seq,
  thread: Thread,
  entries: z.array(TimelineEntry),
  next_before: z.string().nullable(),
});
export type ThreadItemsRes = z.infer<typeof ThreadItemsRes>;

/** GET /api/v1/approvals?status= (one status, or all; default pending). Newest first, at most 200. */
export const ApprovalsQuery = z.object({ status: z.string().optional() });
export const ApprovalsRes = z.object({ seq, approvals: z.array(Approval) });
export type ApprovalsRes = z.infer<typeof ApprovalsRes>;

/** GET /api/v1/devices?all=1 (removed ones too) */
export const DevicesQuery = z.object({ all: z.string().optional() });
export const DevicesRes = z.object({ seq, devices: z.array(Device) });
export type DevicesRes = z.infer<typeof DevicesRes>;

/** At most this many bytes per blob call (02 「大载荷」): base64 of it fits a 1 MiB frame. */
export const BLOB_CHUNK = 512 * 1024;
/** GET /api/v1/blobs/:sha?offset=&len= (len default and max BLOB_CHUNK). Pull in order; `cancel` to stop. */
export const BlobQuery = z.object({ offset: uint.optional(), len: uint.optional() });
export const BlobRes = z.object({
  data_b64: z.string(),
  /** the blob's whole size in bytes */
  total: z.number().int().nonnegative(),
  /** where the next call starts; null = that was the end */
  next_offset: z.number().int().nonnegative().nullable(),
});
export type BlobRes = z.infer<typeof BlobRes>;
