// The sbot Noise channel (02): NK handshake with our prologue and JSON payloads, then transport
// messages carrying fragmented application frames. Every error is fatal: the channel dies and the
// caller closes the socket. No rekey (2^64 messages per channel is out of reach).
import {
  createNoiseInitiator,
  createNoiseResponder,
  NoiseProtocolError,
  NOISE_MAX_MESSAGE_BYTES,
  type CipherState,
  type NoiseHandshake,
  type NoiseKeyPair,
} from "./handshake.ts";
import { fragment, Reassembler, FRAME_MAX, PIECE_MAX } from "../fragment.ts";

export { generateNoiseKeyPair, NoiseProtocolError, type NoiseKeyPair } from "./handshake.ts";

export const PROLOGUE = new TextEncoder().encode("sbot-noise/1");
export const MAX_FRAME_BYTES = FRAME_MAX;
/** Plaintext bytes per piece: one Noise message minus the tag and the 1-byte flag. */
export const MAX_PIECE_DATA = PIECE_MAX;
const EMPTY = new Uint8Array(0);

export type ClientHello = { v: number; role: "client" | "node"; purpose: "auth" | "pair" };
export type HubHello = { v: number; challenge: string; hub_time: number };

export class Transport {
  readonly handshakeHash: Uint8Array;
  private send: CipherState | null;
  private receive: CipherState | null;
  private reassembler = new Reassembler();

  constructor(keys: { send: CipherState; receive: CipherState }, handshakeHash: Uint8Array) {
    this.send = keys.send;
    this.receive = keys.receive;
    this.handshakeHash = handshakeHash;
  }

  /** One application frame → one or more Noise messages (one WS message each). */
  seal(frame: Uint8Array): Uint8Array[] {
    const send = this.alive(this.send);
    if (frame.byteLength > MAX_FRAME_BYTES) throw new NoiseProtocolError("frame too large");
    return fragment(frame).map((piece) => send.encryptWithAd(EMPTY, piece));
  }

  /** Returns the whole frame on its last piece, null while more are due. Throws (fatally) on anything wrong. */
  open(message: Uint8Array): Uint8Array | null {
    const receive = this.alive(this.receive);
    try {
      if (message.byteLength > NOISE_MAX_MESSAGE_BYTES) throw new NoiseProtocolError("message too large");
      return this.reassembler.push(receive.decryptWithAd(EMPTY, message));
    } catch (err) {
      this.destroy();
      throw err instanceof NoiseProtocolError ? err : new NoiseProtocolError(err instanceof Error ? err.message : String(err));
    }
  }

  destroy(): void {
    this.send?.clear();
    this.receive?.clear();
    this.send = null;
    this.receive = null;
    this.reassembler = new Reassembler();
  }

  private alive(c: CipherState | null): CipherState {
    if (!c) throw new NoiseProtocolError("channel closed");
    return c;
  }
}

/** Initiator (device or node). `hubPublicKey` comes from the pairing code. */
export function startInitiator(hubPublicKey: Uint8Array, hello: ClientHello): { hs: NoiseHandshake; message: Uint8Array } {
  const hs = createNoiseInitiator({ remoteStatic: hubPublicKey, prologue: PROLOGUE });
  return { hs, message: hs.writeMessage(encodeJson(hello)) };
}

export function finishInitiator(hs: NoiseHandshake, message: Uint8Array): { transport: Transport; hello: HubHello } {
  const hello = decodeJson(hs.readMessage(message)) as HubHello;
  if (typeof hello?.challenge !== "string" || typeof hello.v !== "number") throw new NoiseProtocolError("bad hub hello");
  const hash = hs.handshakeHash();
  return { transport: new Transport(hs.split(), hash), hello };
}

/** Responder (hub): reads message 1, replies with message 2 carrying a fresh challenge. */
export function respond(
  hubKey: NoiseKeyPair,
  message: Uint8Array,
  makeHello: (client: ClientHello) => HubHello,
): { transport: Transport; client: ClientHello; hello: HubHello; reply: Uint8Array } {
  const hs = createNoiseResponder({ localStatic: hubKey, prologue: PROLOGUE });
  const client = decodeJson(hs.readMessage(message)) as ClientHello;
  if (typeof client?.v !== "number") throw new NoiseProtocolError("bad client hello");
  if (client.role !== "client" && client.role !== "node") throw new NoiseProtocolError("bad role");
  if (client.purpose !== "auth" && client.purpose !== "pair") throw new NoiseProtocolError("bad purpose");
  const hello = makeHello(client);
  const reply = hs.writeMessage(encodeJson(hello));
  const hash = hs.handshakeHash();
  return { transport: new Transport(hs.split(), hash), client, hello, reply };
}

export function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new NoiseProtocolError("bad json");
  }
}
