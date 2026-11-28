// The §触1.1 route table as code (03 push: "急不急、占不占额度由代码按 cat 查表定，模型说了不算"). One row per
// push_queue.cat. Night handling for urgent rows also reads gate.yaml push.night_allow (§触1.1 「都是默认值，可配」).
import type { PushChannel } from "../../../protocol/api/push.ts";

export interface CatRule {
  /** D1: FCM and the channel both, no receipt */
  urgent: boolean;
  /** counts against §寸2 proactive_daily_cap once sent ※ (what it starts on its own; what I asked for or must answer doesn't) */
  quota: boolean;
  /** 对话中先等: wait for quiet_minutes after my last line, at most max_delay_minutes */
  waitQuiet: boolean;
  /** §寸6: still pushed while 省心 is on */
  ease: boolean;
  /** the outlet group the channel line goes to */
  outlet: "main" | "admin";
  /** the Android channel (07) */
  channel: PushChannel;
  /** 补推: may it go out later (walked away, morning)? false: once its moment is gone it stays in 看 */
  replay: boolean;
  /** at night: moved to the night's end instead of the morning batch (它自己定的 follow-up) */
  nightToEnd?: true;
}

const R = (urgent: boolean, quota: boolean, waitQuiet: boolean, ease: boolean, outlet: "main" | "admin", channel: PushChannel, replay = true, extra: Partial<CatRule> = {}): CatRule =>
  ({ urgent, quota, waitQuiet, ease, outlet, channel, replay, ...extra });

export const TABLE: Readonly<Record<string, CatRule>> = {
  ask: R(true, false, false, true, "main", "wait"),
  approval: R(true, false, false, true, "main", "approval"),
  owner_followup: R(true, false, false, true, "main", "wait"),
  due_ask: R(true, false, false, true, "main", "wait"),
  alert_security: R(true, false, false, true, "admin", "fyi"),
  task: R(true, false, false, true, "main", "task"),               // a task I started got stuck: it asks me
  agent_followup: R(false, true, true, false, "main", "wait", true, { nightToEnd: true }),
  alert_ops: R(false, false, true, true, "admin", "fyi"),
  notice: R(false, true, true, false, "main", "fyi"),
  task_end: R(false, false, true, true, "main", "task"),
  morning: R(false, false, true, true, "main", "fyi"),
  tidy: R(false, true, true, false, "main", "fyi", false),
  fyi: R(false, true, true, false, "main", "fyi", false),
  suggestion: R(false, true, true, false, "main", "fyi", false),
  reflect: R(false, true, true, true, "main", "fyi"),             // 周、月复盘省心时照开（轻一点）
};

/** An unknown cat is the quietest kind: not urgent, counts, waits, held while 省心 is on. */
export const ruleOf = (cat: string): CatRule => TABLE[cat] ?? R(false, true, true, false, "main", "fyi", false);

/** What a personal push may say (§读5.1): nothing of the content. */
export const PRIVATE_FCM = "有一条私人的";
export const PRIVATE_CHANNEL = "客户端有新消息";
