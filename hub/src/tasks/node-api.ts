// /node/v1, node → hub (02 「/node/v1」, 05). api/index.ts calls this only after authorize() said the caller is a
// `node` (a client gets 403 for all of /node/v1, a node 403 for all of /api/v1: link/roles.ts). The caller's device id
// is the identity; every route below checks the task is on that very node (engine.ts).
// Routes the hub sends *down* (sessions, turns, permissions/:id, git/checks, worktrees/cleanup, exec, fs) are not
// served here: a node asking the hub for them gets 404, so a node can't make the hub act on another node.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Req } from "../../../protocol/frames.ts";
import { BlobPut, type BlobPutRes as BlobPutResS } from "../../../protocol/node/v1.ts";
import type { z } from "zod";
type BlobPutRes = z.infer<typeof BlobPutResS>;
import type { DispatchCaller, Out } from "../api/index.ts";
import { consoleConf } from "../config/load.ts";
import type { NodeRegistry } from "./nodes.ts";
import type { TaskEngine } from "./engine.ts";

/** One upload's ceiling ※: a finished diff or a long output, not a disk filler. */
export const BLOB_PUT_MAX = 64 * 1024 * 1024;

export interface NodeApiDeps { blobs: string; nodes: NodeRegistry; engine: TaskEngine }

const bad = (error: string, status = 400): Out => ({ status, body: { error } });

export function nodeRoutes(d: NodeApiDeps) {
  return async (req: Req, caller: DispatchCaller): Promise<Out> => {
    if (caller.role !== "node") return bad("not a node", 403);   // authorize() already said so; a second lock
    const device = caller.device_id;
    const [path] = req.path.split("?", 1) as [string];
    const post = req.method === "POST";
    if (post && path === "/node/v1/hello") return d.nodes.hello(device, req.body, caller.peer);
    if (post && path === "/node/v1/status") return d.nodes.status(device, req.body);
    const ev = /^\/node\/v1\/tasks\/(t\d{1,15})\/events$/.exec(path);
    if (post && ev) return d.engine.events(device, ev[1]!, req.body);
    if (post && path === "/node/v1/permissions") return d.engine.permission(device, req.body);
    if (post && path === "/node/v1/tool-calls") return d.engine.toolCall(device, req.body, consoleConf().mcp_open === true);
    if (post && path === "/node/v1/blobs") return blobPut(d.blobs, device, req.body);
    return bad(`no route ${req.method} ${path}`, 404);
  };
}

/**
 * POST /node/v1/blobs (02 大载荷): pieces in order into a temp file of this node's; the piece that reaches `total`
 * is checked against the sha and only then becomes blobs/<sha>. A wrong offset gets the offset the hub wants.
 */
export function blobPut(dir: string, device: string, body: unknown): Out {
  const b = BlobPut.safeParse(body);
  if (!b.success) return bad("bad blob piece");
  const { sha, offset, data_b64, total } = b.data;
  if (total > BLOB_PUT_MAX) return bad(`blob 太大（上限 ${BLOB_PUT_MAX} 字节）`, 413);
  const final = join(dir, sha);
  if (existsSync(final)) return { status: 200, body: { done: true, next_offset: total } satisfies BlobPutRes };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // the device id is part of the name, so two nodes uploading the same sha don't write into one file
  const tmp = join(dir, `.tmp-up-${createHash("sha256").update(device).digest("hex").slice(0, 12)}-${sha}`);
  const have = existsSync(tmp) ? statSync(tmp).size : 0;
  if (offset !== have) return { status: 200, body: { done: false, next_offset: have } satisfies BlobPutRes };
  const data = Buffer.from(data_b64, "base64");
  if (have + data.length > total) { if (existsSync(tmp)) unlinkSync(tmp); return bad("比 total 长"); }
  appendFileSync(tmp, data, { mode: 0o600 });
  const size = have + data.length;
  if (size < total) return { status: 200, body: { done: false, next_offset: size } satisfies BlobPutRes };
  const got = createHash("sha256").update(readFileSync(tmp)).digest("hex");
  if (got !== sha) { unlinkSync(tmp); return bad("sha 对不上，重传", 422); }
  renameSync(tmp, final);
  return { status: 200, body: { done: true, next_offset: total } satisfies BlobPutRes };
}
