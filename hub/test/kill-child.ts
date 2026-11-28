// A hub process for kill.test.ts: boots on $SBOT_HOME, optionally writes one message I typed, says "up" and runs
// until it is killed. Fictional data only.
import { boot } from "../src/main.ts";
import { ingest } from "../src/inbox.ts";
import { setQuiet } from "../src/log.ts";

setQuiet(true);
const hub = await boot(undefined, { proxyPort: 0 });
if (process.env.KILL_INGEST) {
  ingest(hub.db, { lane: "client:main", kind: "user", source: "client", source_msg_id: process.env.KILL_INGEST, payload: { text: "帮我整理一下" }, turn: { channel: "client", surface: "client" }, device_id: "cli" });
}
process.stdout.write("up\n");
