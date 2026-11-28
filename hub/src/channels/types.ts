// The channel plugin contract (03 「channels」, veto 4). A plugin receives (messages, card clicks, recalls) and hands
// each one to ChannelHost.ingest, which only writes the inbox; it sends outbox rows with send(). The hub looks only at
// caps. W1d's outbox finds plugins by name in registry.ts and calls send(); W1d's inbox replaces inbox-port.ts.
import type { SQLInputValue } from "node:sqlite";

/** Where a reply goes (03 「inbox 和 run」). `chat`/`thread` are the channel's own ids. */
export interface TurnContext {
  lane: string;
  surface: string;              // feishu:dm | feishu:group | feishu:workbench | console | …
  chat?: string;
  thread?: string;
  msg_id?: string;              // the triggering message, when replies should quote it
  src: string;                  // owner@<surface> | job@<name> | system@<kind> | other@<surface>
  device_id?: string;
}

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

/** outbox row as W1d's outbox hands it over (04 §3) */
export interface OutboxRow {
  id: number; approval_id?: number | null; run_id?: string | null; lane?: string | null;
  channel: string; kind: "text" | "card"; card_id?: string | null; as_identity: "bot" | "user";
  target_json: string; payload: string; idem_key?: string | null; attempts?: number;
}

/** msg_id null = the channel accepted it but gave no id. shadow = not sent at all (shadow mode logged it). */
export interface SendResult { msg_id: string | null; shadow?: boolean }

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

export interface ChannelCaps { cards: boolean; streaming: boolean; userIdentityRead: boolean; mail: boolean; commands: boolean }

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

/** values for the ambient run() helpers; kept here so plugins need not import node:sqlite types themselves */
export type SqlArg = SQLInputValue;
