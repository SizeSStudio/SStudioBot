// Phone notifications (07 「安卓」, protocol/api/push.ts): the FCM token goes to the hub, four channels, a tap opens
// sstudiobot://item/<ref>. Plain TS: the platform part (expo-notifications) is in notify.native.ts behind TokenSource,
// so the rules here run under node --test with a fake.
//
// Behind the hub's answer ※: a device that never gave a token first asks with `{ token: null }` (clears nothing: it has
// none) and only when the hub says `fcm_enabled` asks Android for the permission and the token. A build without
// google-services.json (no Firebase project yet) never touches FCM at all.
import { PushData, PushTokenRes, type PushChannel } from "../../../../protocol/api/push.ts";

export const PRIVATE_TEXT = "有一条私人的";

/** The four channels (07); the user can retune each in Android's settings. */
export const CHANNELS: readonly { id: PushChannel; name: string; importance: "high" | "default" | "low" }[] = [
  { id: "wait", name: "等我回", importance: "high" },
  { id: "approval", name: "审批", importance: "high" },
  { id: "task", name: "任务", importance: "default" },
  { id: "fyi", name: "知道就好", importance: "low" },
];

/** What a notification may say on this phone. `personal`: only 「有一条私人的」, whatever the payload carried. */
export function presentation(data: unknown, title: string | null, body: string | null): { title: string; body: string; ref: string | null; channel: PushChannel } {
  const d = PushData.safeParse(data);
  if (!d.success) return { title: "SStudioBot", body: "有新的", ref: null, channel: "fyi" };
  if (d.data.personal === "1") return { title: PRIVATE_TEXT, body: "", ref: d.data.ref, channel: d.data.channel };
  return { title: title ?? "SStudioBot", body: body ?? "", ref: d.data.ref, channel: d.data.channel };
}

/** Where a tap goes: the item page, which shows the hub's state for that ref, never the payload. */
export function tapRoute(data: unknown): string {
  const d = PushData.safeParse(data);
  return d.success ? `/item/${encodeURIComponent(d.data.ref)}` : "/";
}

/** The platform's FCM side (notify.native.ts; tests pass a fake). */
export interface TokenSource {
  /** false: not Android, or built without google-services.json */
  readonly available: boolean;
  /** Android 13+ asks; true = may show notifications */
  permission(): Promise<boolean>;
  token(): Promise<string>;
  onToken(cb: (t: string) => void): () => void;
}

/** The phone-notifications switch (an interface preference, kept on the device; 07 「store」). */
export interface PushPref { get(): Promise<boolean | null>; set(on: boolean): Promise<void> }

export type PushState =
  | { s: "unknown" }
  | { s: "unavailable" }
  /** I turned phone notifications off: pushes go to the channels */
  | { s: "off" }
  /** the hub has FCM off (console.yaml fcm.enabled): pushes go to the channels for now */
  | { s: "hub_off" }
  | { s: "denied" }
  | { s: "on" }
  | { s: "error"; why: string };

type Send = (token: string | null) => Promise<{ ok: boolean; body?: unknown; error?: string }>;

export class PushRegistrar {
  state: PushState = { s: "unknown" };
  readonly #d: { source: TokenSource; pref: PushPref; send: Send; hasToken: () => boolean };
  #subs = new Set<() => void>();
  #unToken: (() => void) | null = null;
  #running: Promise<void> | null = null;

  constructor(d: { source: TokenSource; pref: PushPref; send: Send; hasToken: () => boolean }) {
    this.#d = d;
  }

  subscribe(fn: () => void): () => void { this.#subs.add(fn); return () => this.#subs.delete(fn); }

  /** On every `live`, and when the switch changes. One at a time. */
  sync(): Promise<void> {
    this.#running ??= this.#sync().finally(() => { this.#running = null; });
    return this.#running;
  }

  async setEnabled(on: boolean): Promise<void> {
    await this.#d.pref.set(on);
    await this.#running?.catch(() => {});
    await this.sync();
  }

  async #sync(): Promise<void> {
    const { source, pref, send, hasToken } = this.#d;
    if (!source.available) return this.#set({ s: "unavailable" });
    try {
      if ((await pref.get()) === false) {
        this.#stopWatching();
        if (hasToken()) await send(null);
        return this.#set({ s: "off" });
      }
      if (!hasToken()) {
        const probe = await send(null);
        if (!probe.ok) return this.#set({ s: "error", why: probe.error ?? "" });
        if (!this.#fcmOn(probe.body)) return this.#set({ s: "hub_off" });
      }
      if (!(await source.permission())) {
        if (hasToken()) await send(null);
        return this.#set({ s: "denied" });
      }
      const r = await send(await source.token());
      if (!r.ok) return this.#set({ s: "error", why: r.error ?? "" });
      this.#unToken ??= source.onToken((t) => { void send(t); }); // the token changed: hand it over again
      this.#set(this.#fcmOn(r.body) ? { s: "on" } : { s: "hub_off" });
    } catch (e) {
      this.#set({ s: "error", why: e instanceof Error ? e.message : String(e) });
    }
  }

  #fcmOn(body: unknown): boolean { const p = PushTokenRes.safeParse(body); return p.success && p.data.fcm_enabled; }
  #stopWatching(): void { this.#unToken?.(); this.#unToken = null; }
  #set(s: PushState): void { this.state = s; for (const f of this.#subs) f(); }
}
