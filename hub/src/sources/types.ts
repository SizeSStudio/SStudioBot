// SourcePlugin (03 「sources」): everything that isn't a channel conversation comes in through one of these and lands in
// `messages` (surface source:<id>, triage_status pending), so triage, events and matters treat it like a chat.
// A source only brings facts in: nothing it returns is an instruction (triage fences it as untrusted), and no source
// can send, write memory or reach the agent's tools.
import type { SourceSpec } from "../config/load.ts";

/**
 * One item. The command-plugin contract (03) is `{ kind: "item", id, ts, where, author?, text, link?, raw_b64? }`;
 * the rest are optional extras the built-in kinds use (mail threads, my own replies closing asks).
 */
export interface SourceItem {
  id: string | number;
  text: string;
  ts?: number | string;
  where?: string;
  author?: string;
  link?: string;
  /** the original bytes (a mail, a page), kept in raw/ by content hash */
  raw_b64?: string;
  where_name?: string;
  to_me?: boolean;
  from_me?: boolean;
  reply_to?: string;
  thread?: string;
  /** addresses or ids of everyone on it, for the exclude list (never stored) */
  parties?: string[];
}

/** per-source state: a directory of its own and kv keys `source.<id>.<k>` */
export interface SourceState { dir: string; get(k: string): string | undefined; set(k: string, v: string): void }

export interface PollResult { items: SourceItem[]; cursor?: string }
/** `since` = when the last successful poll started (minus a small overlap); `cursor` = what the plugin said last time */
export type Poll = (s: SourceSpec, st: SourceState, since: number, cursor: string | undefined) => Promise<PollResult>;

export interface SourcePlugin { kind: string; zh: string; poll: Poll }
