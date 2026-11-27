// Probe device client: one WS per session, Noise initiator, then auth or pair, then req/res and events.
import { WebSocket } from "ws";
import { decodeJson, encodeJson, finishInitiator, startInitiator, type Transport } from "./noise/channel.ts";
import { b64u, deviceId, fromB64u, sign, type Identity } from "./identity.ts";

export type Conn = {
  ws: WebSocket;
  transport: Transport;
  /** Last plaintext auth/pair frame we sent (tests replay it elsewhere). */
  authFrame: unknown;
  request(method: string, path: string, body?: unknown): Promise<any>;
  onEvent: (f: any) => void;
  closed: Promise<{ code: number; reason: string }>;
  sendFrame(f: unknown): void;
};

export type ConnectOpts = {
  url: string; // ws://host:port/v1/peer?hub=... or the hub's direct ws://host:port
  hubPk: Uint8Array;
  id: Identity;
  pairSecret?: string;
  /** Replace the auth frame (tests). */
  authOverride?: unknown;
  timeoutMs?: number;
  /** Sees every WS message we send, ciphertext (tests capture them for replay). */
  tap?: (m: Uint8Array) => void;
};

export function connect(o: ConnectOpts): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(o.url, { maxPayload: 65535 });
    const rawSend = ws.send.bind(ws);
    const send = (m: Uint8Array) => (o.tap?.(m), rawSend(m));
    ws.binaryType = "nodebuffer";
    const purpose = o.pairSecret ? "pair" : "auth";
    let hs: ReturnType<typeof startInitiator>["hs"] | null = null;
    let conn: Conn | null = null;
    let nextId = 1;
    const waiting = new Map<number, (f: any) => void>();
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("timeout"));
    }, o.timeoutMs ?? 10_000);
    const closed = new Promise<{ code: number; reason: string }>((res) =>
      ws.on("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`closed ${code} ${reason}`));
        res({ code, reason: String(reason) });
      }),
    );
    ws.on("error", (e) => reject(e));
    ws.on("open", () => {
      const s = startInitiator(o.hubPk, { v: 1, role: "client", purpose });
      hs = s.hs;
      send(s.message);
    });
    let transport: Transport | null = null;
    const sendFrame = (f: unknown) => {
      for (const m of transport!.seal(encodeJson(f))) send(m);
    };
    ws.on("message", (data) => {
      const bytes = new Uint8Array(data as Buffer);
      try {
        if (!transport) {
          const r = finishInitiator(hs!, bytes);
          transport = r.transport;
          const challenge = fromB64u(r.hello.challenge);
          const frame =
            o.authOverride ??
            (purpose === "auth"
              ? { t: "auth", device_id: deviceId(o.id.publicKey), sig: sign(o.id, "auth", transport.handshakeHash, challenge) }
              : {
                  t: "pair",
                  secret: o.pairSecret,
                  public_key: b64u(o.id.publicKey),
                  name: "probe",
                  platform: "node",
                  sig: sign(o.id, "pair", transport.handshakeHash, challenge),
                });
          sendFrame(frame);
          conn = {
            ws,
            transport,
            authFrame: frame,
            onEvent: () => {},
            closed,
            sendFrame,
            request(method, path, body) {
              const id = nextId++;
              return new Promise((res) => {
                waiting.set(id, res);
                sendFrame({ t: "req", id, method, path, body });
              });
            },
          };
          return;
        }
        const raw = transport.open(bytes);
        if (!raw) return;
        const f = decodeJson(raw) as any;
        if (f.t === "res" && f.id === 0) {
          clearTimeout(timer);
          resolve(conn!);
        } else if (f.t === "res") {
          waiting.get(f.id)?.(f);
          waiting.delete(f.id);
        }
        else conn?.onEvent(f);
      } catch {
        ws.close(4400, "decrypt"); // fatal (02)
      }
    });
  });
}
