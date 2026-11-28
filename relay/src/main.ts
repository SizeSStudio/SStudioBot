#!/usr/bin/env node
// sbot-relay: RELAY_CONFIG names relay.yaml (default /etc/sbot-relay/relay.yaml). SIGHUP re-reads it (a new hub key,
// a token change) without dropping the other sessions; a bad file on reload is logged and the old one kept.
import { loadConf } from "./config.ts";
import { jsonLog, startRelay } from "./relay.ts";

const file = process.env.RELAY_CONFIG ?? "/etc/sbot-relay/relay.yaml";
const relay = await startRelay(loadConf(file));

process.on("SIGHUP", () => {
  try { relay.reload(loadConf(file)); } catch (e) { jsonLog("reload_failed", { err: String((e as Error).message).slice(0, 200) }); }
});
const stop = async () => { await relay.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
