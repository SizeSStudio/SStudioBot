// The link module's surface for the rest of the hub (docs/tech/03 「link」): invites, the device list, removal with
// its follow-ups, security notices, and the ways in that share them — the device write routes (api/writes.ts, inside
// client_ops; the CLI and paired clients alike since W3) and Feishu /pair, /devices in my own DM. Listing is W2b's
// GET /api/v1/devices.
import type { Db } from "../db/db.ts";
import type { InviteRes } from "../../../protocol/api/devices.ts";
import { consoleConf } from "../config/load.ts";
import { OWNER_DM_LANE } from "../channels/feishu/state.ts";
import { localStamp } from "../time.ts";
import * as notify from "../notify.ts";
import { log } from "../log.ts";
import type { HubKey } from "./keys.ts";
import type { RelayLink } from "./relay-link.ts";
import type { Paired, Role } from "./pairing.ts";
import { createInvite } from "./pairing.ts";
import { listDevices, removeDevice, resolveDevice, short, type Actor } from "./devices.ts";

export class LinkError extends Error {}

/** wss://…/v1/hub (console.yaml) → wss://…/v1/peer, what the pairing code carries. */
export function peerUrlOf(hubUrl: string): string {
  const u = hubUrl.replace(/\/hub\/?$/, "/peer");
  if (u === hubUrl) throw new LinkError("console.yaml 的 relay.url 要以 /v1/hub 结尾");
  return u;
}

export class LinkService {
  readonly db: Db;
  readonly hubKey: HubKey;
  relay: RelayLink | undefined;
  /** 06 删设备 step 4: stop a run this device started (the dispatcher's stopLane, if it is that lane's run). */
  stopRun: (runId: string, lane: string) => void = () => {};

  constructor(db: Db, hubKey: HubKey) { this.db = db; this.hubKey = hubKey; }

  online = (id: string) => this.relay?.online(id) ?? false;

  /** The core of POST /api/v1/devices/invites, sbot pair and Feishu /pair. */
  invite(role: Role, created_by: Actor): InviteRes {
    const r = consoleConf().relay;
    if (!r.url) throw new LinkError("console.yaml 里还没填 relay.url，配对码里没有中继地址，发不出码");
    return createInvite(this.db, { role, created_by, hubPk: this.hubKey.publicB64u, relayUrl: peerUrlOf(r.url), relayEnabled: r.enabled });
  }

  devices() { return listDevices(this.db, this.online); }

  /** 06: removal in one tx plus the follow-ups, then the security notice. undefined = no such live device. */
  remove(id: string, actor: Actor) {
    const r = removeDevice(this.db, id, actor, {
      dropChannels: (d) => this.relay?.dropDevice(d) ?? 0,
      stopRun: (run, lane) => this.stopRun(run, lane),
    });
    if (!r) return undefined;
    log("link", "device removed", { device: short(id), channels: r.channels, dropped: r.dropped, runs: r.runs });
    // security alert class (§触1.1); until push lands in W3 it goes to the admin outlet
    void notify.admin(`删了一台设备：「${r.name}」（${r.role}，${short(id)}），由 ${actor}。断开 ${r.channels} 条连接，作废 ${r.dropped} 条排队输入，停了 ${r.runs} 个 run。`);
    return r;
  }

  onPaired = (p: Paired) => {
    log("link", "device paired", { device: short(p.id), role: p.role });
    void notify.admin(`新设备配上了：「${p.name}」（${p.platform || "平台没说"}，${p.role}，${short(p.id)}）。名字是它自称的。不是你配的就马上删：sbot devices rm ${short(p.id)}，或飞书私聊 /devices rm ${short(p.id)}`);
  };

  onNewIp = (id: string, ipMasked: string) => {
    const d = this.db.one<{ name: string }>("SELECT name FROM devices WHERE id = ?", id);
    // a notice, not a security alert ※: phones change carrier ranges all the time and this would ring at night
    void notify.admin(`设备「${d?.name ?? "?"}」（${short(id)}）从没见过的 IP 段连上了：${ipMasked}`);
  };

  /** An invite error that is mine to fix (console.yaml), said as-is (api/writes.ts answers 409). */
  refusal = (e: unknown): string | undefined => (e instanceof LinkError ? e.message : undefined);

  /**
   * Feishu /pair [node], /devices, /devices rm <id> — only in my own DM (the lane only my own p2p messages reach,
   * channels/feishu/plugin.ts). Elsewhere it isn't ours and the row stays text. The code goes back through Feishu's
   * servers, so this path doesn't keep the "# never reaches a server" property (§底3.8).
   */
  command = (name: string, arg: string, lane: string): string | undefined => {
    if (lane !== OWNER_DM_LANE || (name !== "pair" && name !== "devices")) return undefined;
    try {
      if (name === "pair") {
        if (arg && arg !== "node") return "用法：/pair 或 /pair node";
        const r = this.invite(arg === "node" ? "node" : "client", "channel:feishu");
        return [
          `配对链接（${arg === "node" ? "节点" : "客户端"}，10 分钟内有效，只能用一次，当密码看待）：`, r.link, "",
          "这条经过了飞书的服务器。不是你要的就别动它，10 分钟后自己失效。",
          ...(r.relay_enabled ? [] : ["注意：中继还没开（console.yaml relay.enabled），现在用这个码连不上。"]),
        ].join("\n");
      }
      const [sub, idArg, ...rest] = arg.split(/\s+/).filter(Boolean);
      if (!sub) {
        const list = this.devices();
        if (!list.length) return "还没有配对过的设备。/pair 拿一个配对链接。";
        return [`设备 ${list.length} 台（名字是它们自称的）：`,
          ...list.map((d) => `· ${short(d.id)}「${d.name}」${d.platform ?? ""} · ${d.role} · ${d.online ? "在线" : d.last_seen ? `最近 ${localStamp(d.last_seen)}` : "没连过"}${d.last_ip_masked ? ` · ${d.last_ip_masked}` : ""}`),
          "删一台：/devices rm <id 前 6 位以上>"].join("\n");
      }
      if (sub !== "rm" || !idArg || rest.length) return "用法：/devices 或 /devices rm <id>";
      const found = resolveDevice(this.db, idArg);
      if ("error" in found) return found.error;
      const r = this.remove(found.id, "channel:feishu");
      return r ? `删了「${r.name}」（${short(found.id)}）：断开 ${r.channels} 条连接，作废 ${r.dropped} 条排队输入，停了 ${r.runs} 个 run。` : "没有这台设备。";
    } catch (e) {
      if (e instanceof LinkError) return e.message;
      log("link", "feishu command failed", { cmd: name, err: String((e as Error)?.message ?? e).slice(0, 200) });
      return "出错了，没做成。";
    }
  };
}
