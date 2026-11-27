// 20 device sessions through the relay, each streaming 10 events/s from the hub, for `seconds`.
// Reports the hub's event-loop delay and RSS increase (from its own stats route) and the relay's RSS (/healthz).
//   node bench/load.ts --relay ws://H:7829 --relay-http http://H:7829 --hub-pk <b64u> --home <dir> [--devices 20 --rate 10 --seconds 60]
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type Conn } from "../device.ts";
import { fromB64u } from "../identity.ts";

export async function runLoad(o: { relay: string; relayHttp: string; hubPk: string; home: string; devices: number; rate: number; seconds: number }) {
  const hubPk = fromB64u(o.hubPk);
  const ident = (i: number) => {
    const j = JSON.parse(readFileSync(join(o.home, `dev-${i}.json`), "utf8"));
    return { secretKey: fromB64u(j.sk), publicKey: fromB64u(j.pk) };
  };
  const url = `${o.relay}/v1/peer?hub=${o.hubPk}`;
  const relayRss = async () => (await (await fetch(`${o.relayHttp}/healthz`)).json()).rss as number;
  // Control session (last identity) for stats; the measured sessions are the first `devices`.
  const ctl = await connect({ url, hubPk, id: ident(o.devices) });
  const relayBefore = await relayRss();
  const base = (await ctl.request("POST", "/probe/reset")).body.rss as number;
  const conns: Conn[] = [];
  let received = 0;
  const lags: number[] = [];
  for (let i = 0; i < o.devices; i++) {
    const c = await connect({ url, hubPk, id: ident(i) });
    c.onEvent = (f) => {
      if (f.t !== "ev") return;
      received++;
      lags.push(Date.now() - f.ts);
    };
    conns.push(c);
  }
  await Promise.all(conns.map((c) => c.request("POST", "/api/v1/stream", { after: 0, rate: o.rate })));
  await ctl.request("POST", "/probe/reset"); // measure the steady state, not the connect burst
  const relaySamples: number[] = [];
  for (let s = 0; s < o.seconds; s += 5) {
    await new Promise((r) => setTimeout(r, 5000));
    relaySamples.push(await relayRss());
  }
  const stats = (await ctl.request("GET", "/probe/stats")).body;
  conns.forEach((c) => c.ws.close());
  ctl.ws.close();
  const sorted = lags.sort((a, b) => a - b);
  const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
  return {
    devices: o.devices,
    rate_per_device: o.rate,
    seconds: o.seconds,
    events_received: received,
    expected_events: o.devices * o.rate * o.seconds,
    hub_eld_ms: stats.eld_ms,
    hub_rss_mb: mb(stats.rss),
    hub_rss_increase_mb: mb(stats.rss - base),
    relay_rss_mb: { before: mb(relayBefore), max: mb(Math.max(...relaySamples)) },
    event_lag_ms: { p50: sorted[sorted.length >> 1], p99: sorted[Math.floor(sorted.length * 0.99)] },
  };
}

if (import.meta.main) {
  const { values: v } = parseArgs({
    options: {
      relay: { type: "string" },
      "relay-http": { type: "string" },
      "hub-pk": { type: "string" },
      home: { type: "string" },
      devices: { type: "string", default: "20" },
      rate: { type: "string", default: "10" },
      seconds: { type: "string", default: "60" },
    },
  });
  console.log(
    JSON.stringify(
      await runLoad({ relay: v.relay!, relayHttp: v["relay-http"]!, hubPk: v["hub-pk"]!, home: v.home!, devices: Number(v.devices), rate: Number(v.rate), seconds: Number(v.seconds) }),
      null,
      1,
    ),
  );
  process.exit(0);
}
