// The write routes of /api/v1 (W3a; protocol/api/write.ts, 02 「写操作和 client_ops」, §触6.4, §触6.5). Each handler
// is synchronous and runs inside withOp's transaction (ops.ts), except messages, which dedupe on the inbox key.
// authorize() already ran (index.ts): the caller is a client device or the CLI, i.e. me (§触6.7). Approvals still
// check isMe() themselves, and go through the same functions the Feishu buttons use (approvals.ts), so the first
// decision on any end wins and every card shows it.
//
// Errors (02): 400 bad body, 404, 409 = a version conflict or already decided elsewhere, 410 = expired / superseded /
// invalidated; 409 and 410 bring the entity as it is now (Conflict).
import type { z } from "zod";
import {
  DecideReq, DraftReq, MessageReq, RedraftReq, SnoozeReq, ThreadCreateReq, ThreadPatchReq,
  type ApprovalRes, type Conflict, type InputRes, type MessageRes, type RunStopRes, type SnoozeRes, type ThreadRes,
} from "../../../protocol/api/write.ts";
import { DeviceRename, InviteReq, type InviteRes } from "../../../protocol/api/devices.ts";
import type { Req } from "../../../protocol/frames.ts";
import type { Db, Row } from "../db/db.ts";
import { choose, decide, editDraft, requestRedraft, snoozeApproval, type Decider, type Refused } from "../approvals.ts";
import { ingest, withdraw } from "../inbox.ts";
import { redact } from "../tools/redact.ts";
import { ownerTyped } from "../turn.ts";
import { actorOf, renameDevice, resolveDevice, type Actor } from "../link/devices.ts";
import { log } from "../log.ts";
import type { Caller } from "./authz.ts";
import { newThreadId } from "./threads.ts";
import { withOp, opIdOf, type Done, type Out } from "./ops.ts";
import { approvalView, headSeq, inputView, runView, threadView } from "./views.ts";

/** The dispatcher, as the write routes see it (main.ts passes it). */
export interface Runs { activeRun(lane: string): string | undefined; stopLane(lane: string): boolean }
/** The link module's device writes (link/service.ts LinkService). */
export interface DeviceWrites {
  invite(role: "client" | "node", by: Actor): InviteRes;
  remove(id: string, by: Actor): { name: string; role: string; dropped: number; runs: number; channels: number } | undefined;
  /** errors invite() throws that are the caller's to fix (no relay.url yet): 409 */
  refusal?(e: unknown): string | undefined;
}

export interface WriteDeps {
  db: Db; blobs: string;
  runs?: Runs;
  devices?: DeviceWrites;
  /** triage drafts again for a card that asked for a redraft (main.ts → Triage.redraft); missing: no triage running */
  redraftTriage?: (approvalId: number) => void;
}

type H = (req: Req, c: Caller, m: RegExpExecArray) => Out;
type OpH = (req: Req, c: Caller, m: RegExpExecArray) => Done;

const bad = (error: string, status = 400): Out => ({ status, body: { error } });
function parse<T extends z.ZodType>(s: T, v: unknown): z.infer<T> | undefined {
  const r = s.safeParse(v ?? {});
  return r.success ? r.data : undefined;
}
const STATUS: Record<Refused["code"], number> = { not_me: 403, missing: 404, bad: 400, decided: 409, stale: 409, gone: 410 };
const MAIN_LANE = "console:main";

