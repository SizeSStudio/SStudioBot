// relay.yaml (docs/tech/06 「注册、防抢注册、防洪泛」). Instance config: lives on the server, never in the repo.
//   listen: { host: 127.0.0.1, port: 7840 }
//   hubs: [{ hub_pk: <base64url X25519 public key>, token_hash: <hex sha256 of the hub's RELAY_TOKEN> }]
//   limits: { … }   # every key optional; the defaults below protect the relay, they don't limit me
import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type HubEntry = { hub_pk: string; token_hash: string };
export type Limits = {
  conn_per_min: number;          // new connections per IP per minute (token bucket)
  first_reply_ms: number;        // after OPEN the hub must send its first DATA (Noise message 2) within this
  auth_fail_max: number;         // this many auth failures from one IP inside auth_fail_window_s …
  auth_fail_window_s: number;
  ban_s: number;                 // … bans the IP for this long
  session_bytes_per_s: number;   // device → hub, sustained
  session_burst_bytes: number;   // device → hub, burst
  hub_buffer_max: number;        // hub WS bufferedAmount above this pauses reading from all its devices
  peer_buffer_max: number;       // a device WS above this …
  peer_buffer_s: number;         // … for this long gets closed (it reconnects and catches up by seq, §触6.4)
  ping_s: number;                // keepalive; a side that misses one pong is dropped
};
export type RelayConf = { listen: { host: string; port: number }; hubs: HubEntry[]; limits: Limits; trust_proxy: boolean };

const MiB = 1024 * 1024, MB = 1_000_000;
export const DEFAULT_LIMITS: Limits = {
  conn_per_min: 20, first_reply_ms: 10_000, auth_fail_max: 10, auth_fail_window_s: 600, ban_s: 3600,
  session_bytes_per_s: 4 * MB, session_burst_bytes: 16 * MB,
  hub_buffer_max: 8 * MiB, peer_buffer_max: 2 * MiB, peer_buffer_s: 10, ping_s: 25,
};

const PK = /^[A-Za-z0-9_-]{43}$/, HASH = /^[0-9a-f]{64}$/;

/** Validates by hand (no zod here: relay/ stays tiny). Throws with the key that is wrong, never with a value. */
export function parseConf(o: unknown): RelayConf {
  const c = (o ?? {}) as Record<string, any>;
  const host = c.listen?.host ?? "127.0.0.1", port = c.listen?.port ?? 7840;
  if (typeof host !== "string" || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("relay.yaml: listen.host / listen.port");
  const hubs = c.hubs ?? [];
  if (!Array.isArray(hubs)) throw new Error("relay.yaml: hubs must be a list");
  const seen = new Set<string>();
  hubs.forEach((h: any, i: number) => {
    if (!PK.test(String(h?.hub_pk))) throw new Error(`relay.yaml: hubs[${i}].hub_pk is not a base64url 32-byte key`);
    if (!HASH.test(String(h?.token_hash))) throw new Error(`relay.yaml: hubs[${i}].token_hash is not hex sha256`);
    if (seen.has(h.hub_pk)) throw new Error(`relay.yaml: hubs[${i}].hub_pk is listed twice`);
    seen.add(h.hub_pk);
  });
  const limits = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(c.limits ?? {})) {
    if (!(k in DEFAULT_LIMITS)) throw new Error(`relay.yaml: unknown limits.${k}`);
    if (typeof v !== "number" || !(v > 0)) throw new Error(`relay.yaml: limits.${k} must be a positive number`);
    (limits as Record<string, number>)[k] = v;
  }
  return { listen: { host, port }, hubs: hubs.map((h: HubEntry) => ({ hub_pk: h.hub_pk, token_hash: h.token_hash })), limits, trust_proxy: c.trust_proxy !== false };
}

export const loadConf = (file: string): RelayConf => parseConf(parse(readFileSync(file, "utf8")));
