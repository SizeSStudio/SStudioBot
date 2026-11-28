// zod schemas for the config repo files (DESIGN §触5.3; key changes Y11 in docs/tech/03 「配置键变化」). Every save is
// validated against these before it is written. Unknown keys pass through, so a newer file never breaks an older hub.
// Changing a key = change this file, form-specs.ts and widening.ts in the same PR; hub/test/config.test.ts fails when
// the schema and the form drift apart in either direction.
import { z } from "zod";
import { birthIssues } from "./birth.ts";

const price = z.object({ in: z.number().min(0), out: z.number().min(0), cache_read: z.number().min(0).optional(), cache_write: z.number().min(0).optional() });
const tier = z.object({
  endpoint: z.string().min(1), model: z.string().min(1), price: price.optional(),
  context: z.number().int().positive().optional(), max_tokens: z.number().int().positive().optional(),
  // R7: a per-day alert line in calls; reaching it alerts and the tier keeps working (03 proxy 「预算只告警」)
  daily_alert: z.number().int().min(0).optional(),
}).passthrough();
const activation = z.enum(["always", "when_mentioned", "digest", "disabled"]);
const hhmm = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "HH:MM");
const waitMin = z.number().min(0).max(1440);   // past a day the morning report has already told me
const secretName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/** §触1.1 route-table categories (04 push_queue.cat) plus the two night_allow names the design uses (07-touch 「push」) */
export const PUSH_CATS = [
  "ask", "approval", "owner_followup", "agent_followup", "alert_security", "alert_ops", "notice", "task_end", "morning",
  "tidy", "fyi", "suggestion", "reflect", "task", "due_ask",
] as const;
export const DEFAULT_SENSITIVE_WORDS = ["HR", "人事", "薪酬", "绩效", "财务", "法务", "董事会"];

/** Defaults as the code reads them; never wider than what ran before (docs/tech 「底线」: entries and permissions off). */
export const DEFAULTS = {
  gate: {
    sensitive_words: DEFAULT_SENSITIVE_WORDS, approval_ttl_hours: 12, send_by_hours: 2, proactive_daily_cap: 6,
    improve_alert_usd: 3, attention: { wait_minutes: 30, escalate_wait_minutes: 0 },
    // §底3.4 稳住对方: fixed lines (never model text) the other side gets when a reply waits for my approval, and when it times out ※
    hold_text: "收到～这个我得先确认一下，晚点回你。", hold_timeout_text: "不好意思，这个我晚点亲自回你。",
    push: {
      quiet_minutes: 5, max_delay_minutes: 30, night: { from: "22:30", to: "08:00", awake_minutes: 30 },
      night_allow: ["owner_followup", "task", "due_ask", "alert_security"] as string[],
      presence: { enabled: true, away_seconds: 180 }, snooze_tonight: "20:00", suggestions: { agent_daily: 3, expire_days: 7 },
    },
  },
  models: { run_output_tokens: 60000, expert_daily_alert: 20 },
  dream: { max_delete: 0.2, max_add: 6, archive_days: 90 },
  measure: {
    fade_days: 180, see_off_after: 3, restore_after: 2,
    settle: { matter_quiet_days: 90, topic_days: 14, followup_days: 90, ledger_days: 90 },
    ease_flip: 2, infer_min_convs: 2, dismiss_window: 50, breaker: 3, stuck_minutes: 20, tidy_wait_minutes: 30,
  },
  console: { relay: { enabled: false }, mcp_open: false, fcm: { enabled: false } },
  sources: { feishu: { dm: false } },
  channels: { outlets: { main: ["client", "feishu:dm"], admin: ["client", "feishu:chat:admin"] } },
};

const pushSchema = z.object({
  quiet_minutes: z.number().min(0).optional(),
  max_delay_minutes: z.number().min(0).optional(),
  night: z.object({ from: hhmm.optional(), to: hhmm.optional(), awake_minutes: z.number().min(0).optional() }).passthrough().optional(),
  night_allow: z.array(z.enum(PUSH_CATS)).optional(),
  presence: z.object({ enabled: z.boolean().optional(), away_seconds: z.number().int().min(0).optional() }).passthrough().optional(),
  snooze_tonight: hhmm.optional(),
  suggestions: z.object({ agent_daily: z.number().int().min(0).optional(), expire_days: z.number().int().min(1).optional() }).passthrough().optional(),
}).passthrough();

const settle = z.object({
  matter_quiet_days: z.number().int().min(1).optional(), topic_days: z.number().int().min(1).optional(),
  followup_days: z.number().int().min(1).optional(), ledger_days: z.number().int().min(1).optional(),
}).passthrough();
// ranges kept from the old top-level keys; the new knobs only need to make sense (no upper limits nobody asked for)
const fadeDays = z.number().int().min(30).max(3650), seeOff = z.number().int().min(2).max(10), restore = z.number().int().min(1).max(10);
const measure = z.object({
  fade_days: fadeDays.optional(), see_off_after: seeOff.optional(), restore_after: restore.optional(), settle: settle.optional(),
  ease_flip: z.number().int().min(1).optional(), infer_min_convs: z.number().int().min(1).optional(),
  dismiss_window: z.number().int().min(1).optional(), breaker: z.number().int().min(1).optional(),
  stuck_minutes: z.number().min(1).optional(), tidy_wait_minutes: z.number().min(0).optional(),
}).passthrough();

