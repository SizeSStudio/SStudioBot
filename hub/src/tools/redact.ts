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
let knownNonAscii = false;
/** Re-read the known values from secrets.ts (after loadSecrets). Longest first so a value inside another is not split. */
export function refreshKnown(extra: string[] = []) {
  known = [...new Set([...secretValues(), ...extra])].filter((v) => v.length >= 8).sort((a, b) => b.length - a.length);
  knownNonAscii = known.some((v) => /[^\x00-\x7f]/.test(v));
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

// a cut point: whitespace, or a non-ASCII character that isn't the first half of a surrogate pair. Keys and the
// patterns above are ASCII, so none spans one; Chinese has no spaces, and cutting only at whitespace held a whole
// Chinese reply until the end of the message (W2 验收「逐字出现」).
const isWs = (c: number) => c === 0x0a || c === 0x20 || c === 0x09;
const isCut = (c: number) => isWs(c) || (c >= 0x80 && !(c >= 0xd800 && c <= 0xdbff));
const PEM_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** The last private-key block in `s`: where it starts and where its END line ends (-1 = not ended yet). */
function pemSpan(s: string): { b: number; e: number } | null {
  const b = s.lastIndexOf("-----BEGIN");
  if (b < 0) return null;
  const rest = s.slice(b);
  const open = /^-----BEGIN [A-Z0-9 ]*-----/.exec(rest);
  // the marker still coming in could be a key's
  if (!open) return /^-----BEGIN[A-Z0-9 ]*-{0,4}$/.test(rest) ? { b, e: -1 } : null;
  if (!open[0].endsWith("PRIVATE KEY-----")) return null;
  const end = PEM_END.exec(rest);
  return { b, e: end ? b + end.index + end[0].length : -1 };
}

/**
 * Streaming text (§触6.4): deltas are held and released in batches (every `ms`, 50–100) cut at the last whitespace
 * or non-ASCII character, so a secret split across two deltas is still whole when redact() sees it. A run with no
 * cut point is released once it passes `hold` characters (a key is shorter than that). A private-key block is never
 * cut: held until its END line; one longer than `hold` goes out masked and what follows is dropped up to END.
 */
export class StreamRedactor {
  #buf = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #emit: (text: string) => void;
  readonly #ms: number;
  readonly #hold: number;
  /** inside a key block that went out (masked) before its END: drop until END; `#tail` catches an END split in two */
  #inPem = false;
  #tail = "";
  constructor(emit: (text: string) => void, ms = 80, hold = 4096) { this.#emit = emit; this.#ms = ms; this.#hold = hold; }

  push(delta: string) {
    this.#buf += delta;
    this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#release(false); }, this.#ms);
  }

  /** Everything still held goes out now (end of the message). */
  flush() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = undefined; }
    this.#release(true);
    this.#inPem = false; this.#tail = "";
  }

  #release(all: boolean) {
    if (this.#inPem) {
      const seen = this.#tail + this.#buf;
      const end = PEM_END.exec(seen);
      if (!end) { this.#tail = seen.slice(-64); this.#buf = ""; return; }
      this.#buf = seen.slice(end.index + end[0].length);
      this.#inPem = false; this.#tail = "";
    }
    if (!this.#buf) return;
    let cut = this.#buf.length;
    if (!all) {
      const span = pemSpan(this.#buf);
      // the cut goes before an open key block, or after a closed one, never inside
      const lo = span && span.e >= 0 ? span.e : 0, hi = span && span.e < 0 ? span.b : this.#buf.length;
      const any = !knownNonAscii;   // a known value with non-ASCII in it: whitespace only
      let i = hi - 1;
      for (; i >= lo; i--) { const c = this.#buf.charCodeAt(i); if (any ? isCut(c) : isWs(c)) break; }
      cut = i >= lo ? i + 1 : lo > 0 ? lo : this.#buf.length > this.#hold ? this.#buf.length : 0;
    }
    if (cut === 0) {   // nothing safe to cut yet: look again next batch
      this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#release(false); }, this.#ms);
      return;
    }
    const out = this.#buf.slice(0, cut);
    this.#buf = this.#buf.slice(cut);
    // only past `hold`: a key block goes out unfinished; redact() masks it to the end of the piece, the rest is dropped
    if (!all && pemSpan(out)?.e === -1) this.#inPem = true;
    try { this.#emit(redact(out)); } catch { /* a listener's error never breaks the run */ }
    if (this.#buf && !all) this.#timer ??= setTimeout(() => { this.#timer = undefined; this.#release(false); }, this.#ms);
  }
}
