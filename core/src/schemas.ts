// Schemas for the config repo files (DESIGN §10.3). The console validates every save against these before it writes;
// unknown keys pass through so a newer file never breaks an older core.

import { z } from "zod";

const price = z.object({ in: z.number().min(0), out: z.number().min(0), cache_read: z.number().min(0).optional(), cache_write: z.number().min(0).optional() });
const tier = z.object({ endpoint: z.string().min(1), model: z.string().min(1), price: price.optional(), context: z.number().int().positive().optional(), max_tokens: z.number().int().positive().optional() }).passthrough();
const activation = z.enum(["always", "when_mentioned", "digest", "disabled"]);
const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, "HH:MM");
const waitMin = z.number().min(0).max(1440);   // past a day the morning report has already told him

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
  "models.yaml": z.object({
    endpoints: z.record(z.string(), z.object({ base_url: z.string().min(1), auth: z.enum(["bearer", "x-api-key"]), key_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).passthrough()),
    tiers: z.object({ chat: tier, work: tier, light: tier, expert: tier.optional() }).passthrough(),
    budgets: z.object({ run_output_tokens: z.number().int().positive().optional(), daily_cost: z.number().positive().optional() }).passthrough().optional(),
  }).passthrough().superRefine((m, ctx) => {
    for (const [name, t] of Object.entries(m.tiers ?? {}) as [string, any][])
      if (t && !m.endpoints?.[t.endpoint]) ctx.addIssue({ code: "custom", path: ["tiers", name, "endpoint"], message: `no endpoint named ${t.endpoint}` });
  }),
  "people.yaml": z.object({
    owner: z.object({ name: z.string().optional(), ids: z.object({ feishu: z.string().regex(/^ou_/), wechat: z.string().optional() }).passthrough() }).passthrough(),
  }).passthrough(),
  "groups.yaml": z.object({
    reviewed: z.boolean().optional(), default: activation.optional(),
    groups: z.record(z.string().regex(/^oc_/), z.object({ name: z.string().optional(), activation: activation.optional(), reply: z.string().optional() }).passthrough()).nullable().optional(),
  }).passthrough(),
  "gate.yaml": z.object({
    sensitive_words: z.array(z.string().min(1)).optional(), approval_ttl_hours: z.number().positive().optional(), send_by_hours: z.number().positive().optional(),
    expert_daily_limit: z.number().int().min(0).optional(), proactive_daily_cap: z.number().int().min(0).optional(), daily_budget_usd: z.number().positive().optional(),
    improve_budget_usd: z.number().min(0).optional(),   // M7: per improve run (proposals + replay)
    // §4.3: how long a raised message waits for him to respond by himself; places: chat_id | source id | source:where | feishu_dm
    attention: z.object({ wait_minutes: waitMin.optional(), escalate_wait_minutes: waitMin.optional(), places: z.record(z.string().min(1), waitMin).nullable().optional() }).passthrough().nullable().optional(),
  }).passthrough(),
  "jobs.yaml": z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.object({
    every: z.enum(["day", "week", "month"]), at: hhmm, weekday: z.number().int().min(0).max(6).optional(), day: z.number().int().min(1).max(31).optional(),
    do: z.string().min(1), lane: z.string().optional(), text: z.string().optional(), quota: z.boolean().optional(),
  }).passthrough()).nullable(),
  "feishu.yaml": z.object({ admin_chat: z.string().regex(/^oc_/).optional(), workbench_chat: z.string().regex(/^oc_/).optional() }).passthrough(),
  "repos.yaml": z.record(z.string(), z.object({ url: z.string().min(1), branch: z.string().optional() }).passthrough()).nullable(),
  // web.origin turns on the public entrance (§10.1); the host itself is instance data, so it lives only in this file
  "console.yaml": z.object({
    owners: z.array(z.string().min(3)).min(1),
    web: z.object({ origin: z.string().regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/, "https://主机名，不带路径和结尾的 /") }).passthrough().optional(),
  }).passthrough(),
  // §15.9, §15.13: birth data for the lenses (M6) and the 送一程 thresholds; only the owner edits this file
  "self.yaml": z.object({
    month: z.enum(["gregorian", "solar_term"]).optional(),
    see_off_after: z.number().int().min(2).max(10).optional(), restore_after: z.number().int().min(1).max(10).optional(),
    // the lenses' raw input (M6). Copied read-only into a network-less lens run; never sent anywhere else.
    birth: z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/), place: z.string().optional(),
      longitude: z.number().optional(), gender: z.enum(["male", "female"]).optional(), calendar: z.enum(["solar", "lunar"]).optional(),
    }).passthrough().optional(),
    // per-lens chart settings (true solar time, school …); any change makes a new profile_version (§15.7)
    lenses: z.record(z.string(), z.object({ enabled: z.boolean().optional(), profile: z.record(z.string(), z.any()).optional() }).passthrough()).optional(),
  }).passthrough().nullable(),
  // §17.3 信息源: Feishu DMs for the observer, and the other sources the poller reads (sources.ts)
  "sources.yaml": z.object({
    feishu: z.object({ dm: z.boolean().optional() }).passthrough().nullable().optional(),
    sources: z.array(z.object({
      id: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/, "小写字母开头，字母数字 _ -，2～32 个字符"), kind: z.enum(["git", "fetch", "command", "feishu-mail"]),
      every: z.string().regex(/^\d+[mhd]$/, "像 15m、2h、1d").optional(), domain: z.enum(["work", "personal"]).optional(), enabled: z.boolean().optional(),
      repo: z.string().optional(), url: z.string().regex(/^https?:\/\//, "http(s) 地址").optional(),
      run: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "插件目录名：小写字母数字 _ -").optional(),
      env: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(8).optional(), args: z.record(z.string(), z.any()).optional(),
    }).passthrough().superRefine((s, ctx) => {
      const need: Record<string, string> = { git: "repo", fetch: "url", command: "run" };
      if (need[s.kind] && !(s as any)[need[s.kind]]) ctx.addIssue({ code: "custom", path: [need[s.kind]], message: `${s.kind} 要写 ${need[s.kind]}` });
    })).nullable().optional(),
  }).passthrough().nullable().superRefine((c, ctx) => {
    const ids = (c?.sources ?? []).map((s: any) => s.id);
    const dup = ids.find((id: string, i: number) => ids.indexOf(id) !== i);
    if (dup) ctx.addIssue({ code: "custom", path: ["sources"], message: `id 重复：${dup}` });
  }),
};

