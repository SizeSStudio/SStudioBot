// Round trip of a small req/res through the relay vs straight to the hub, interleaved; prints medians.
//   node bench/rtt.ts --relay ws://H:7829 --direct ws://H:7830 --hub-pk <b64u> --identity dev-0.json [--n 200]
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { connect } from "../device.ts";
import { fromB64u } from "../identity.ts";

export async function runRtt(relay: string, direct: string, hubPkB64: string, identityPath: string, n = 200) {
  const j = JSON.parse(readFileSync(identityPath, "utf8"));
  const id = { secretKey: fromB64u(j.sk), publicKey: fromB64u(j.pk) };
  const hubPk = fromB64u(hubPkB64);
  const t0 = performance.now();
  const viaRelay = await connect({ url: `${relay}/v1/peer?hub=${hubPkB64}`, hubPk, id });
  const connectRelayMs = performance.now() - t0;
  const t1 = performance.now();
  const viaDirect = await connect({ url: direct, hubPk, id });
  const connectDirectMs = performance.now() - t1;
  const sample = async (c: typeof viaRelay) => {
    const t = performance.now();
    await c.request("POST", "/probe/echo", { pad: "x".repeat(200) });
    return performance.now() - t;
  };
  for (let i = 0; i < 20; i++) await sample(viaRelay), await sample(viaDirect); // warm up
  const r: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n; i++) {
    r.push(await sample(viaRelay));
    d.push(await sample(viaDirect));
    await new Promise((res) => setTimeout(res, 20));
  }
  viaRelay.ws.close();
  viaDirect.ws.close();
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)];
  const round = (x: number) => Math.round(x * 100) / 100;
  return {
    n,
    relay_ms: { median: round(med(r)), p90: round(p90(r)) },
    direct_ms: { median: round(med(d)), p90: round(p90(d)) },
    extra_median_ms: round(med(r) - med(d)),
    extra_paired_median_ms: round(med(r.map((x, i) => x - d[i]))),
    connect_ms: { relay: round(connectRelayMs), direct: round(connectDirectMs) },
  };
}

if (import.meta.main) {
  const { values: v } = parseArgs({
    options: { relay: { type: "string" }, direct: { type: "string" }, "hub-pk": { type: "string" }, identity: { type: "string" }, n: { type: "string", default: "200" } },
  });
  console.log(JSON.stringify(await runRtt(v.relay!, v.direct!, v["hub-pk"]!, v.identity!, Number(v.n)), null, 1));
  process.exit(0);
}
