// 在场 (§触1.1, 03 push): per client device, the last POST /api/v1/presence. Memory only (04: 在场不落表) — after a
// restart nobody is here until a client says so, which errs toward pushing.
export interface Seen { foreground: boolean; viewing: string | null; at: number }

export class Presence {
  readonly #by = new Map<string, Seen>();
  /** gate.yaml push.presence, read on every call so a config edit applies at once */
  readonly #conf: () => { enabled: boolean; away_seconds: number };

  constructor(conf: () => { enabled: boolean; away_seconds: number }) { this.#conf = conf; }

  report(device: string, p: { foreground: boolean; viewing?: string | null }, now = Date.now()) {
    this.#by.set(device, { foreground: p.foreground, viewing: p.foreground ? (p.viewing ?? null) : null, at: now });
  }

  /** a removed device is gone at once */
  forget(device: string) { this.#by.delete(device); }

  #live(now: number): Seen[] {
    const c = this.#conf();
    if (!c.enabled) return [];
    return [...this.#by.values()].filter((s) => s.foreground && now - s.at < c.away_seconds * 1000);
  }

  /** any one client in front with input in the last away_seconds = I am here (per person, not per device) */
  present(now = Date.now()): boolean { return this.#live(now).length > 0; }

  /** refs on screen of the clients that count as here */
  viewing(now = Date.now()): Set<string> {
    return new Set(this.#live(now).map((s) => s.viewing).filter((v): v is string => !!v));
  }
}
