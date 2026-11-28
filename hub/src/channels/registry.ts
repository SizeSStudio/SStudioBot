// Channel plugins by name (03 「channels」). The outbox (W1d) calls channel(row.channel).send(row). A plugin that fails
// to start stays registered but not started: its sends throw, the outbox marks them failed, Sentinel can see it.
import { log } from "../log.ts";
import type { ChannelHost, ChannelPlugin } from "./types.ts";

const plugins = new Map<string, ChannelPlugin>();
const started = new Set<string>();

export function registerChannel(p: ChannelPlugin) {
  if (plugins.has(p.id)) throw new Error(`channel ${p.id} registered twice`);
  plugins.set(p.id, p);
}

export const channel = (id: string): ChannelPlugin | undefined => plugins.get(id);
export const channels = (): ChannelPlugin[] => [...plugins.values()];
export const isStarted = (id: string) => started.has(id);

export async function startChannels(h: ChannelHost) {
  for (const p of plugins.values()) {
    try { await p.start(h); started.add(p.id); log("channels", "started", { id: p.id }); }
    catch (e) { log("channels", "start failed", { id: p.id, err: String((e as Error)?.message ?? e).slice(0, 300) }); }
  }
}

export async function stopChannels() {
  for (const p of plugins.values()) {
    if (!started.delete(p.id)) continue;
    try { await p.stop(); } catch (e) { log("channels", "stop failed", { id: p.id, err: String((e as Error)?.message ?? e).slice(0, 200) }); }
  }
}

/** tests */
export function clearChannels() { plugins.clear(); started.clear(); }
