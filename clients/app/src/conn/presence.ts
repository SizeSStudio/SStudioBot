// Presence (protocol/api/push.ts PresenceReq, DESIGN §触1.1, 07 「在场」): while the app is in front and I touch, type
// or scroll, at most every 30 s `{ foreground: true, viewing }`; at once `{ foreground: false }` when it goes to the
// back. Opening another thread or card sends at once (at most every 2 s ※), so what's on screen isn't pushed to me.
// Back on a connection: say where we are again (the hub keeps presence in memory only).
// Plain TS; ui/presence.tsx wires the platform's AppState and input events to it.
import type { PresenceReq } from "../../../../protocol/api/push.ts";

export const PRESENCE_EVERY_MS = 30_000;
export const VIEWING_EVERY_MS = 2_000;

export class Presence {
  #send: (p: PresenceReq) => unknown;
  #now: () => number;
  #foreground = true;
  #viewing: string | null = null;
  #lastSent = -Infinity;
  #lastViewingSent = -Infinity;
  #sentViewing: string | null | undefined = undefined;
  #sentForeground: boolean | undefined = undefined;
  #later: unknown = null;
  #subs = new Set<() => void>();
  #setTimeout: (fn: () => void, ms: number) => unknown;
  #clearTimeout: (t: unknown) => void;

  constructor(d: { send: (p: PresenceReq) => unknown; now?: () => number; setTimeout?: (fn: () => void, ms: number) => unknown; clearTimeout?: (t: unknown) => void }) {
    this.#send = d.send;
    this.#now = d.now ?? Date.now;
    this.#setTimeout = d.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.#clearTimeout = d.clearTimeout ?? ((t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get viewing(): string | null { return this.#viewing; }
  get isForeground(): boolean { return this.#foreground; }
  subscribe = (fn: () => void): (() => void) => { this.#subs.add(fn); return () => this.#subs.delete(fn); };

  /** a touch, a key, a scroll */
  activity(): void {
    if (!this.#foreground) return;
    if (this.#now() - this.#lastSent >= PRESENCE_EVERY_MS) this.#emit();
  }

  /** the ref on screen now (thread:<id>, approval:<id>), or null */
  view(ref: string | null): void {
    if (ref === this.#viewing) return;
    this.#viewing = ref;
    if (!this.#foreground) return;
    const wait = VIEWING_EVERY_MS - (this.#now() - this.#lastViewingSent);
    if (wait <= 0) return this.#emit();
    // a burst of screen changes: send the last one when the window opens
    if (this.#later === null) this.#later = this.#setTimeout(() => { this.#later = null; if (this.#foreground && this.#viewing !== this.#sentViewing) this.#emit(); }, wait);
  }

  foreground(on: boolean): void {
    if (on === this.#foreground) return;
    this.#foreground = on;
    for (const f of this.#subs) f();
    if (!on) { this.#cancel(); this.#emit(); return; }
    this.#emit();
  }

  /** the connection is live again: the hub forgot us */
  reconnected(): void { this.#lastSent = -Infinity; this.#sentViewing = undefined; this.#sentForeground = undefined; if (this.#foreground) this.#emit(); }

  #emit(): void {
    const now = this.#now();
    this.#lastSent = now;
    if (this.#viewing !== this.#sentViewing) this.#lastViewingSent = now;
    this.#sentViewing = this.#viewing;
    this.#sentForeground = this.#foreground;
    this.#send(this.#foreground ? { foreground: true, viewing: this.#viewing } : { foreground: false });
  }

  #cancel(): void { if (this.#later !== null) { this.#clearTimeout(this.#later); this.#later = null; } }

  /** for tests */
  get sentForeground(): boolean | undefined { return this.#sentForeground; }
}
