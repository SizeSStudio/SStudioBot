// A WS man in the middle for tests: accepts on its own loopback port, opens the same path on the relay, copies every
// message both ways and records it — the bytes the relay is handed and hands out, on the hub's side (envelopes) and
// the devices' side (bare Noise messages). X-Real-IP is passed through so the relay (which trusts it from loopback)
// sees the "device's" IP. Close codes the relay may send (1000, 3000–4999) are passed on as they are.
import { WebSocket, WebSocketServer } from "ws";

export type Side = "hub" | "peer";

export interface Tap {
  port: number;
  /** everything, in order: [side, bytes] */
  wire: [Side, Buffer][];
  close(): Promise<void>;
}

export async function startTap(relayPort: () => number): Promise<Tap> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false, maxPayload: 1 << 20 });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const wire: [Side, Buffer][] = [];
  wss.on("connection", (down, req) => {
    const side: Side = (req.url ?? "").startsWith("/v1/hub") ? "hub" : "peer";
    const headers: Record<string, string> = {};
    for (const k of ["authorization", "x-sbot-hub", "x-real-ip"]) if (typeof req.headers[k] === "string") headers[k] = req.headers[k] as string;
    const up = new WebSocket(`ws://127.0.0.1:${relayPort()}${req.url}`, { headers, perMessageDeflate: false });
    const queue: Buffer[] = [];
    const ok = (c: number) => c === 1000 || (c >= 3000 && c <= 4999);
    down.on("message", (d: Buffer) => { wire.push([side, Buffer.from(d)]); if (up.readyState === WebSocket.OPEN) up.send(d); else queue.push(d); });
    up.on("open", () => { for (const d of queue.splice(0)) up.send(d); });
    up.on("message", (d: Buffer) => { wire.push([side, Buffer.from(d)]); if (down.readyState === WebSocket.OPEN) down.send(d); });
    up.on("close", (code, reason) => { if (ok(code)) down.close(code, reason); else down.terminate(); });
    down.on("close", (code, reason) => { if (up.readyState === WebSocket.OPEN) { if (ok(code)) up.close(code, reason); else up.terminate(); } else up.terminate(); });
    up.on("unexpected-response", () => { down.terminate(); up.terminate(); });
    up.on("error", () => down.terminate());
    down.on("error", () => up.terminate());
  });
  return {
    port: (wss.address() as { port: number }).port,
    wire,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