export const CONFIG_FILES = Object.keys(SCHEMAS);

const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);

/**
 * Changes that loosen what the agent may do or spend (§10.3): the admin group gets a separate, loud notice for these.
 * `before` / `after` are the parsed files.
 */
export function widening(file: string, before: any, after: any): string[] {
  const out: string[] = [];
  before ??= {}; after ??= {};
  if (file === "gate.yaml") {
    if (num(after.proactive_daily_cap, 6) > num(before.proactive_daily_cap, 6)) out.push(`主动消息上限 ${num(before.proactive_daily_cap, 6)} → ${after.proactive_daily_cap}`);
    if (num(after.daily_budget_usd, 10) > num(before.daily_budget_usd, 10)) out.push(`巡检预算线 $${num(before.daily_budget_usd, 10)} → $${after.daily_budget_usd}`);
    if (num(after.improve_budget_usd, 3) > num(before.improve_budget_usd, 3)) out.push(`改进预算 $${num(before.improve_budget_usd, 3)} → $${after.improve_budget_usd}`);
    if (num(after.expert_daily_limit, 20) > num(before.expert_daily_limit, 20)) out.push(`专家每日次数 ${num(before.expert_daily_limit, 20)} → ${after.expert_daily_limit}`);
    if (num(after.approval_ttl_hours, 12) > num(before.approval_ttl_hours, 12)) out.push(`审批有效期 ${num(before.approval_ttl_hours, 12)}h → ${after.approval_ttl_hours}h`);
    const gone = (before.sensitive_words ?? []).filter((w: string) => !(after.sensitive_words ?? before.sensitive_words ?? []).includes(w));
    if (after.sensitive_words && gone.length) out.push(`去掉了敏感词：${gone.join("、")}`);
    // a shorter attention window means more messages reach him, sooner: same family as raising the proactive cap
    const b = before.attention ?? {}, a = after.attention ?? {}, bw = num(b.wait_minutes, 30), aw = num(a.wait_minutes, 30);
    if (aw < bw) out.push(`提醒等待窗口 ${bw} → ${aw} 分钟`);
    if (num(a.escalate_wait_minutes, 0) < num(b.escalate_wait_minutes, 0)) out.push(`紧急上报等待 ${num(b.escalate_wait_minutes, 0)} → ${num(a.escalate_wait_minutes, 0)} 分钟`);
    for (const k of new Set([...Object.keys(b.places ?? {}), ...Object.keys(a.places ?? {})])) {
      const was = num(b.places?.[k], bw), now = num(a.places?.[k], aw);
      if (now < was) out.push(`${k} 的等待窗口 ${was} → ${now} 分钟`);
    }
  }
  if (file === "models.yaml") {
    const b = before.budgets ?? {}, a = after.budgets ?? {};
    if ((a.daily_cost ?? Infinity) > (b.daily_cost ?? Infinity) || (b.daily_cost && !a.daily_cost)) out.push(`每日花费上限 $${b.daily_cost ?? "不限"} → $${a.daily_cost ?? "不限"}`);
    if ((a.run_output_tokens ?? 60000) > (b.run_output_tokens ?? 60000)) out.push(`每轮输出上限 ${b.run_output_tokens ?? 60000} → ${a.run_output_tokens}`);
  }
  if (file === "groups.yaml") {
    const rank: Record<string, number> = { disabled: 0, digest: 1, when_mentioned: 2, always: 3 };
    if ((rank[after.default ?? "always"]) > (rank[before.default ?? "always"])) out.push(`群默认 ${before.default} → ${after.default}`);
    for (const [id, g] of Object.entries(after.groups ?? {}) as [string, any][]) {
      const old = before.groups?.[id]?.activation;
      if (old && g?.activation && rank[g.activation] > rank[old]) out.push(`${g.name || id}：${old} → ${g.activation}`);
    }
  }
  if (file === "repos.yaml") {
    for (const [k, r] of Object.entries(after ?? {}) as [string, any][])
      if (!before?.[k] || before[k].url !== r?.url) out.push(`可推送仓库 ${k} → ${r?.url}`);
  }
  if (file === "sources.yaml") {
    // reading more of his life, sending more of it to the model, or handing a plugin a secret: all loud
    if (after.feishu?.dm === true && before.feishu?.dm !== true) out.push("开始读飞书私聊（别人发给你的单聊会送去分拣）");
    const old = new Map(((before.sources ?? []) as any[]).map((s) => [s.id, s]));
    for (const s of (after.sources ?? []) as any[]) {
      if (s?.enabled === false) continue;
      const o: any = old.get(s.id);
      const what = s.kind === "git" ? `仓库 ${s.repo}` : s.kind === "fetch" ? s.url : s.kind === "feishu-mail" ? "你的飞书邮箱，新邮件正文会送去模型分拣" : `插件 ${s.run}`;
      if (!o || o.enabled === false) out.push(`新信息源 ${s.id}（${s.kind}：${what}）`);
      else if (o.kind !== s.kind || o.url !== s.url || o.run !== s.run || o.repo !== s.repo) out.push(`信息源 ${s.id} 换了来源 → ${s.kind}：${what}`);
      const added = (s.env ?? []).filter((n: string) => !(o?.env ?? []).includes(n));
      if (added.length) out.push(`信息源 ${s.id} 能拿到密钥：${added.join("、")}`);
    }
  }
  if (file === "console.yaml") {
    const added = (after.owners ?? []).filter((o: string) => !(before.owners ?? []).includes(o));
    if (added.length) out.push(`控制台新增可登录账号：${added.join("、")}`);
    if (after.web?.origin && after.web.origin !== before.web?.origin) out.push(`控制台公网入口${before.web?.origin ? "换了地址" : "打开了"}：${after.web.origin}`);
  }
  return out;
}
