// The hub process (03 「启动顺序」): config → db → config repo seed + default jobs → agent-home seed → secrets + redact
// → proxy → inbox.recover → hub.sock (local node) → channels, timers, Sentinel, sources, triage → outbox, dispatcher →
// api (read-only /api/v1 + event pump, W2b) → hub-admin.sock → the relay link (only when console.yaml relay.enabled)
// → "hub up" → notices through the admin outlet. Shutdown is the reverse. push comes in W3.
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
import { backupConf, loadAll, useConfigDir } from "./config/load.ts";
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
import { proxyCommitChecker } from "./commit-check.ts";
import { PiRunner } from "./runner/pi.ts";
import type { Runner } from "./runner/types.ts";
import { registerBuiltinTools } from "./tools/builtin.ts";
import { allTools } from "./tools/registry.ts";
import { invalidateForOwnerMessage, submitApproval, sweepApprovals } from "./approvals.ts";
import { kickInbox } from "./inbox.ts";
import { setDb } from "./db/ambient.ts";
import { channel, registerChannel, startChannels, stopChannels, unregisterChannel } from "./channels/registry.ts";
import { channelHost } from "./channels/host.ts";
import { cardRows } from "./channels/card-rows.ts";
import { cardReplies, channelCommands } from "./channels/commands.ts";
import { ensureMainThread } from "./api/writes.ts";
import { FeishuChannel, feishuConfigured } from "./channels/feishu/plugin.ts";
import { observerHooks } from "./channels/feishu/observer.ts";
import { userIdentityReady } from "./channels/feishu/user.ts";
import { Scheduler } from "./timers/schedule.ts";
import { Sentinel } from "./timers/sentinel.ts";
import { Sources, configureSources } from "./sources/index.ts";
import { localPluginRunner } from "./sources/command.ts";
import { Triage, readByMe, type SendApproval } from "./triage/triage.ts";
import { proxyComplete } from "./triage/complete.ts";
import { runBackup } from "./backup.ts";
import { nodeCheck } from "./check.ts";
import { createApi, type Api } from "./api/index.ts";
import { useCrypto } from "../../protocol/noise/crypto.ts";
import { nodeAead, nodeDh } from "../../protocol/noise/node-crypto.ts";
import { loadOrCreateHubKey, type HubKey } from "./link/keys.ts";
import { LinkService } from "./link/service.ts";
import { RelayLink } from "./link/relay-link.ts";
import { authorize } from "./link/roles.ts";
import { secret } from "./secrets.ts";
import { consoleConf } from "./config/load.ts";
import type { NodePeer, Session } from "./link/session.ts";
import { NodeRegistry } from "./tasks/nodes.ts";
import { TaskEngine } from "./tasks/engine.ts";
import { nodeRoutes } from "./tasks/node-api.ts";
import { nodeTools } from "./tasks/tools.ts";

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
  proxy: import("node:http").Server; outbox: Outbox; node: NodeLink; dispatcher: Dispatcher; runner: Runner; api: Api;
  hubKey: HubKey; link: LinkService; nodes: NodeRegistry; tasks: TaskEngine;
  close(): Promise<void>;
}

export interface BootOpts {
  /** tests inject a runner; the hub itself always uses pi */
  runner?: (proxyBase: string) => Runner;
  proxyPort?: number;
}

/** A triage draft (triage.ts) filed as W1d's send approval: the only way it leaves, and only as me after I approve. */
export const sendApproval = (db: Db) => (a: SendApproval) => submitApproval(db, {
  kind: "send", title: a.title, draft: a.draft, run_id: a.run_id, requester: a.requester, channel: a.channel, as_identity: a.as_identity,
  target: a.target, context: a.context, origin_lane: "triage",
  checks: { hits: Array.isArray((a.checks as { hits?: unknown })?.hits) ? ((a.checks as { hits: unknown[] }).hits.filter((x) => typeof x === "string") as string[]) : ["承诺检测结果读不出"] },
  trigger: { chat: a.trigger_chat, msg_id: a.trigger_msg_id, ts: a.trigger_ts },
});

/**
 * The channel side (03 「channels」「timers 和 Sentinel」): Feishu when channels.yaml has it, then timers, Sentinel,
 * sources and triage. Every wake-up goes to the dispatcher (kickInbox). Returns the stop, in reverse order.
 */
