// The channel plugin contract (03 「channels」, veto 4). A plugin receives (messages, card clicks, recalls) and hands
// each one to ChannelHost.ingest, which only writes the inbox; it sends outbox rows with send(). The hub looks only at
// caps. The outbox (outbox.ts) finds plugins by name in registry.ts and calls send(); ChannelHost writes through inbox.ts.
import type { SQLInputValue } from "node:sqlite";

/** Where a reply goes: W1d's TurnContext (turn.ts), one definition. `channel` is the plugin id ("feishu", "client", …). */
import type { TurnContext } from "../turn.ts";
export type { TurnContext };

/** A row for `messages` (04 §5), written in the same tx as the inbox row. Only columns a channel knows at ingest. */
export interface MessageRow {
  id: string; surface: string; chat_id?: string; thread_id?: string; sender_id?: string;
  sender_kind: "owner" | "other" | "bot"; ts: number; text: string; raw?: Record<string, unknown>;
  domain?: "work" | "personal"; lane?: string | null; media_ref?: string;
}

export type InboxKind = "user" | "command" | "card" | "timer" | "system" | "approval" | "task";

export interface IngestItem {
  lane: string;
  kind: InboxKind;
  source: string;               // dedupe namespace: feishu | feishu:card | timer | job | …
  source_msg_id: string;        // UNIQUE(source, source_msg_id): message_id for messages, event_id for card clicks
  turn?: TurnContext;
  payload: Record<string, unknown>;
  device_id?: string;
  message?: MessageRow;         // also record it in `messages` (same tx)
}

export interface IngestResult { fresh: boolean; inboxId?: number }

export interface ChannelHost {
  /** Synchronous, one tx: messages row (if any) + inbox row. Duplicates are no-ops. Nothing else may happen in a 3 s callback. */
  ingest(item: IngestItem): IngestResult;
  /** a message that goes to triage only (groups, other people's DMs): `messages` row, no inbox row. true = new */
  record(msg: MessageRow): boolean;
  /** wake the inbox dispatcher after commits (W1d); a no-op until then */
  kick(): void;
}

/** An outbox row as the outbox (outbox.ts) hands it to send(): target already parsed, idem_key always set (04 §3). */
export interface OutboxRow {
  id: number; approval_id: number | null; run_id: string | null; lane: string | null; channel: string; kind: "text" | "card";
  card_id: string | null; as_identity: "bot" | "user"; target: Record<string, unknown>; payload: string; idem_key: string;
  send_by: number | null; attempts: number;
}

/**
 * What send() answers; the outbox acts on it (outbox.ts): ok → sent; unknown → may have gone out, never retried
 * (§底3.3); retry:false → failed for good; otherwise retried with backoff. A throw counts as a retryable failure.
 * shadow = ok but nothing was sent (shadow mode only logged it).
 */
export type SendResult = { ok: true; msg_id?: string; shadow?: true } | { ok: false; error: string; retry?: boolean; unknown?: boolean };

/** Channel-neutral card model (03 「approvals」); each plugin renders it its own way. */
export interface CardOption { id: string; label: string; recommended?: boolean; cost?: string }
export interface Card {
  title: string;
  lines: string[];
  question?: string;
  options: CardOption[];
  detail?: { kind: "cmd" | "path" | "args" | "diff"; text: string; folded: boolean };
  /** what a click carries back (e.g. {k:"appr", id}); the option id is added as `o` */
  value?: Record<string, unknown>;
  tone?: "blue" | "green" | "orange" | "red" | "grey";
}

export interface StreamHandle {
  update(text: string): void;
  finish(text: string, footer?: string): Promise<void>;
  dispose(): Promise<void>;
  readonly started: boolean;
  readonly failed: boolean;
}

export interface ChannelCaps { cards: boolean; streaming?: boolean; userIdentityRead?: boolean; mail?: boolean; commands?: boolean }

export interface ChannelPlugin {
  readonly id: string;
  readonly caps: ChannelCaps;
  start(h: ChannelHost): Promise<void>;
  send(o: OutboxRow): Promise<SendResult>;
  render(card: Card): unknown;
  /** streaming reply card for one run; the plugin writes its own outbox row before sending (side effect, 03) */
  stream?(ctx: { runId: string; lane: string; turn: TurnContext }): StreamHandle;
  stop(): Promise<void>;
}

/** What the registry holds: the outbox needs only id, caps and send(); a full plugin also starts and stops. */
export type RegisteredChannel = Pick<ChannelPlugin, "id" | "caps" | "send"> & Partial<Omit<ChannelPlugin, "id" | "caps" | "send">>;

/** values for the ambient run() helpers; kept here so plugins need not import node:sqlite types themselves */
export type SqlArg = SQLInputValue;
