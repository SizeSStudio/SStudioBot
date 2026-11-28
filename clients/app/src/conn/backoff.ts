// Reconnect delays (06, 07): 1, 2, 5, 10, 30 s, then 30 s for good. Back to the start once a stream is live.
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class Backoff {
  #n = 0;
  next(): number { return BACKOFF_MS[Math.min(this.#n++, BACKOFF_MS.length - 1)]!; }
  reset(): void { this.#n = 0; }
  get attempts(): number { return this.#n; }
}