async function startChannelSide(db: Db, h: Home, proxyBase: string, dispatcher: Dispatcher, node: NodeLink, side: { triage?: Triage }): Promise<() => Promise<void>> {
  const ours = feishuConfigured() && !channel("feishu");
  if (ours) registerChannel(new FeishuChannel());
  const feishu = () => channel("feishu") as FeishuChannel | undefined;
  // a message I sent myself in a chat voids the pending drafts there (§触2.4, 03 作废)
  observerHooks.ownerMessage = (chat, ts) => { invalidateForOwnerMessage(db, { chat, after_ts: ts }); };
  await startChannels(channelHost(db));
  const f = feishu();
  // a command plugin runs as its own user on Linux (worker-exec plugin mode, not built yet) — never as the hub ※
  configureSources({ lark: f?.lark, runner: process.platform === "linux" ? undefined : localPluginRunner });
  const scheduler = new Scheduler({
    onFire: kickInbox, check: nodeCheck(node, h.root),
    // the nightly backup (default job `backup`); a thrown error is the job's `failed`, which Sentinel reports
    handlers: { backup: async () => { await runBackup(db, h, backupConf()); } },
  });
  const sentinel = new Sentinel({ userReady: f ? () => userIdentityReady(f.lark) : undefined });
  const sources = new Sources();
  // a group draft: W1d's runner in the others' read-only scope, W1d's commitment check, out only as a send approval
  const triage = new Triage({
    complete: proxyComplete(db, proxyBase), runDraft: (j) => dispatcher.runDraft(j), commitCheck: proxyCommitChecker(db, proxyBase),
    submitSend: sendApproval(db), readIds: f ? readByMe(f.lark) : undefined, kick: kickInbox,
  });
  side.triage = triage;
  scheduler.start(); sentinel.start(); sources.start(); triage.start();
  return async () => {
    side.triage = undefined;
    triage.stop(); sources.stop(); sentinel.stop(); scheduler.stop();
    await stopChannels();
    observerHooks.ownerMessage = () => {};
    if (ours) unregisterChannel("feishu");
  };
}

export function statusOf(hub: Pick<Hub, "db" | "startedAt" | "hubKey" | "link">): StatusRes {
  return StatusRes.parse({
    version: VERSION, hub_sha: revision().sha, protocol: { current: PROTOCOL.current, min: PROTOCOL.min },
    hub_key_fingerprint: hub.hubKey.fingerprint, hub_pk: hub.hubKey.publicB64u,
    started_at: hub.startedAt, db_version: hub.db.userVersion(),
    relay: { enabled: consoleConf().relay.enabled, connected: hub.link.relay?.connected ?? false },
  });
}

/**
 * hub-admin.sock: the CLI is the client device `cli` (03 link). Everything goes through the one api dispatcher, writes
 * included (W3: the device writes moved there, inside client_ops; adminRequest gives each write its own op id).
 */
export function router(hub: Pick<Hub, "api">): Handler {
  const cli = { device_id: "cli", role: "client" } as const;
  return async (req: Req) => {
    const out = await hub.api.dispatch(req, cli);
    return { status: out.status, body: out.body, ...(out.seq != null ? { seq: out.seq } : {}) };
  };
}

