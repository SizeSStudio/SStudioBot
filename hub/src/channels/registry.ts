// The one channel registry (03 「channels」): plugins by id. The outbox calls channel(row.channel).send(row). A plugin
// that fails to start stays registered but not started: its sends fail, the outbox marks them, Sentinel can see it.
// Tests may register a bare {id, caps, send}; start/stop are called only when a plugin has them.
import { log } from "../log.ts";
import type { ChannelHost, RegisteredChannel } from "./types.ts";

const plugins = new Map<string, RegisteredChannel>();
const started = new Set<string>();

export function registerChannel(p: RegisteredChannel) {
  if (plugins.has(p.id)) throw new Error(`channel ${p.id} registered twice`);
  plugins.set(p.id, p);
}
export function unregisterChannel(id: string) { plugins.delete(id); started.delete(id); }

export const channel = (id: string): RegisteredChannel | undefined => plugins.get(id);
export const channels = (): RegisteredChannel[] => [...plugins.values()];
export const isStarted = (id: string) => started.has(id);

export async function startChannels(h: ChannelHost) {
  for (const p of plugins.values()) {
    if (!p.start || started.has(p.id)) continue;
    try { await p.start(h); started.add(p.id); log("channels", "started", { id: p.id }); }
    catch (e) { log("channels", "start failed", { id: p.id, err: String((e as Error)?.message ?? e).slice(0, 300) }); }
  }
}

export async function stopChannels() {
  for (const p of [...plugins.values()].reverse()) {
    if (!started.delete(p.id)) continue;
    try { await p.stop?.(); } catch (e) { log("channels", "stop failed", { id: p.id, err: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }
}

/** tests */
export function clearChannels() { plugins.clear(); started.clear(); }
