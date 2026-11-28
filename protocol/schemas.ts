// Everything on the wire that must only grow, in one place for scripts/protocol-check.ts (docs/tech/01 CI, IZ-10).
// Add a schema / route / entity here when you add it to the protocol; never remove one.
import type { z } from "zod";
import * as F from "./frames.ts";
import * as api from "./api/meta.ts";
import * as form from "./api/config-form.ts";
import * as status from "./api/status.ts";
import * as node from "./node/hello.ts";
import * as ent from "./api/entities.ts";
import * as stream from "./api/stream.ts";
import * as read from "./api/read.ts";
import * as devices from "./api/devices.ts";
import * as pair from "./pair.ts";
import * as write from "./api/write.ts";
import * as push from "./api/push.ts";

export const SCHEMAS: Record<string, z.ZodType> = {
  "frame.req": F.Req, "frame.res": F.Res, "frame.cancel": F.Cancel, "frame.ev": F.Ev, "frame.delta": F.Delta,
  "frame.snapshot": F.Snap, "frame.beat": F.Beat, "frame.reset": F.Reset, "frame.auth": F.Auth, "frame.pair": F.Pair,
  "api.meta.res": api.MetaRes, "api.status.res": status.StatusRes,
  "api.config.form_spec": form.FormSpec, "api.config.form": form.FormPayload, "api.config.form_preview": form.FormPreview,
  "api.error": read.ErrorRes,
  "api.bootstrap.req": stream.BootstrapReq, "api.bootstrap.res": stream.BootstrapRes,
  "api.stream.req": stream.StreamReq, "api.stream.res": stream.StreamRes,
  "api.stream.item.req": stream.StreamItemReq, "api.stream.item.res": stream.StreamItemRes,
  "api.threads.query": read.ThreadsQuery, "api.threads.res": read.ThreadsRes,
  "api.thread_items.query": read.ThreadItemsQuery, "api.thread_items.res": read.ThreadItemsRes,
  "api.approvals.query": read.ApprovalsQuery, "api.approvals.res": read.ApprovalsRes,
  "api.devices.query": read.DevicesQuery, "api.devices.res": read.DevicesRes,
  "api.blobs.query": read.BlobQuery, "api.blobs.res": read.BlobRes,
  ...Object.fromEntries(Object.entries(ent.ENTITY_DATA).map(([k, s]) => [`entity.${k}`, s])),
  "node.hello": node.Hello, "node.hello.res": node.HelloRes,
  "node.exec": node.Exec, "node.exec.res": node.ExecRes,
  "node.fs.read": node.FsRead, "node.fs.read.res": node.FsReadRes, "node.fs.write": node.FsWrite,
  "api.devices.rename": devices.DeviceRename,
  "api.devices.invite": devices.InviteReq, "api.devices.invite.res": devices.InviteRes, "pair.code": pair.PairCode,
  // W3: writes
  "api.client_op_id": write.CLIENT_OP_ID, "api.conflict": write.Conflict,
  "api.threads.create": write.ThreadCreateReq, "api.threads.patch": write.ThreadPatchReq, "api.thread.res": write.ThreadRes,
  "api.messages.req": write.MessageReq, "api.messages.res": write.MessageRes, "api.input.res": write.InputRes,
  "api.runs.stop": write.RunStopReq, "api.runs.stop.res": write.RunStopRes,
  "api.approvals.decide": write.DecideReq, "api.approval.res": write.ApprovalRes, "api.approvals.draft": write.DraftReq,
  "api.approvals.redraft": write.RedraftReq, "api.approvals.snooze": write.SnoozeReq, "api.approvals.snooze.res": write.SnoozeRes,
  "api.presence.req": push.PresenceReq, "api.presence.res": push.PresenceRes,
  "api.reads.req": push.ReadReq, "api.reads.res": push.ReadRes,
  "api.push_token.req": push.PushTokenReq, "api.push_token.res": push.PushTokenRes,
  "api.ease.req": push.EaseReq, "api.ease.res": push.EaseRes, "push.data": push.PushData,
};

/** Routes implemented so far ("METHOD path"). 02's table is the plan; this is what exists. */
export const ROUTES: readonly string[] = [
  "GET /api/v1/meta", "GET /api/v1/status",
  // W2b: read-only
  "POST /api/v1/bootstrap", "POST /api/v1/stream", "POST /api/v1/stream/expand", "POST /api/v1/stream/collapse",
  "GET /api/v1/threads", "GET /api/v1/threads/:id/items", "GET /api/v1/approvals", "GET /api/v1/devices",
  "GET /api/v1/blobs/:sha",
  // W2a: device writes (hub-admin.sock until W3 client_ops)
  "PATCH /api/v1/devices/:id", "DELETE /api/v1/devices/:id", "POST /api/v1/devices/invites",
  "POST /node/v1/hello",
  "POST /node/v1/exec", "POST /node/v1/fs/read", "POST /node/v1/fs/write",
];

/** Entity names carried by `ev` frames. */
export const ENTITIES: readonly string[] = [...ent.ENTITY_NAMES];