export async function boot(h: Home = homeOf(), o: BootOpts = {}): Promise<Hub> {
  const startedAt = Date.now();
  // 02 ※: hub and nodes use node:crypto (OpenSSL) for the Noise primitives
  useCrypto({ aead: nodeAead, dh: nodeDh });
  useConfigDir(h.config);
  // the config repo exists before it is read, so a fresh home starts with the seeded files
  const seeded = await ensureConfigRepo(h.config);
  loadAll();
  const db = openDb(h.db);
  const opened: { close(): unknown }[] = [];
  try {
    await addDefaultJobs(db, h.config);
    const rep = await ensureAgentHome(db, h.agentHome, undefined, revision().sha);
    // 06: the hub key exists from the first start (status shows it, pairing needs it); made before the secrets are
    // read so redact() learns it like every other file in keys/
    const hubKey = loadOrCreateHubKey(h.keys);
    const link = new LinkService(db, hubKey);
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
    // nodes and tasks (W4a): the registry answers hello; the engine runs task lanes and talks to sessions on nodes
    const nodes = new NodeRegistry({ db, hubSha: () => revision().sha, tools: nodeTools });
    let pumpItem: ((run: string, lane: string, e: import("./runner/types.ts").ItemEvent) => void) | undefined;
    const tasks = new TaskEngine({ db, h, nodes, onItem: (run, lane, e) => pumpItem?.(run, lane, e) });
    // the one role check (link/roles.ts) at the dispatcher's entry, for every transport
    // triage is started with the channels below; a redraft for one of its cards goes to it (approvals.requestRedraft)
    const side: { triage?: Triage } = {};
    const redraftTriage = (id: number) => { void side.triage?.redraft(id); };
    const late: { d?: Dispatcher } = {};   // the api is made first (the dispatcher streams into its pump)
    const api = createApi({
      db, blobs: h.blobs, hubSha: () => revision().sha, status: () => statusOf({ db, startedAt, hubKey, link }), authorize,
      runs: { activeRun: (l) => late.d?.activeRun(l), stopLane: (l) => late.d?.stopLane(l) ?? false },
      devices: link, redraftTriage, tasks,
      node: nodeRoutes({ blobs: h.blobs, nodes, engine: tasks }),
    });
    ensureMainThread(db);
    pumpItem = (run, lane, e) => api.pump.onItem(run, lane, e);
    // the local node's requests: the same dispatcher, as device `local`, role `node`
    node.handle = (req, peer) => api.dispatch(req, { device_id: "local", role: "node", peer });
    node.onGone = () => nodes.gone("local");
    const dispatcher = late.d = new Dispatcher({ db, h, runner, node, commitCheck: proxyCommitChecker(db, proxyBase),
      onItem: (run, lane, e) => api.pump.onItem(run, lane, e),
      onCard: cardRows(db, () => channel("feishu") as FeishuChannel | undefined),
      stream: (c) => channel(c.turn.channel)?.stream?.(c),
      // §触6.9 并行 F: the lists and /help, then W2a's /pair and /devices
      command: channelCommands(db, link.command), cardReply: cardReplies(db, redraftTriage) });
    // 06 删设备 step 4: stop a run the removed device started, if it is still its lane's run
    link.stopRun = (run, lane) => { if (dispatcher.activeRun(lane) === run) dispatcher.stopLane(lane); };
    // before anything can take new rows: what the last process left half done (§底1.2)
    dispatcher.recover();
    await node.listen(h.node);
    opened.push(node);
    // channels before the outbox drains: a row for a channel that isn't registered yet would be marked unrouted
    setDb(db);   // the ported ledger/timer modules use the ambient db (db/ambient.ts)
    opened.push({ close: () => setDb(undefined) });
    const stopSide = await startChannelSide(db, h, proxyBase, dispatcher, node, side);
    opened.push({ close: stopSide });
    outbox.start();
    opened.push({ close: () => outbox.stop() });
    sweepApprovals(db);
    const sweeper = setInterval(() => { try { sweepApprovals(db); } catch (e) { log("main", "approval sweep failed", { err: String((e as Error).message).slice(0, 200) }); } }, 60_000);
    sweeper.unref();
    dispatcher.start();
    tasks.startLoop();
    opened.push({ close: () => tasks.stopLoop() });
    api.start();
    opened.push({ close: () => api.stop() });

    const hub: Hub = {
      h, db, startedAt, admin: undefined as unknown as Server, proxy, outbox, node, dispatcher, runner, api, hubKey, link, nodes, tasks,
      async close() {
        await link.relay?.close();
        tasks.stopLoop();
        clearInterval(sweeper);
        api.stop();
        await dispatcher.stop();
        outbox.stop();
        await outbox.idle();
        await stopSide();
        setDb(undefined);
        await node.close();
        await new Promise<void>((res) => proxy.close(() => res()));
        proxy.closeAllConnections?.();
        await new Promise<void>((res) => hub.admin.close(() => res()));
        db.close();
      },
    };
    hub.admin = await startAdminSocket(h.run, router(hub));
    startRelayLink(hub);
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

/**
 * 06 「开关」: the link to the relay is off unless console.yaml relay.enabled (turning it on is a widening, config/
 * widening.ts). Read at boot ※: flipping it takes effect on the next start. RELAY_TOKEN stays in secrets.ts memory.
 */
function startRelayLink(hub: Hub) {
  const r = consoleConf().relay;
  if (!r.enabled) return;
  const token = secret("RELAY_TOKEN");
  if (!r.url || !token) { log("link", "relay.enabled but relay.url or RELAY_TOKEN is missing; not connecting"); return; }
  const relay = new RelayLink({
    db: hub.db, hubKey: hub.hubKey, url: r.url, token,
    // a channel's `req` frames: straight to the api dispatcher (it authorizes); the session is the stream's conn
    // a node's channel also carries the hub's requests down (Session.request): it is that node's peer
    handle: (req, caller, conn) => hub.api.dispatch(req, { ...caller, conn, ...(caller.role === "node" ? { peer: conn as unknown as NodePeer } : {}) }),
    closed: (conn) => {
      hub.api.closeConn(conn);
      const who = (conn as unknown as Session).who;
      if (who?.role === "node") hub.nodes.gone(who.device_id, conn as unknown as NodePeer);
    },
    onPaired: hub.link.onPaired, onNewIp: hub.link.onNewIp,
  });
  hub.link.relay = relay;
  relay.start();
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
