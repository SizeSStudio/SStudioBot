// Everything on the wire that must only grow, in one place for scripts/protocol-check.ts (docs/tech/01 CI, IZ-10).
// Add a schema / route / entity here when you add it to the protocol; never remove one.
import type { z } from "zod";
import * as F from "./frames.ts";
import * as api from "./api/meta.ts";
import * as node from "./node/hello.ts";

export const SCHEMAS: Record<string, z.ZodType> = {
  "frame.req": F.Req, "frame.res": F.Res, "frame.cancel": F.Cancel, "frame.ev": F.Ev, "frame.delta": F.Delta,
  "frame.snapshot": F.Snap, "frame.beat": F.Beat, "frame.reset": F.Reset, "frame.auth": F.Auth, "frame.pair": F.Pair,
  "api.meta.res": api.MetaRes,
  "node.hello": node.Hello, "node.hello.res": node.HelloRes,
  "node.exec": node.Exec, "node.exec.res": node.ExecRes,
  "node.fs.read": node.FsRead, "node.fs.read.res": node.FsReadRes, "node.fs.write": node.FsWrite,
};

/** Routes implemented so far ("METHOD path"). 02's table is the plan; this is what exists. */
export const ROUTES: readonly string[] = [
  "GET /api/v1/meta",
  "POST /node/v1/hello",
  "POST /node/v1/exec", "POST /node/v1/fs/read", "POST /node/v1/fs/write",
];

/** Entity names carried by `ev` frames. */
export const ENTITIES: readonly string[] = [];
