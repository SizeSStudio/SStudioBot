// What the Feishu plugin needs from a bot-identity backend (P9). sdk.ts is the real one; tests use a fake. Keeping the
// SDK behind this seam is what lets P9's open items (08: real-app click delivery, reconnect) change the backend
// without touching ingest or send.
import type { Say } from "./logger.ts";

export type Toast = { toast: { type: "info" | "success" | "error" | "warning"; content: string } };
export type { Say };

/** One event off the long connection, already flattened (field mapping from P9). */
export interface Incoming {
  kind: "card" | "message";
  eventId: string;
  messageId?: string;          // message: the message itself; card: the message carrying the card
  operatorId?: string;         // card: operator open_id; message: sender open_id
  senderType?: string;         // message: user | app
  chatId?: string;
  chatType?: string;           // p2p | group
  messageType?: string;
  content?: string;            // message: the raw `content` JSON string
  threadId?: string;
  rootId?: string;
  createTime?: number;         // ms
  value?: unknown;             // card: action.value
}

/** The handler's return value is the card callback response; the SDK acks after it resolves, so it must be quick. */
export type Handler = (e: Incoming) => Promise<Toast | void> | Toast | void;

export interface Backend {
  start(h: Handler, life: { ready(): void; reconnected(): void; error(msg: string): void }): Promise<void>;
  /** returns the response `data`; throws ApiError whose message is already free of secrets */
  api(method: string, path: string, data?: unknown, params?: Record<string, string>): Promise<any>;
  state(): string;
  close(): Promise<void>;
}
