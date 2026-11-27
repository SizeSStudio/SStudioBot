// The hub process (03 「启动顺序」). W1c brings the base only: config → db → config repo seed + default jobs →
// agent-home seed → hub-admin.sock (status). inbox, channels, outbox, push, timers and api.pump join in W1d/W1e/W2;
// each takes its place in boot() in the order 03 gives.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:net";
import { PROTOCOL } from "../../protocol/version.ts";
import { StatusRes } from "../../protocol/api/status.ts";
import type { Req } from "../../protocol/frames.ts";
import { openDb, type Db } from "./db/db.ts";
import { home as homeOf, type Home } from "./home.ts";
import { log } from "./log.ts";
import * as notify from "./notify.ts";
import { loadAll, useConfigDir } from "./config/load.ts";
import { ensureAgentHome, ensureConfigRepo, seedNotice } from "./config/seed.ts";
import { addDefaultJobs } from "./config/default-jobs.ts";
import { startAdminSocket, type Handler } from "./admin-socket.ts";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The running commit: REVISION (line 1 = sha) that deploy writes into a release; a dev checkout says "dev". */
export function revision(appDir = APP): { sha: string; subject: string } {
  const f = join(appDir, "REVISION");
  if (!existsSync(f)) return { sha: "dev", subject: "" };
  const [sha = "dev", , ...rest] = readFileSync(f, "utf8").trim().split("\n");
  return { sha, subject: rest.join(" ") };
}
export const VERSION = (JSON.parse(readFileSync(join(APP, "hub", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";

export interface Hub { h: Home; db: Db; admin: Server; startedAt: number; close(): Promise<void> }

export function statusOf(hub: Pick<Hub, "db" | "startedAt">): StatusRes {
  return StatusRes.parse({
    version: VERSION, hub_sha: revision().sha, protocol: { current: PROTOCOL.current, min: PROTOCOL.min },
    hub_key_fingerprint: null,   // W2 (06): the hub's static Noise key
    started_at: hub.startedAt, db_version: hub.db.userVersion(),
  });
}

export function router(hub: Pick<Hub, "db" | "startedAt">): Handler {
  return async (req: Req) => {
    if (req.method === "GET" && req.path === "/api/v1/status") return { status: 200, body: statusOf(hub) };
    return { status: 404, body: { error: `no route ${req.method} ${req.path}` } };
  };
}

export async function boot(h: Home = homeOf()): Promise<Hub> {
  const startedAt = Date.now();
  useConfigDir(h.config);
  // the config repo exists before it is read, so a fresh home starts with the seeded files
  const seeded = await ensureConfigRepo(h.config);
  loadAll();
  const db = openDb(h.db);
  try {
    await addDefaultJobs(db, h.config);
    const rep = await ensureAgentHome(db, h.agentHome, undefined, revision().sha);
    const hub: Hub = {
      h, db, startedAt, admin: undefined as unknown as Server,
      async close() {
        await new Promise<void>((res) => hub.admin.close(() => res()));
        db.close();
      },
    };
    hub.admin = await startAdminSocket(h.run, router(hub));
    log("main", "hub up", { db_version: db.userVersion(), seeded_config: seeded.length });
    const seedText = seedNotice(rep);
    if (seedText) await notify.admin(seedText);
    return hub;
  } catch (e) {
    db.close();
    throw e;
  }
}

if (import.meta.main) {
  const hub = await boot();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("main", "stopping");
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