const outlet = z.string().regex(/^(client|[a-z][a-z0-9_-]*(:[A-Za-z0-9_:.-]+)?)$/, "client 或 渠道[:目标]，比如 feishu:dm");

export const SCHEMAS: Record<string, z.ZodType> = {
  "models.yaml": z.object({
    endpoints: z.record(z.string(), z.object({ base_url: z.string().min(1), auth: z.enum(["bearer", "x-api-key"]), key_ref: secretName }).passthrough()),
    tiers: z.object({ chat: tier, work: tier, light: tier, expert: tier.optional() }).passthrough(),
    // R7: both are alert lines now; nothing is refused when they are reached
    budgets: z.object({ run_output_tokens: z.number().int().positive().optional(), daily_cost: z.number().positive().optional() }).passthrough().optional(),
  }).passthrough().superRefine((m, ctx) => {
    for (const [name, t] of Object.entries(m.tiers ?? {}) as [string, { endpoint?: string } | undefined][])
      if (t?.endpoint && !m.endpoints?.[t.endpoint]) ctx.addIssue({ code: "custom", path: ["tiers", name, "endpoint"], message: `no endpoint named ${t.endpoint}` });
  }),
  "people.yaml": z.object({
    // which channel IDs are me. Feishu is one channel among others (§触6.6), so no ID is required; none = nobody is me there
    owner: z.object({ name: z.string().optional(), ids: z.object({ feishu: z.string().regex(/^ou_/).optional(), wechat: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
  }).passthrough(),
  "groups.yaml": z.object({
    reviewed: z.boolean().optional(), default: activation.optional(),
    groups: z.record(z.string().regex(/^oc_/), z.object({ name: z.string().optional(), activation: activation.optional(), reply: z.string().optional() }).passthrough()).nullable().optional(),
  }).passthrough(),
  "gate.yaml": z.object({
    sensitive_words: z.array(z.string().min(1)).optional(), approval_ttl_hours: z.number().positive().optional(), send_by_hours: z.number().positive().optional(),
    proactive_daily_cap: z.number().int().min(0).optional(),
    hold_text: z.string().min(1).max(500).optional(), hold_timeout_text: z.string().min(1).max(500).optional(),   // §底3.4
    improve_alert_usd: z.number().min(0).optional(),   // R7: replay alert line; the replay always finishes
    // §读2.4: how long a raised message waits for me to respond by myself; places: chat_id | source id | source:where | feishu_dm
    attention: z.object({ wait_minutes: waitMin.optional(), escalate_wait_minutes: waitMin.optional(), places: z.record(z.string().min(1), waitMin).nullable().optional() }).passthrough().nullable().optional(),
    push: pushSchema.optional(),   // §触1.1
    // still accepted (LEGACY below): improve_budget_usd → improve_alert_usd; expert_daily_limit → models tiers.expert.daily_alert;
    // daily_budget_usd → merged into models budgets.daily_cost (the smaller alert wins)
    improve_budget_usd: z.number().min(0).optional(),
    expert_daily_limit: z.number().int().min(0).optional(),
    daily_budget_usd: z.number().positive().optional(),
  }).passthrough(),
  "jobs.yaml": z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.object({
    every: z.enum(["day", "week", "month"]), at: hhmm, weekday: z.number().int().min(0).max(6).optional(), day: z.number().int().min(1).max(31).optional(),
    do: z.string().min(1), lane: z.string().optional(), text: z.string().optional(), quota: z.boolean().optional(),
    enabled: z.boolean().optional(), retry_hours: z.number().positive().optional(),
    // 03 timers 「check 契约」: run on the local node first; exit 0 with no output = nothing to do, skip the model
    check: z.string().min(1).optional(),
    // dream (§读1.3): share of lines one night may delete, net lines it may add, days .archive/ keeps
    max_delete: z.number().min(0).max(1).optional(), max_add: z.number().int().min(0).optional(), archive_days: z.number().int().min(0).optional(),
  }).passthrough()).nullable(),
  "repos.yaml": z.record(z.string(), z.object({ url: z.string().min(1), branch: z.string().optional() }).passthrough()).nullable(),
  // 06 「开关」: every switch here opens something to the outside, so all default off and turning one on is a widening
  "console.yaml": z.object({
    relay: z.object({ enabled: z.boolean().optional(), url: z.string().regex(/^wss:\/\/[^\s/]+\/\S*$/, "wss://主机名/路径").optional() }).passthrough().optional(),
    mcp_open: z.boolean().optional(),
    fcm: z.object({ enabled: z.boolean().optional() }).passthrough().optional(),
  }).passthrough(),
  // 03 「outbox 和出口组」: replaces feishu.yaml. Chat ids are instance data and live only on the server.
  "channels.yaml": z.object({
    outlets: z.object({ main: z.array(outlet).optional(), admin: z.array(outlet).optional() }).catchall(z.array(outlet)).optional(),
    feishu: z.object({
      admin_chat: z.string().regex(/^oc_/).optional(), workbench_chat: z.string().regex(/^oc_/).optional(),
      // 09 「测试 home 里的飞书」: shadow = no long connection, no card callbacks, send() only logs
      mode: z.enum(["live", "shadow"]).optional(),
    }).passthrough().nullable().optional(),
  }).passthrough(),
  // 03 backup: who can read the nightly backup (an age public key; the private key never touches the hub)
  "backup.yaml": z.object({
    recipient: z.string().regex(/^age1[0-9a-z]{58,}$/, "age 公钥，age1 开头").optional(),   // X25519 (62 chars) or the longer hybrid kind
    to_nodes: z.array(z.string().min(1)).optional(),
  }).passthrough(),
  // §读5.1, §寸3, §寸4, §寸8: birth data for the lenses and the measure defaults. Only I change these.
  "self.yaml": z.object({
    month: z.enum(["gregorian", "solar_term"]).optional(),
    measure: measure.optional(),
    // old top-level keys, still accepted (LEGACY); measure.* wins when both are set
    see_off_after: seeOff.optional(), restore_after: restore.optional(), fade_days: fadeDays.optional(),
    birth: z.object({}).passthrough().superRefine((b, ctx) => {
      for (const i of birthIssues(b)) ctx.addIssue({ code: "custom", path: [i.path], message: i.message });
    }).optional(),
    lenses: z.record(z.string(), z.object({
      enabled: z.boolean().optional(),
      profile: z.object({ cast: z.enum(["dayan", "coins", "time", "random"]).optional(), notes: z.string().max(500).optional() }).passthrough().optional(),
    }).passthrough()).optional(),
  }).passthrough().nullable(),
  // §读2.1 信息源
  "sources.yaml": z.object({
    feishu: z.object({ dm: z.boolean().optional() }).passthrough().nullable().optional(),
    sources: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, "小写字母开头，字母数字 _ -，2～32 个字符"), kind: z.enum(["git", "fetch", "command", "feishu-mail"]),
      every: z.string().regex(/^\d+[mhd]$/, "像 15m、2h、1d").optional(), domain: z.enum(["work", "personal"]).optional(), enabled: z.boolean().optional(),
      repo: z.string().optional(), url: z.string().regex(/^https?:\/\//, "http(s) 地址").optional(),
      run: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "插件目录名：小写字母数字 _ -").optional(),
      env: z.array(secretName).max(8).optional(), args: z.record(z.string(), z.any()).optional(),
    }).passthrough().superRefine((s, ctx) => {
      const need: Record<string, string> = { git: "repo", fetch: "url", command: "run" };
      const k = need[s.kind];
      if (k && !(s as Record<string, unknown>)[k]) ctx.addIssue({ code: "custom", path: [k], message: `${s.kind} 要写 ${k}` });
    })).nullable().optional(),
    // Y5: never read these, whatever else says so. Adding narrows; removing an entry is a widening
    exclude: z.object({ chats: z.array(z.string().min(1)).optional(), persons: z.array(z.string().min(1)).optional(), mails: z.array(z.string().min(1)).optional() }).passthrough().nullable().optional(),
  }).passthrough().nullable().superRefine((c, ctx) => {
    const ids = (c?.sources ?? []).map((s) => s.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["sources"], message: `id 重复：${dup}` });
  }),
};

export const CONFIG_FILES = Object.keys(SCHEMAS);
/** files whose root may be empty (a map of entries) */
export const NULLABLE_ROOT = new Set(["jobs.yaml", "repos.yaml"]);

/** Old keys the schema still accepts so an old file keeps parsing; the form leaves them out (form test skips them). */
export const LEGACY: Record<string, Record<string, string>> = {
  "gate.yaml": { improve_budget_usd: "改叫 improve_alert_usd", expert_daily_limit: "读成 models.yaml tiers.expert.daily_alert", daily_budget_usd: "并进 models.yaml budgets.daily_cost，取小的" },
  "self.yaml": { see_off_after: "改到 measure", restore_after: "改到 measure", fade_days: "改到 measure" },
};
/** Keys the schema names that have their own page instead of the generic form. */
export const OWN_PAGE: Record<string, Record<string, string>> = {
  "self.yaml": { birth: "生活 › 出生信息", lenses: "镜头设置" },
};

export function parseConfig(file: string, value: unknown) {
  const s = SCHEMAS[file];
  if (!s) throw new Error(`unknown config file ${file}`);
  return s.safeParse(value ?? (NULLABLE_ROOT.has(file) ? null : {}));
}
