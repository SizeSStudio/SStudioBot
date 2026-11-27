// Changes that loosen what the agent may do, read, spend or send where (§触5.3; the list in docs/tech/03 「配置键变化」).
// They never block a save: the write goes through and the admin outlet gets a separate, loud notice. `before` / `after`
// are the parsed files. Each check reads the value the code would actually use (defaults and legacy keys applied), so
// adding a key that equals its default is not a widening and deleting one that was tighter than its default is.
import { DEFAULTS, DEFAULT_SENSITIVE_WORDS } from "./schemas.ts";

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const minutesOf = (hhmm: unknown, d: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof hhmm === "string" ? hhmm : d) ?? /^(\d{1,2}):(\d{2})$/.exec(d)!;
  return Number(m[1]) * 60 + Number(m[2]);
};
/** length of the night window in minutes; from == to = no night at all */
const nightLength = (n: Obj | undefined) => {
  const d = DEFAULTS.gate.push.night, from = minutesOf(n?.from, d.from), to = minutesOf(n?.to, d.to);
  return (to - from + 1440) % 1440;
};
const ACT_RANK: Record<string, number> = { disabled: 0, digest: 1, when_mentioned: 2, always: 3 };

export function widening(file: string, before: unknown, after: unknown): string[] {
  const out: string[] = [];
  const b: Obj = isObj(before) ? before : {}, a: Obj = isObj(after) ? after : {};

  if (file === "gate.yaml") {
    const g = DEFAULTS.gate;
    const up = (label: string, x: number, y: number, unit = "") => { if (y > x) out.push(`${label} ${x}${unit} → ${y}${unit}`); };
    up("主动消息上限", num(b.proactive_daily_cap, g.proactive_daily_cap), num(a.proactive_daily_cap, g.proactive_daily_cap));
    up("审批有效期", num(b.approval_ttl_hours, g.approval_ttl_hours), num(a.approval_ttl_hours, g.approval_ttl_hours), "h");
    // R7 made these alert lines; raising one still means I hear later, so it stays loud
    const improve = (o: Obj) => num(o.improve_alert_usd, num(o.improve_budget_usd, g.improve_alert_usd));
    if (improve(a) > improve(b)) out.push(`自我改进提醒线 $${improve(b)} → $${improve(a)}`);
    if (num(a.daily_budget_usd, Infinity) > num(b.daily_budget_usd, Infinity)) out.push(`巡检提醒线 $${b.daily_budget_usd ?? "跟模型的每日提醒线"} → $${a.daily_budget_usd ?? "跟模型的每日提醒线"}`);
    up("专家每日提醒线（旧键 expert_daily_limit）", num(b.expert_daily_limit, DEFAULTS.models.expert_daily_alert), num(a.expert_daily_limit, DEFAULTS.models.expert_daily_alert), " 次");
    const words = (o: Obj) => (Array.isArray(o.sensitive_words) ? strs(o.sensitive_words) : DEFAULT_SENSITIVE_WORDS);
    const gone = words(b).filter((w) => !words(a).includes(w));
    if (gone.length) out.push(`去掉了敏感词：${gone.join("、")}`);
    // a shorter attention window means more messages reach me, sooner: same family as raising the proactive cap
    const ba: Obj = b.attention ?? {}, aa: Obj = a.attention ?? {};
    const bw = num(ba.wait_minutes, g.attention.wait_minutes), aw = num(aa.wait_minutes, g.attention.wait_minutes);
    if (aw < bw) out.push(`提醒等待窗口 ${bw} → ${aw} 分钟`);
    const be = num(ba.escalate_wait_minutes, g.attention.escalate_wait_minutes), ae = num(aa.escalate_wait_minutes, g.attention.escalate_wait_minutes);
    if (ae < be) out.push(`紧急上报等待 ${be} → ${ae} 分钟`);
    for (const k of new Set([...Object.keys(ba.places ?? {}), ...Object.keys(aa.places ?? {})])) {
      const was = num(ba.places?.[k], bw), now = num(aa.places?.[k], aw);
      if (now < was) out.push(`${k} 的等待窗口 ${was} → ${now} 分钟`);
    }
    // §触1.1: shorter waits, a shorter night, one more category let through at night, more suggestions
    const bp: Obj = b.push ?? {}, ap: Obj = a.push ?? {}, p = g.push;
    const down = (label: string, x: number, y: number) => { if (y < x) out.push(`${label} ${x} → ${y} 分钟`); };
    down("对话中先等", num(bp.quiet_minutes, p.quiet_minutes), num(ap.quiet_minutes, p.quiet_minutes));
    down("不急的最多推迟", num(bp.max_delay_minutes, p.max_delay_minutes), num(ap.max_delay_minutes, p.max_delay_minutes));
    const bn = nightLength(bp.night), an = nightLength(ap.night);
    if (an < bn) out.push(`夜间变短：${Math.round(bn / 6) / 10} → ${Math.round(an / 6) / 10} 小时`);
    const allow = (o: Obj) => (Array.isArray(o.night_allow) ? strs(o.night_allow) : p.night_allow);
    const more = allow(ap).filter((c) => !allow(bp).includes(c));
    if (more.length) out.push(`夜里多放行：${more.join("、")}`);
    up("每天建议条数", num(bp.suggestions?.agent_daily, p.suggestions.agent_daily), num(ap.suggestions?.agent_daily, p.suggestions.agent_daily), " 条");
  }

  if (file === "models.yaml") {
    const bb: Obj = b.budgets ?? {}, ab: Obj = a.budgets ?? {};
    if (num(ab.daily_cost, Infinity) > num(bb.daily_cost, Infinity)) out.push(`每日花费提醒线 $${bb.daily_cost ?? "不提醒"} → $${ab.daily_cost ?? "不提醒"}`);
    const rt = DEFAULTS.models.run_output_tokens;
    if (num(ab.run_output_tokens, rt) > num(bb.run_output_tokens, rt)) out.push(`每轮输出提醒线 ${num(bb.run_output_tokens, rt)} → ${ab.run_output_tokens}`);
    for (const [k, e] of Object.entries(isObj(a.endpoints) ? a.endpoints : {}) as [string, Obj][]) {
      const o: Obj | undefined = b.endpoints?.[k];
      if (!o) out.push(`新端点 ${k}（密钥 ${e?.key_ref}）`);
      else if (o.base_url !== e?.base_url) out.push(`端点 ${k} 换了地址，请求和密钥 ${e?.key_ref} 都会发到新地址`);
      else if (o.key_ref !== e?.key_ref) out.push(`端点 ${k} 改用密钥 ${e?.key_ref}`);
    }
    for (const [k, t] of Object.entries(isObj(a.tiers) ? a.tiers : {}) as [string, Obj][]) {
      const o: Obj | undefined = b.tiers?.[k];
      if (o && o.endpoint !== t?.endpoint) out.push(`${k} 档换到端点 ${t?.endpoint}`);
      if (t?.fallback?.model && JSON.stringify(o?.fallback) !== JSON.stringify(t.fallback)) out.push(`${k} 档的备用模型 → ${t.fallback.model}，可能走另一个计费端点`);
      // R7: per-tier daily alert line; the expert tier falls back to gate.yaml's old expert_daily_limit, then 20
      const d = k === "expert" ? DEFAULTS.models.expert_daily_alert : Infinity;
      if (num(t?.daily_alert, d) > num(o?.daily_alert, d)) out.push(`${k} 档每日提醒线 ${o?.daily_alert ?? (d === Infinity ? "不提醒" : d)} → ${t?.daily_alert ?? "不提醒"} 次`);
    }
  }

  if (file === "groups.yaml") {
    const bd = String(b.default ?? "always"), ad = String(a.default ?? "always");
    if ((ACT_RANK[ad] ?? 0) > (ACT_RANK[bd] ?? 0)) out.push(`群默认 ${bd} → ${ad}`);
    for (const [id, g] of Object.entries(isObj(a.groups) ? a.groups : {}) as [string, Obj][]) {
      const old = b.groups?.[id]?.activation;
      if (old && g?.activation && (ACT_RANK[g.activation] ?? 0) > (ACT_RANK[old] ?? 0)) out.push(`${g.name || id}：${old} → ${g.activation}`);
    }
  }

  if (file === "repos.yaml") {
    for (const [k, r] of Object.entries(a) as [string, Obj][])
      if (!b[k] || b[k].url !== r?.url) out.push(`可推送仓库 ${k} → ${r?.url}`);
  }

  if (file === "jobs.yaml") {
    for (const [k, j] of Object.entries(a) as [string, Obj][]) {
      const o: Obj = isObj(b[k]) ? b[k] : {};
      if (j?.do === "event" && j.quota === false && o.quota !== false) out.push(`定时提醒 ${k} 不再占每日主动消息额度`);
      if (j?.do === "dream") {
        // §读1.3: one night may delete a bigger share, add more lines, or keep .archive/ for less time
        const d = DEFAULTS.dream;
        if (num(j.max_delete, d.max_delete) > num(o.max_delete, d.max_delete)) out.push(`夜间整理一晚可删的比例 ${num(o.max_delete, d.max_delete)} → ${j.max_delete}`);
        if (num(j.max_add, d.max_add) > num(o.max_add, d.max_add)) out.push(`夜间整理一晚可净增 ${num(o.max_add, d.max_add)} → ${j.max_add} 行`);
        if (num(j.archive_days, d.archive_days) < num(o.archive_days, d.archive_days)) out.push(`夜间整理的 .archive/ 保留 ${num(o.archive_days, d.archive_days)} → ${j.archive_days} 天`);
      }
    }
  }

  if (file === "sources.yaml") {
    // reading more of my life, sending more of it to the model, or handing a plugin a secret: all loud
    if (a.feishu?.dm === true && b.feishu?.dm !== true) out.push("开始读飞书私聊（别人发给你的单聊会送去分拣）");
    const old = new Map(arr(b.sources).filter(isObj).map((s) => [s.id, s]));
    for (const s of arr(a.sources).filter(isObj)) {
      if (s.enabled === false) continue;
      const o = old.get(s.id);
      const what = s.kind === "git" ? `仓库 ${s.repo}` : s.kind === "fetch" ? s.url : s.kind === "feishu-mail" ? "你的飞书邮箱，新邮件正文会送去模型分拣" : `插件 ${s.run}`;
      if (!o || o.enabled === false) out.push(`新信息源 ${s.id}（${s.kind}：${what}）`);
      else if (o.kind !== s.kind || o.url !== s.url || o.run !== s.run || o.repo !== s.repo) out.push(`信息源 ${s.id} 换了来源 → ${s.kind}：${what}`);
      const added = strs(s.env).filter((n) => !strs(o?.env).includes(n));
      if (added.length) out.push(`信息源 ${s.id} 能拿到密钥：${added.join("、")}`);
    }
    // Y5: adding to the exclude list narrows; taking an entry off lets it be read again
    for (const k of ["chats", "persons", "mails"]) {
      const gone = strs(b.exclude?.[k]).filter((x) => !strs(a.exclude?.[k]).includes(x));
      if (gone.length) out.push(`排除名单（${k}）去掉了 ${gone.length} 项，这些又会被读到：${gone.join("、")}`);
    }
  }

  if (file === "console.yaml") {
    // 06 「开关」: each switch opens something to the outside
    if (a.relay?.enabled === true && b.relay?.enabled !== true) out.push(`打开了中继${a.relay?.url ? `：${a.relay.url}` : ""}，配对过的设备可以从外网连进来`);
    else if (a.relay?.enabled === true && a.relay?.url !== b.relay?.url) out.push(`中继换了地址：${a.relay?.url ?? "（没填）"}`);
    if (a.mcp_open === true && b.mcp_open !== true) out.push("打开了 MCP 入口");
    if (a.fcm?.enabled === true && b.fcm?.enabled !== true) out.push("打开了 FCM 推送，通知会经 Google 的推送服务发到手机");
  }

  if (file === "channels.yaml") {
    const bf: Obj = b.feishu ?? {}, af: Obj = a.feishu ?? {};
    if (bf.admin_chat !== af.admin_chat) out.push(`管理群换了：${bf.admin_chat ?? "（没有）"} → ${af.admin_chat ?? "（没有）"}。审批卡片和管理通知以后都发到新群`);
    if (bf.workbench_chat !== af.workbench_chat) out.push(`工作台换了 → ${af.workbench_chat ?? "（没有）"}。你在这个群发的话题会开工作会话`);
    // ※ 09: shadow sends nothing; going live starts real messages
    if ((af.mode ?? "live") === "live" && bf.mode === "shadow") out.push("飞书从 shadow 改成 live：开始真的收发消息");
    const groups = (o: Obj): Record<string, string[]> => ({ ...DEFAULTS.channels.outlets, ...(isObj(o.outlets) ? o.outlets : {}) });
    const bo = groups(b), ao = groups(a);
    for (const [g, list] of Object.entries(ao)) {
      const added = strs(list).filter((x) => !strs(bo[g]).includes(x));
      if (added.length) out.push(`出口组 ${g} 多了：${added.join("、")}（这组通知也会发到那里）`);
    }
  }

  if (file === "backup.yaml") {
    // ※ the backup holds secrets.env and keys/: whoever holds the recipient's private key can read all of it
    if (a.recipient !== b.recipient && a.recipient) out.push(`备份改用新的公钥加密（${String(a.recipient).slice(0, 12)}…）：持有对应私钥的人能解开全部备份，含密钥`);
    const added = strs(a.to_nodes).filter((n) => !strs(b.to_nodes).includes(n));
    if (added.length) out.push(`加密备份也会推给：${added.join("、")}`);
  }

  if (file === "people.yaml") {
    // ※ who counts as me decides who can command it
    for (const c of ["feishu", "wechat"]) {
      const was = b.owner?.ids?.[c], now = a.owner?.ids?.[c];
      if (now && now !== was) out.push(`你的${c === "feishu" ? "飞书" : "微信"} ID ${was ? "换了" : "登记了"}：这个 ID 能指挥它`);
    }
    for (const [k, p] of Object.entries(a) as [string, Obj][]) {
      if (k === "owner" || !isObj(p)) continue;
      const o: Obj | undefined = b[k];
      for (const c of ["feishu", "wechat"]) if (p.ids?.[c] && p.ids[c] !== o?.ids?.[c]) out.push(`${p.name ?? k} 的${c === "feishu" ? "飞书" : "微信"} ID ${o?.ids?.[c] ? "换了" : "登记了"}`);
    }
  }
  return out;
}
