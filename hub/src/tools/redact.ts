// One redact() for everything that leaves the process or lands in a table (03 tools 「打码」): logs, run_items, the
// event stream, approval cards. Known values (secrets.env, keys/) plus the common key formats. Over-redacting a
// harmless look-alike is the accepted cost.
import { secretValues } from "../secrets.ts";

const MASK = "[已打码]";

// the usual shapes: provider keys, GitHub tokens, Slack tokens, PEM blocks, AWS access key ids, JWTs
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\brun_[A-Za-z0-9_-]{24}\b/g,   // our own run tokens (proxy.ts issueToken)
];

let known: string[] = [];
/** Re-read the known values from secrets.ts (after loadSecrets). Longest first so a value inside another is not split. */
export function refreshKnown(extra: string[] = []) {
  known = [...new Set([...secretValues(), ...extra])].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
}

export function redact(text: string): string {
  if (!text) return text;
  let out = text;
  for (const v of known) if (out.includes(v)) out = out.split(v).join(MASK);
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out;
}

/** Deep-redact the strings inside a JSON-able value (tool args, card fields). */
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as T;
  if (Array.isArray(v)) return v.map(redactDeep) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

/**
 * Streaming text (§触6.4): deltas are held and released in batches (every `ms`, 50–100) cut at the last newline or
 * whitespace, so a secret split across two deltas is still whole when redact() sees it. A run of text with no
 * whitespace at all is released once it passes `hold` characters (a key is shorter than that).
 */
export class StreamRedactor {
  #buf = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #emit: (text: string) => void;
  readonly #ms: number;
  readonly #hold: number;
  constructor(emit: (text: string) => void, ms = 80, hold = 4096) { this.#emit = emit; this.#ms = ms; this.#hold = hold; }

  push(delta: string) {
    this.#buf += delta;
    this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#release(false); }, this.#ms);
  }

  /** Everything still held goes out now (end of the message). */
  flush() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    this.#release(true);
  }

  #release(all: boolean) {
    if (!this.#buf) return;
    let cut = this.#buf.length;
    if (!all) {
      const ws = Math.max(this.#buf.lastIndexOf("\n"), this.#buf.lastIndexOf(" "), this.#buf.lastIndexOf("\t"));
      cut = ws >= 0 ? ws + 1 : this.#buf.length > this.#hold ? this.#buf.length : 0;
    }
    if (cut === 0) {   // nothing safe to cut yet: look again next batch
      this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#release(false); }, this.#ms);
      return;
    }
    const out = this.#buf.slice(0, cut);
    this.#buf = this.#buf.slice(cut);
    try { this.#emit(redact(out)); } catch { /* a listener's error never breaks the run */ }
    if (this.#buf && !all) this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#release(false); }, this.#ms);
  }
}
