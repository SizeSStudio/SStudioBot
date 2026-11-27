// Runtime-agnostic speed check for the P1 Hermes thresholds: device-side handshake, 64 KiB frame
// seal + open, and sustained throughput. Runs under Node directly and under Hermes via bench/hermes.sh.
//   node bench/crypto-speed.ts
import { finishInitiator, generateNoiseKeyPair, respond, startInitiator, type Transport } from "../noise/channel.ts";

type Clock = () => number;

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function connect(hub: ReturnType<typeof generateNoiseKeyPair>, now: Clock) {
  // Only the initiator's work is timed: that is what the phone does; the hub's half runs untimed.
  const t0 = now();
  const { hs, message } = startInitiator(hub.publicKey, { v: 1, role: "client", purpose: "auth" });
  const t1 = now();
  const r = respond(hub, message, () => ({ v: 1, challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", hub_time: 0 }));
  const t2 = now();
  const { transport } = finishInitiator(hs, r.reply);
  const t3 = now();
  return { device: transport, hub: r.transport, deviceMs: t1 - t0 + (t3 - t2) };
}

function roundTrip(tx: Transport, rx: Transport, frame: Uint8Array): void {
  let out: Uint8Array | null = null;
  for (const m of tx.seal(frame)) out = rx.open(m);
  if (!out || out.byteLength !== frame.byteLength) throw new Error("round trip failed");
}

export function run(now: Clock) {
  const hub = generateNoiseKeyPair();
  for (let i = 0; i < 5; i++) connect(hub, now); // warm up
  const hsMs: number[] = [];
  for (let i = 0; i < 30; i++) hsMs.push(connect(hub, now).deviceMs);

  const { device, hub: hubSide } = connect(hub, now);
  const f64 = new Uint8Array(64 * 1024).fill(0x61);
  for (let i = 0; i < 5; i++) roundTrip(device, hubSide, f64);
  const f64Ms: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t = now();
    roundTrip(device, hubSide, f64);
    f64Ms.push(now() - t);
  }

  // Sustained: 1 MiB frames, hub → device (the phone's main direction). seal + open, and open alone.
  const f1m = new Uint8Array(1024 * 1024).fill(0x62);
  const reps = 16;
  let t = now();
  for (let i = 0; i < reps; i++) roundTrip(hubSide, device, f1m);
  const bothMBs = reps / ((now() - t) / 1000);
  const sealed: Uint8Array[][] = [];
  for (let i = 0; i < reps; i++) sealed.push(hubSide.seal(f1m));
  t = now();
  for (const pieces of sealed) for (const m of pieces) device.open(m);
  const openMBs = reps / ((now() - t) / 1000);

  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    handshake_device_ms: { median: r2(median(hsMs)), max: r2(Math.max(...hsMs)) },
    frame64k_seal_open_ms: { median: r2(median(f64Ms)), max: r2(Math.max(...f64Ms)) },
    throughput_MBps: { seal_and_open: r2(bothMBs), open_only: r2(openMBs) },
  };
}

if (typeof process !== "undefined" && import.meta.main) console.log(JSON.stringify(run(() => performance.now()), null, 1));