/** The route table entries for index.ts. */
export function writeRoutes(d: WriteDeps): { method: Req["method"]; path: string; fn: H }[] {
  const { db, blobs } = d;
  const by = (c: Caller): Decider => ({ kind: "device", device_id: c.device_id, role: c.role });
  const thread = (id: string) => db.one<Row>("SELECT * FROM threads WHERE id = ?", id);
  const conflict = (status: number, x: Omit<Conflict, "error">, error: string): Out => ({ status, body: { error, ...x } satisfies Conflict });
  const approvalOut = (id: number): Out => {
    const a = db.one<Row>("SELECT * FROM approvals WHERE id = ?", id);
    return a ? { status: 200, body: { approval: approvalView(db, blobs, a) } satisfies ApprovalRes } : bad("no such approval", 404);
  };
  /** a refusal from approvals.ts → its status, with the approval as it is now on 409/410 */
  const refusedOut = (id: number, r: Refused): Out => {
    const status = STATUS[r.code];
    const a = db.one<Row>("SELECT * FROM approvals WHERE id = ?", id);
    if ((status === 409 || status === 410) && a) return conflict(status, { approval: approvalView(db, blobs, a) }, r.error);
    return bad(r.error, status);
  };
  const op = (name: string, fn: OpH): H => (req, c, m) => withOp(db, c, req, name, () => fn(req, c, m));

  return [
    // ── threads (§触6.5) ──
    { method: "POST", path: "/api/v1/threads", fn: op("thread.create", (req, c) => {
      const b = parse(ThreadCreateReq, req.body);
      if (!b) return bad("body: { title?, matter_id?, domain?: work|personal }");
      let kind = "general", domain = b.domain ?? "work", title = b.title ?? null;   // ※ a general thread is work unless I say
      if (b.matter_id != null) {
        const mt = db.one<{ title: string | null; domain: string | null }>("SELECT title, domain FROM matters WHERE id = ?", b.matter_id);
        if (!mt) return bad("no such matter", 404);
        // a personal matter's thread is always personal (§读5.1); work matters may narrow to personal
        kind = "matter"; domain = mt.domain === "personal" ? "personal" : (b.domain ?? "work"); title = title ?? mt.title;
      }
      const now = Date.now(), id = newThreadId(now);
      db.run("INSERT INTO threads(id, lane, kind, domain, title, matter_id, created_by_device, created_at, last_item_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id, `console:t:${id}`, kind, domain, title, b.matter_id ?? null, c.device_id, now, now);
      return { status: 200, body: { thread: threadView(db, thread(id)!) } satisfies ThreadRes };
    }) },

    { method: "PATCH", path: "/api/v1/threads/([^/]{1,80})", fn: op("thread.patch", (req, _c, m) => {
      const b = parse(ThreadPatchReq, req.body);
      if (!b) return bad("body: { title?: string|null, pinned?, status?: open|archived }");
      const t = thread(m[1]!);
      if (!t) return bad("no such thread", 404);
      const sets: string[] = [], args: (string | number | null)[] = [];
      if (b.title !== undefined) { sets.push("title = ?"); args.push(b.title); }
      if (b.pinned !== undefined) { sets.push("pinned = ?"); args.push(b.pinned ? 1 : 0); }
      if (b.status !== undefined) { sets.push("status = ?"); args.push(b.status); }
      if (sets.length) db.run(`UPDATE threads SET ${sets.join(", ")} WHERE id = ?`, ...args, String(t.id));
      return { status: 200, body: { thread: threadView(db, thread(String(t.id))!) } satisfies ThreadRes };
    }) },

    // ── what I type (dedupe: the inbox key, not client_ops) ──
    { method: "POST", path: "/api/v1/threads/([^/]{1,80})/messages", fn: (req, c, m) => {
      const opId = opIdOf(req);
      if (typeof opId !== "string") return opId;
      const b = parse(MessageReq, req.body);
      if (!b) return bad("body: { text } (1–20000 chars)");
      return db.tx((): Out => {
        const t = thread(m[1]!);
        if (!t) return bad("no such thread", 404);
        const source = `device:${c.device_id}`;
        const text = b.text.trim();
        // /stop, /new, /cancel typed into a client thread act like the buttons (dispatch.ts #command)
        const command = /^\/(stop|new|cancel)$/i.test(text);
        const said = command ? text.toLowerCase() : b.text;
        const seen = db.one<Row>("SELECT * FROM inbox WHERE source = ? AND source_msg_id = ?", source, opId);
        if (seen) {
          // a resend is the same message to the same lane; anything else under this id is a client bug, not a retry
          const p = JSON.parse(String(seen.payload_json ?? "{}")) as { text?: unknown };
          if (seen.lane !== t.lane || p.text !== said) return bad("这个 client_op_id 已经用在另一条消息上了", 409);
          return messageOut(seen, false);
        }
        // D9: Feishu threads are mirrors, read-only for now; a task thread's input goes to its session (W4)
        if (t.kind === "feishu") return conflict(409, { thread: threadView(db, t) }, "飞书的 thread 在客户端只读，到飞书里回");
        if (t.kind === "task") return conflict(409, { thread: threadView(db, t) }, "任务 thread 里说话走 POST /api/v1/tasks/:id/steer（W4a）");
        const lane = String(t.lane), now = Date.now();
        if (t.status === "archived") db.run("UPDATE threads SET status = 'open' WHERE id = ?", String(t.id));   // I wrote in it: back in the list
        const r = ingest(db, {
          lane, kind: command ? "command" : "user", source, source_msg_id: opId, device_id: c.device_id, ts: now,
          payload: { text: said, ts: now },
          turn: { channel: "client", surface: "client", lane, device_id: c.device_id },
        });
        if (!command && !r.dup) {
          db.run(`INSERT OR IGNORE INTO messages(id, surface, sender_id, sender_kind, ts, text, domain, lane)
                  VALUES (?, 'console', ?, 'owner', ?, ?, ?, ?)`,
            `console:${c.device_id}:${opId}`, c.device_id, now, redact(b.text), String(t.domain), lane);
        }
        return messageOut(db.one<Row>("SELECT * FROM inbox WHERE id = ?", r.id)!, !r.dup);
      });
    } },

    { method: "DELETE", path: "/api/v1/inputs/(\\d{1,15})", fn: op("input.withdraw", (_req, _c, m) => {
      const r = db.one<Row>("SELECT * FROM inbox WHERE id = ?", Number(m[1]));
      if (!r) return bad("no such input", 404);
      if (!ownerTyped(r)) return conflict(409, { input: inputView(r) }, "这条不是你发的，撤不了");
      if (r.status !== "received") return conflict(409, { input: inputView(r) }, r.status === "processing" ? "已经在处理了；要停就停这一轮" : `这条已经是 ${r.status}`);
      withdraw(db, String(r.source), String(r.source_msg_id));
      if (String(r.source).startsWith("device:")) {
        db.run("DELETE FROM messages WHERE id = ?", `console:${String(r.source).slice(7)}:${String(r.source_msg_id)}`);
      }
      return { status: 200, body: { input: inputView(db.one<Row>("SELECT * FROM inbox WHERE id = ?", Number(r.id))!) } satisfies InputRes };
    }) },

    { method: "POST", path: "/api/v1/runs/([^/]{1,80})/stop", fn: op("run.stop", (_req, _c, m) => {
      const run = db.one<Row>("SELECT * FROM runs WHERE id = ?", m[1]!);
      if (!run) return bad("no such run", 404);
      // the run row turns aborted when it has actually stopped (the stream shows it); not running: nothing to do
      const lane = String(run.lane ?? "");
      const stopped = run.status === "running" && !!d.runs && d.runs.activeRun(lane) === run.id && d.runs.stopLane(lane);
      if (stopped) log("api", "run stopped from a client", { run: run.id });
      return { status: 200, body: { run: runView(run), stopped } satisfies RunStopRes };
    }) },

    // ── approvals (§底3.3, §办3.3) ──
    { method: "POST", path: "/api/v1/approvals/(\\d{1,12})/decide", fn: op("approval.decide", (req, c, m) => {
      const b = parse(DecideReq, req.body);
      if (!b) return bad("body: { action: approve|reject|answer, draft_version, option_id?, text?, note? }");
      const id = Number(m[1]);
      const a = db.one<Row>("SELECT * FROM approvals WHERE id = ?", id);
      if (!a) return bad("no such approval", 404);
      const ch = choose(a, b);
      if ("ok" in ch) return refusedOut(id, ch);
      const res = decide(db, id, { decision: ch.decision, by: by(c), draft_version: b.draft_version, ...(b.note ? { note: b.note } : {}), ...(ch.answer ? { answer: ch.answer } : {}) });
      return res.ok ? approvalOut(id) : refusedOut(id, res);
    }) },

    { method: "PUT", path: "/api/v1/approvals/(\\d{1,12})/draft", fn: op("approval.draft", (req, c, m) => {
      const b = parse(DraftReq, req.body);
      if (!b) return bad("body: { text, draft_version }");
      const id = Number(m[1]);
      const res = editDraft(db, id, { text: b.text, draft_version: b.draft_version, by: by(c) });
      return res.ok ? approvalOut(id) : refusedOut(id, res);
    }) },

    { method: "POST", path: "/api/v1/approvals/(\\d{1,12})/redraft", fn: op("approval.redraft", (req, c, m) => {
      const b = parse(RedraftReq, req.body);
      if (!b) return bad("body: { note, draft_version }");
      const id = Number(m[1]);
      const res = requestRedraft(db, id, { note: b.note, draft_version: b.draft_version, by: by(c), triage: !!d.redraftTriage });
      if (!res.ok) return refusedOut(id, res);
      // once this transaction has committed; a retry of the same op gets the stored answer and doesn't draft twice
      return { ...approvalOut(id), ...(res.via === "triage" ? { after: () => d.redraftTriage?.(id) } : {}) };
    }) },

    { method: "POST", path: "/api/v1/approvals/(\\d{1,12})/snooze", fn: op("approval.snooze", (req, c, m) => {
      const b = parse(SnoozeReq, req.body);
      if (!b) return bad("body: { until: tonight|morning|monday }");
      const id = Number(m[1]);
      const res = snoozeApproval(db, id, { until: b.until, by: by(c) });
      if (!res.ok) return refusedOut(id, res);
      const a = db.one<Row>("SELECT * FROM approvals WHERE id = ?", id)!;
      return { status: 200, body: { approval: approvalView(db, blobs, a), until_ts: res.until_ts } satisfies SnoozeRes };
    }) },

    // ── devices (06; moved here from hub-admin.sock's own route in W3) ──
    { method: "POST", path: "/api/v1/devices/invites", fn: (req, c, m) => withOp(db, c, req, "device.invite", () => {
      const b = parse(InviteReq, req.body);
      if (!b) return bad("role 要是 client 或 node");
      if (!d.devices) return bad("no link here", 404);
      try { return { status: 200, body: d.devices.invite(b.role, actorOf(c.device_id)) }; }
      catch (e) { const why = d.devices.refusal?.(e); if (why) return bad(why, 409); throw e; }
    }, (out) => (out.status === 200
      // the pairing code is a secret: never kept in client_ops; a retry is told to ask again ※
      ? { status: 409, body: { error: "这次的配对码已经发出去了（没收到就重新要一个，旧的 10 分钟后失效）" } } : out)) },

    { method: "PATCH", path: "/api/v1/devices/([^/]{6,64})", fn: op("device.rename", (req, c, m) => {
      const b = parse(DeviceRename, req.body);
      if (!b) return bad("name 要 1–100 个字");
      const found = resolveDevice(db, m[1]!);
      if ("error" in found) return bad(found.error, 404);
      return renameDevice(db, found.id, b.name, actorOf(c.device_id)) ? { status: 200, body: { id: found.id } } : bad("没有这台设备", 404);
    }) },

    { method: "DELETE", path: "/api/v1/devices/([^/]{6,64})", fn: op("device.remove", (_req, c, m) => {
      if (!d.devices) return bad("no link here", 404);
      const found = resolveDevice(db, m[1]!);
      if ("error" in found) return bad(found.error, 404);
      const r = d.devices.remove(found.id, actorOf(c.device_id));
      return r ? { status: 200, body: { id: found.id, ...r } } : bad("没有这台设备", 404);
    }) },
  ];

  /** a message's answer: where it is in the lane's queue (a run going, or inputs ahead of it) */
  function messageOut(r: Row, fresh: boolean): Out {
    const lane = String(r.lane);
    const ahead = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM inbox WHERE lane = ? AND status = 'received' AND kind != 'command' AND id < ?", lane, Number(r.id))!.n;
    const queued = r.status === "received" && (!!d.runs?.activeRun(lane) || ahead > 0);
    if (fresh) log("api", "message from a client", { lane, input: r.id });
    // seq only for the write that made it: a resend that hit the inbox key wrote nothing
    return { status: 200, body: { input: inputView(r), queued, ahead } satisfies MessageRes, ...(fresh ? { seq: headSeq(db) } : {}) };
  }
}

/** console:main is always there for a client to write in (04 §6: personal, my main conversation). */
export function ensureMainThread(db: Db) {
  db.tx(() => {
    if (db.one("SELECT 1 FROM threads WHERE lane = ?", MAIN_LANE)) return;
    db.run("INSERT INTO threads(id, lane, kind, domain, created_at, last_item_at) VALUES (?,?,?,?,?,NULL)", newThreadId(), MAIN_LANE, "general", "personal", Date.now());
  });
}
