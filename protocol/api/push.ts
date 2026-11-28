// Presence, reads, the FCM token, 省心 and what a push looks like on the phone (W3; DESIGN §触1.1, §寸6, §触6.3;
// docs/tech/03 「push」, 07 「安卓」). Write kinds are in write.ts WRITES.
import { z } from "zod";

const ms = z.number().int();
/** `<entity>:<id>`, the shape push_queue.ref and reads.ref use (thread:th_…, approval:12, task:t42) */
export const Ref = z.string().regex(/^[a-z_]{1,32}:[^\s]{1,120}$/);

/**
 * POST /api/v1/presence — at most every 30 s while the app is in front and I touch, type or scroll; at once with
 * foreground:false when it goes to the background. `viewing`: the ref of the thread or card on screen. Any one client
 * in front with input in the last push.presence.away_seconds = I am here: what I'm viewing isn't pushed, the rest is
 * only counted ("等你 N"), and when I walk away what is still open gets pushed then. No client_ops, no seq; kept in
 * memory only.
 */
export const PresenceReq = z.object({ foreground: z.boolean(), viewing: Ref.nullable().optional() });
export type PresenceReq = z.infer<typeof PresenceReq>;
export const PresenceRes = z.object({ present: z.boolean() });
export type PresenceRes = z.infer<typeof PresenceRes>;

/** reads (04 §2): read on any end counts, per person not per device. `upto_ts`: a thread is read up to this line. */
export const Read = z.object({
  ref: Ref,
  upto_ts: ms.nullable(),
  read_at: ms,
  /** device:<id> | feishu | … */
  via: z.string(),
});
export type Read = z.infer<typeof Read>;

/**
 * POST /api/v1/reads — I looked at this. A thread: `upto_ts` = the ts of the last line seen (never moves back). The
 * pushes for it close (done) and the "N 条" in later pushes count without it.
 */
export const ReadReq = z.object({
  entity: z.string().regex(/^[a-z_]{1,32}$/),
  id: z.string().min(1).max(120),
  upto_ts: ms.optional(),
});
export type ReadReq = z.infer<typeof ReadReq>;
export const ReadRes = z.object({ read: Read });
export type ReadRes = z.infer<typeof ReadRes>;

/**
 * PUT /api/v1/devices/self/push-token — this device's FCM token; null clears it (I turned phone notifications off:
 * pushes go to the channels). Send again when the token changes. The token never comes back out of the hub.
 * `fcm_enabled` false: the hub has FCM off (console.yaml fcm.enabled), so pushes go to the channels for now.
 */
export const PushTokenReq = z.object({ token: z.string().min(1).max(4096).nullable() });
export type PushTokenReq = z.infer<typeof PushTokenReq>;
export const PushTokenRes = z.object({ has_token: z.boolean(), fcm_enabled: z.boolean() });
export type PushTokenRes = z.infer<typeof PushTokenRes>;

/**
 * 省心 (§寸6): only narrows pushes; seeing, gates, approvals, budgets and limits don't change. Only I switch it: here
 * (a client button) or a DM turn I typed myself; it never switches itself.
 */
export const Ease = z.object({
  on: z.boolean(),
  /** when it was switched on; null when off */
  since: ms.nullable(),
  /** 第 N 天 (1 on the day it was switched on); null when off */
  day: z.number().int().positive().nullable(),
});
export type Ease = z.infer<typeof Ease>;
/** PUT /api/v1/ease */
export const EaseReq = z.object({ on: z.boolean() });
export type EaseReq = z.infer<typeof EaseReq>;
export const EaseRes = z.object({ ease: Ease });
export type EaseRes = z.infer<typeof EaseRes>;

/** The four Android notification channels (07). */
export const PushChannel = z.enum(["wait", "approval", "task", "fyi"]);
export type PushChannel = z.infer<typeof PushChannel>;

/**
 * The FCM message's `data` (all strings, FCM's rule). The notification's title and body are beside it; for `personal`
 * they say only 「有一条私人的」 and `ref` is the only pointer. Tapping opens sstudiobot://item/<ref>; what is shown
 * and decided there is the hub's state, never this payload.
 */
export const PushData = z.object({
  ref: Ref,
  /** push_queue.cat */
  cat: z.string(),
  channel: PushChannel,
  /** "1" = personal */
  personal: z.enum(["0", "1"]),
  /** push_queue.id, so a later push can replace this notification */
  push_id: z.string().regex(/^\d{1,15}$/),
});
export type PushData = z.infer<typeof PushData>;
