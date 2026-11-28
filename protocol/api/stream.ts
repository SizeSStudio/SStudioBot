// Bootstrap and the event stream (docs/tech/02 「应用帧」, DESIGN §触6.4).
//
//   POST /api/v1/bootstrap               → BootstrapRes: a snapshot and the seq it is at (one consistent read)
//   POST /api/v1/stream { after }        → StreamRes, then `ev` (seq > after, oldest first), then a `snapshot` of
//                                          every assistant message being written, then live `ev`/`delta`/`beat`
//   POST /api/v1/stream/expand { item }  → StreamItemRes; that tool item's `delta`/`snapshot` now reach this connection
//   POST /api/v1/stream/collapse { item } → StreamItemRes; they stop
//
// - `after` older than change_log keeps (7 days), or newer than the hub has: StreamRes.reset = true, a `reset` frame
//   follows and nothing else; bootstrap again, then stream again (same connection is fine: a new stream replaces it).
// - An `ev` is "this entity now looks like `data`" (ENTITY_DATA in entities.ts); replaying one is harmless. Several
//   changes to one entity between two reads arrive as one `ev` with the last seq. Keep the newest seq per (entity, id)
//   and drop an `ev` that isn't newer. Filtered-out events advance `beat.seq` all the same: `beat.seq` is the `after`
//   to resume from.
// - `delta.item` / `snapshot.item`: an assistant message being written is `<run_id>:a<n>` (n counts that run's
//   messages from 0); it has no run_items row yet. When an `item` ev arrives whose `live_key` is that key (the
//   finished message), or the run's `run` ev is no longer running, drop that streaming text. A tool call is its
//   run_items id (= its `item` ev's id and `live_key`); only expanded tool items stream.
// - `delta.chunk_seq` counts from 1 per item; take a delta only when it is the last one you have + 1 (a `snapshot`
//   sets that count to its `chunk_seq`); otherwise wait for the next snapshot.
import { z } from "zod";
import { Approval, Device, Run, Task, Thread, TimelineEntry } from "./entities.ts";
import { Ease, Read } from "./push.ts";

const seq = z.number().int().nonnegative();

/** Each thread's newest timeline lines in a snapshot or a page; `next_before` pages further back (null = no more). */
export const Timeline = z.object({ entries: z.array(TimelineEntry), next_before: z.string().nullable() });
export type Timeline = z.infer<typeof Timeline>;

export const BootstrapReq = z.object({});
/** Everything a client shows before it has asked anything, at `seq`. Then stream with { after: seq }. */
export const BootstrapRes = z.object({
  seq,
  /** open threads (archived ones: GET /api/v1/threads?status=archived) */
  threads: z.array(Thread),
  /** thread id → its newest lines (oldest first), so switching threads needs no request */
  timelines: z.record(z.string(), Timeline),
  /** running runs */
  runs: z.array(Run),
  /** pending approvals */
  approvals: z.array(Approval),
  /** tasks not finished */
  tasks: z.array(Task),
  /** devices not removed */
  devices: z.array(Device),
  /** W3: 省心 now */
  ease: Ease.optional(),
  /** W3: read marks of what this snapshot shows (threads, pending approvals) */
  reads: z.array(Read).optional(),
});
export type BootstrapRes = z.infer<typeof BootstrapRes>;

export const StreamReq = z.object({ after: seq });
export type StreamReq = z.infer<typeof StreamReq>;
export const StreamRes = z.object({
  /** the hub's newest seq when the stream started */
  seq,
  /** true = `after` can't be served: bootstrap again */
  reset: z.boolean().optional(),
});
export type StreamRes = z.infer<typeof StreamRes>;

export const StreamItemReq = z.object({ item: z.string().min(1).max(200) });
export type StreamItemReq = z.infer<typeof StreamItemReq>;
export const StreamItemRes = z.object({
  /** expand: the item is streaming now (a `snapshot` follows); collapse: always false */
  live: z.boolean(),
});
export type StreamItemRes = z.infer<typeof StreamItemRes>;
