// A man in the middle for the tamper test: forwards one device session to the relay and flips one
// random bit in the Nth message of the chosen direction. Plays the part of a malicious relay or network.
import { WebSocket, WebSocketServer } from "ws";

export type Plan = { dir: "up" | "down"; index: number };

export function startTamperProxy(target: string): Promise<{ url: string; arm(p: Plan): void; close(): void }> {
  let plan: Plan = { dir: "up", index: -1 };
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (client, req) => {
    const p = plan;
    const upstream = new WebSocket(target + (req.url ?? ""));
    const queue: Buffer[] = [];
    let up = 0;
    let down = 0;
    const flip = (b: Buffer) => {
      const c = Buffer.from(b);
      c[Math.floor(Math.random() * c.length)] ^= 1 << Math.floor(Math.random() * 8);
      return c;
    };
    client.on("message", (d: Buffer) => {
      const m = p.dir === "up" && up++ === p.index ? flip(d) : d;
      upstream.readyState === upstream.OPEN ? upstream.send(m) : queue.push(m);
    });
    upstream.on("open", () => queue.splice(0).forEach((m) => upstream.send(m)));
    upstream.on("message", (d: Buffer) => client.send(p.dir === "down" && down++ === p.index ? flip(d) : d));
    upstream.on("close", (code, r) => client.readyState === client.OPEN && client.close(code === 1005 ? 1000 : code, r));
    client.on("close", () => upstream.close());
    upstream.on("error", () => client.terminate());
  });
  return new Promise((res) =>
    wss.on("listening", () => {
      const port = (wss.address() as { port: number }).port;
      res({ url: `ws://127.0.0.1:${port}`, arm: (p) => (plan = p), close: () => wss.close() });
    }),
  );
}
