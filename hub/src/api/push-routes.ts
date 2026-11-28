// The push side of /api/v1 (W3b; protocol/api/push.ts, 02 写操作 table): presence (no client_ops, memory only), reads,
// this device's FCM token, 省心. The caller is already a client device or the CLI, i.e. me (authz.ts).
// The FCM token is a credential of the phone: stored, never sent back out, never logged.
import type { z } from "zod";
import { EaseReq, PresenceReq, PushTokenReq, ReadReq, Ref, type EaseRes, type PresenceRes, type PushTokenRes, type ReadRes } from "../../../protocol/api/push.ts";
import type { Req } from "../../../protocol/frames.ts";
import type { Db } from "../db/db.ts";
import { markRead, setEase, type Push } from "../push/queue.ts";
import type { Caller } from "./authz.ts";
import { withOp, type Out } from "./ops.ts";
import { readView } from "./views.ts";

type H = (req: Req, c: Caller, m: RegExpExecArray) => Out;
const bad = (error: string, status = 400): Out => ({ status, body: { error } });
function parse<T extends z.ZodType>(s: T, v: unknown): z.infer<T> | undefined {
  const r = s.safeParse(v ?? {});
  return r.success ? r.data : undefined;
}
const via = (c: Caller) => (c.device_id === "cli" ? "cli" : `device:${c.device_id}`);

export function pushRoutes(db: Db, push: Push): { method: Req["method"]; path: string; fn: H }[] {
  return [
    { method: "POST", path: "/api/v1/presence", fn: (req, c) => {
      const b = parse(PresenceReq, req.body);
      if (!b) return bad("body: { foreground, viewing?: <entity>:<id> | null }");
      push.presence.report(c.device_id, b);
      push.kick();   // walking away (foreground:false) lets what is counted go out now
      return { status: 200, body: { present: push.presence.present() } satisfies PresenceRes };
    } },

    { method: "POST", path: "/api/v1/reads", fn: (req, c) => withOp(db, c, req, "read", () => {
      const b = parse(ReadReq, req.body);
      const ref = b ? `${b.entity}:${b.id}` : "";
      if (!b || !Ref.safeParse(ref).success) return bad("body: { entity, id, upto_ts? }");
      const row = markRead(db, { ref, upto_ts: b.upto_ts ?? null, via: via(c) });
      return { status: 200, body: { read: readView(row) } satisfies ReadRes };
    }) },

    { method: "PUT", path: "/api/v1/devices/self/push-token", fn: (req, c) => withOp(db, c, req, "device.push_token", () => {
      const b = parse(PushTokenReq, req.body);
      if (!b) return bad("body: { token: string | null }");
      const d = db.one<{ push_token: string | null }>("SELECT push_token FROM devices WHERE id = ? AND role = 'client' AND removed_at IS NULL", c.device_id);
      if (!d) return bad("这台不是配对过的客户端设备", 404);
      if ((d.push_token ?? null) !== b.token) {
        db.run("UPDATE devices SET push_token = ? WHERE id = ?", b.token, c.device_id);
        db.run("INSERT INTO device_audit(ts, device_id, action, actor) VALUES (?, ?, ?, ?)", Date.now(), c.device_id, b.token ? "token_set" : "token_cleared", via(c));
        db.emit("device", c.device_id);
      }
      return { status: 200, body: { has_token: !!b.token, fcm_enabled: push.fcmEnabled() } satisfies PushTokenRes };
    }) },

    { method: "PUT", path: "/api/v1/ease", fn: (req, c) => withOp(db, c, req, "ease", () => {
      const b = parse(EaseReq, req.body);
      if (!b) return bad("body: { on }");
      return { status: 200, body: { ease: setEase(db, b.on, { actor: via(c), source: "console" }) } satisfies EaseRes };
    }) },
  ];
}
