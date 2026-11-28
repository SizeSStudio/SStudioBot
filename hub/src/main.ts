// The hub process (03 「启动顺序」): config → db → config repo seed + default jobs → agent-home seed → secrets + redact
// → inbox.recover → hub.sock (local node) → [channels start: W1e] → proxy, outbox, dispatcher → hub-admin.sock →
// "hub up" → notices through the admin outlet. push, timers and api.pump take their places in W1e/W2.
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
import { loadSecrets } from "./secrets.ts";
import { redact, refreshKnown } from "./tools/redact.ts";
import { setRedactor } from "./log.ts";
import { Outbox, toOutlet } from "./outbox.ts";
import { startProxy } from "./proxy.ts";
import { NodeLink } from "./node-link.ts";
import { Dispatcher } from "./dispatch.ts";
import { PiRunner } from "./runner/pi.ts";
import type { Runner } from "./runner/types.ts";
import { registerBuiltinTools } from "./tools/builtin.ts";
import { allTools } from "./tools/registry.ts";
import { sweepApprovals } from "./approvals.ts";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The running commit: REVISION (line 1 = sha) that deploy writes into a release; a dev checkout says "dev". */
export function revision(appDir = APP): { sha: string; subject: string } {
  const f = join(appDir, "REVISION");
  if (!existsSync(f)) return { sha: "dev", subject: "" };
  const [sha = "dev", , ...rest] = readFileSync(f, "utf8").trim().split("\n");
  return { sha, subject: rest.join(" ") };
}
export const VERSION = (JSON.parse(readFileSync(join(APP, "hub", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";

export interface Hub {
  h: Home; db: Db; admin: Server; startedAt: number;
  proxy: import("node:http").Server; outbox: Outbox; node: NodeLink; dispatcher: Dispatcher; runner: Runner;
  close(): Promise<void>;
}

export interface BootOpts {
  /** tests inject a runner; the hub itself always uses pi */
  runner?: (proxyBase: string) => Runner;
  proxyPort?: number;
}

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

export async function boot(h: Home = homeOf(), o: BootOpts = {}): Promise<Hub> {
  const startedAt = Date.now();
  useConfigDir(h.config);
  // the config repo exists before it is read, so a fresh home starts with the seeded files
  const seeded = await ensureConfigRepo(h.config);
  loadAll();
  const db = openDb(h.db);
  const opened: { close(): unknown }[] = [];
  try {
    await addDefaultJobs(db, h.config);
    const rep = await ensureAgentHome(db, h.agentHome, undefined, revision().sha);
    // secrets go into memory once; from here on every log line, run item, event and card is redacted
    loadSecrets(h.secrets, h.keys);
    refreshKnown();
    setRedactor(redact);
    if (!allTools().length) registerBuiltinTools();

    const outbox = new Outbox(db);
    notify.setAdminSink((text) => { toOutlet(db, "admin", text, { lane: "outlet:admin" }); outbox.kick(); });
    const node = new NodeLink(revision().sha);
    const proxy = await startProxy(db, h.blobs, o.proxyPort);
    opened.push({ close: () => proxy.close() });
    const proxyBase = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/llm`;
    const runner = o.runner ? o.runner(proxyBase) : new PiRunner(h.pi, proxyBase);
    const dispatcher = new Dispatcher({ db, h, runner, node });
    // before anything can take new rows: what the last process left half done (§底1.2)
    dispatcher.recover();
    await node.listen(h.run);
    opened.push(node);
    // W1e: channels start here, before the outbox drains
    outbox.start();
    opened.push({ close: () => outbox.stop() });
    sweepApprovals(db);
    const sweeper = setInterval(() => { try { sweepApprovals(db); } catch (e) { log("main", "approval sweep failed", { err: String((e as Error).message).slice(0, 200) }); } }, 60_000);
    sweeper.unref();
    dispatcher.start();

    const hub: Hub = {
      h, db, startedAt, admin: undefined as unknown as Server, proxy, outbox, node, dispatcher, runner,
      async close() {
        clearInterval(sweeper);
        await dispatcher.stop();
        outbox.stop();
        await outbox.idle();
        await node.close();
        await new Promise<void>((res) => proxy.close(() => res()));
        proxy.closeAllConnections?.();
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
    for (const x of opened.reverse()) { try { await x.close(); } catch { /* best effort */ } }
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
