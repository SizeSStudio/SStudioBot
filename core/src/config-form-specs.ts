// What each config file's form looks like (DESIGN §10.6). Labels and help are written for the owner: what the setting
// controls, its default, what turning it up or down does. Types, ranges and required-ness are added from the zod schemas
// in schemas.ts (config-form.ts), and the smoke test fails if the two drift apart.
// Public repo: examples here are made up. self.yaml has no form yet: its page is 生活 › 出生信息.

import type { FormField, FormSpec, FieldOption } from "../protocol/config-form.ts";

type Extra = Partial<FormField>;
const text = (key: string, label: string, help: string, o: Extra = {}): FormField => ({ key, type: "text", label, help, ...o });
const num = (key: string, label: string, help: string, o: Extra = {}): FormField => ({ key, type: "number", label, help, ...o });
const bool = (key: string, label: string, help: string, o: Extra = {}): FormField => ({ key, type: "bool", label, help, ...o });
const group = (key: string, label: string, help: string, fields: FormField[], o: Extra = {}): FormField => ({ key, type: "group", label, help, fields, ...o });

const ACT_RANK = ["disabled", "digest", "when_mentioned", "always"];
const ACTIVATION: FieldOption[] = [
  { value: "always", label: "全部", help: "每条消息都送去分拣，要紧的会提醒你或起草回复。" },
  { value: "when_mentioned", label: "只看 @我", help: "只处理 @你 的消息，其余不送模型。" },
  { value: "digest", label: "摘要", help: "不逐条处理，只进定时摘要。" },
  { value: "disabled", label: "关闭", help: "完全不碰，连消息都不拉。" },
];

const WEEKDAYS: FieldOption[] = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, value) => ({ value, label }));
const JOB_KINDS: FieldOption[] = [
  { value: "morning", label: "早报", help: "代码汇总今天的事实，主 agent 写好发到你的私聊。" },
  { value: "event", label: "定时提醒", help: "到点把你写的一段话交给主 agent，由它在私聊里跟你说。" },
  { value: "dream", label: "夜间整理", help: "整理记忆：合并、修订 agent-home 里的页面，每处改动都有 git 记录。" },
  { value: "dream_diff", label: "整理结果通知", help: "把昨晚整理改了什么发到管理群。" },
  { value: "matter_review", label: "每日整理事项", help: "看一遍手上的事，在私聊发一张建议卡片。你点之前什么都不会变。" },
  { value: "review_day", label: "日复盘", help: "到点开始当天的复盘对话。" },
  { value: "review_week", label: "周复盘", help: "复盘这一周，并看下周。" },
  { value: "review_month", label: "月复盘", help: "复盘这个月，并看下个月。" },
  { value: "health_card", label: "健康周报", help: "把运行指标发到管理群。" },
  { value: "improve", label: "自我改进", help: "攒够信号后提改进提案，要你批准才生效。" },
  { value: "improve_review", label: "改进回看", help: "回看已生效的提案有没有变好。" },
  { value: "lens_month", label: "流月解读", help: "排上当月的解读任务。" },
];

const jobs: FormField = {
  key: ".", type: "map", label: "定时任务", removable: true, titleFrom: "do", rowMeta: "job", inline: ["enabled", "every", "weekday", "day", "at"],
  keyField: { label: "任务名", help: "只用来识别这个任务，小写字母开头。", placeholder: "weekly_note", patternHint: "小写字母开头，只用小写字母、数字和下划线" },
  add: {
    label: "添加定时任务", suggestKey: ["do"], defaults: { every: "day", at: "09:00", do: "event" },
    steps: [
      { title: "做什么", fields: ["do"] },
      { title: "写清楚", help: "定时提醒要写到点说什么；任务名只用来识别。", fields: ["$key", "text"] },
      { title: "什么时候", fields: ["every", "weekday", "day", "at"] },
    ],
  },
  fields: [
    bool("enabled", "启用", "关掉后不再触发，设置都留着，随时能打开。默认开。", { default: true, extra: true }),
    { key: "do", type: "select", label: "做什么", help: "这个任务到点执行的动作，建好后不能改。", options: JOB_KINDS, open: true, required: true, createOnly: true },
    { key: "every", type: "select", label: "频率", help: "每天、每周某天或每月某天。", required: true, default: "day", options: [{ value: "day", label: "每天" }, { value: "week", label: "每周" }, { value: "month", label: "每月" }] },
    { key: "weekday", type: "select", label: "周几", help: "每周的哪一天。", default: 0, options: WEEKDAYS, showIf: { key: "every", in: ["week"] } },
    num("day", "几号", "每月的哪一天。这个月没有这一天（比如 31 号）就跳过。", { default: 1, unit: "号", showIf: { key: "every", in: ["month"] } }),
    { key: "at", type: "time", label: "时间", help: "按你的时区。核心当时不在线、晚了超过 15 分钟的不补跑。", required: true },
    text("text", "到点说什么", "交给主 agent 的内容，写成对它说的话。", { required: true, showIf: { key: "do", in: ["event"] }, placeholder: "提醒我看一下这周的账单" }),
    bool("quota", "占主动消息额度", "开着时算进每日主动消息上限，超了就压到第二天早报。关掉后这条提醒不受上限约束。默认开。", {
      default: true, advanced: true, showIf: { key: "do", in: ["event"] }, widen: { when: "change", note: "这条提醒不再受每日主动消息上限约束，当天额度用完也会发。" } }),
    text("lane", "发到哪条会话", "内部的会话标识，默认是你的私聊。这里只显示，要改去「高级 › 查看原文」。", { readonly: true, advanced: true, placeholder: "你的私聊" }),
    num("limit", "每天最多几条建议", "卡片上放几条。调大一次看得多，调小负担轻。默认 5。", { extra: true, default: 5, min: 1, integer: true, unit: "条", showIf: { key: "do", in: ["matter_review"] } }),
    num("first_limit", "第一张卡片几条", "第一次整理积压多，可以多放一些。默认 12。", { extra: true, default: 12, min: 1, integer: true, unit: "条", showIf: { key: "do", in: ["matter_review"] } }),
    num("stale_days", "多久没动静算搁置", "一件事这么多天没新进展，就建议你看看要不要收。调小提醒更勤。默认 30。", { extra: true, default: 30, min: 1, integer: true, unit: "天", showIf: { key: "do", in: ["matter_review"] } }),
    num("ask_days", "导入的待回复看多久", "导入进来的「要你回」，这么多天内的才提。默认 7。", { extra: true, default: 7, min: 1, integer: true, unit: "天", showIf: { key: "do", in: ["matter_review"] } }),
    { key: "tier", type: "select", label: "用哪档模型", help: "不选时平常用读取档，第一次用执行档。档位越高越贵。", extra: true, advanced: true, showIf: { key: "do", in: ["matter_review"] },
      options: [{ value: "light", label: "读取" }, { value: "work", label: "执行" }, { value: "chat", label: "总控" }, { value: "expert", label: "专家" }] },
    num("min_signals", "攒够几个信号才跑", "新信号少于这个数就不提案。默认 10。", { extra: true, default: 10, min: 1, integer: true, unit: "个", advanced: true, showIf: { key: "do", in: ["improve"] } }),
    num("min_days", "至少隔几天", "离上次运行不足这么多天就不跑。默认 7。", { extra: true, default: 7, min: 1, integer: true, unit: "天", advanced: true, showIf: { key: "do", in: ["improve"] } }),
    num("max_days", "最多隔几天", "隔了这么多天，信号不够也跑一次。默认 28。", { extra: true, default: 28, min: 1, integer: true, unit: "天", advanced: true, showIf: { key: "do", in: ["improve"] } }),
    num("retry_hours", "上游出错重试多久", "遇到限流、5xx、断网时，从原定时间起重试这么久，但不会拖进下一轮。调大更不容易漏，调小更早放弃。默认 2。", { extra: true, default: 2, exclusiveMin: 0, unit: "小时", advanced: true }),
  ],
};

const tier = (key: string, label: string, help: string): FormField => group(key, label, help, [
  { key: "endpoint", type: "select", label: "端点", help: "这一档的请求发到哪个端点。", optionsFrom: "endpoints" },
  text("model", "模型", "端点认识的模型名。保存后下一次调用起生效。", { placeholder: "provider/model-name" }),
  group("price", "价格", "只用来算花费和预算，不影响调用。单位都是美元 / 百万 token。填了就要同时有输入和输出价。", [
    num("in", "输入", "", { unit: "$/M" }), num("out", "输出", "", { unit: "$/M" }),
    num("cache_read", "缓存读", "", { unit: "$/M" }), num("cache_write", "缓存写", "", { unit: "$/M" }),
  ]),
  num("context", "上下文窗口", "这个模型一次能读多少 token，决定对话什么时候压缩。默认 200000。填得比实际大会报错，填小会更早压缩。", { default: 200000, unit: "token", advanced: true }),
  num("max_tokens", "单次输出上限", "一次回复最多多少 token。默认 16000。", { default: 16000, unit: "token", advanced: true }),
  group("fallback", "备用模型", "这一档报「用量到上限」时，这一次请求改走它，别的错误不切。默认不配。它可能走另一个计费端点，花费照常记账。", [
    { key: "endpoint", type: "select", label: "端点", help: "不选就用这一档自己的端点。", optionsFrom: "endpoints" },
    text("model", "模型", "备用模型的名字。清空就是不用备用模型。"),
    group("price", "价格", "不填就按这一档的价格记账。", [num("in", "输入", "", { unit: "$/M" }), num("out", "输出", "", { unit: "$/M" })]),
  ], { extra: true, advanced: true, widen: undefined }),
]);

export const FORM_SPECS: Record<string, FormSpec> = {
  "jobs.yaml": {
    file: "jobs.yaml", title: "定时任务", summary: "早报、夜间整理这些按时间自动跑的事。改完下一轮生效。",
    sections: [{ title: "任务", help: "暂时不想要就关开关，不用删。时间都按你的时区。", fields: [jobs] }],
  },

  "gate.yaml": {
    file: "gate.yaml", title: "限额与闸门", summary: "它能多主动、能花多少、审批多久失效。没填的项用默认值。",
    sections: [
      { title: "主动找你", fields: [
        num("proactive_daily_cap", "每天主动消息上限", "到点提醒、任务完成通知这类不是回应你的消息，一天最多发几条，超出的进第二天早报。任务来问你、早报本身不算。默认 6。调大打扰更多，调小更安静。", {
          default: 6, unit: "条/天", usage: "proactive_today", widen: { when: "up", note: "它每天可以主动找你更多次。" } }),
        group("attention", "提醒前等多久", "有些消息你自己会看会回。等一会儿，你已经回应了就不再提醒。审批不受影响，草稿照样要你点发送。", [
          num("wait_minutes", "普通提醒等待", "要提醒或要起草的消息，等这么久你还没回应才动。默认 30，0 是不等。调小提醒来得快但更打扰，调大更安静但可能晚知道。", {
            default: 30, unit: "分钟", widen: { when: "down", note: "提醒会来得更早、更多。" } }),
          num("escalate_wait_minutes", "紧急消息等待", "紧急消息等多久才进你的私聊。默认 0，也就是立刻。", { default: 0, unit: "分钟", widen: { when: "down", note: "紧急消息会更快打断你。" } }),
          { key: "places", type: "kv", label: "单独设置的地方", help: "给某个群、信息源或别人的私聊单独定等待分钟数，比上面的优先。设短了算放宽。", valueType: "number", unit: "分钟",
            keyField: { label: "地方", optionsFrom: "places" } },
        ]),
      ] },
      { title: "审批", fields: [
        num("approval_ttl_hours", "审批多久失效", "卡片等你这么久没点就作废。默认 12。调大旧草稿还能批，但内容可能已经过时。", { default: 12, unit: "小时", widen: { when: "up", note: "更旧的草稿还能被批准发出，内容可能已经过时。" } }),
        num("send_by_hours", "批准后多久内要发出", "批准了但这么久还没发出去（比如飞书断了），就不再发。默认 2。", { default: 2, unit: "小时" }),
      ] },
      { title: "花费", fields: [
        num("daily_budget_usd", "巡检预算线", "今天的花费到这条线的 80% 时，巡检在管理群提醒你。只提醒，不拦调用；真正拦的是「模型」里的每日花费上限。没填时用那个上限，再没有就是 $10。", {
          unit: "美元/天", usage: "cost_today", widen: { when: "up", note: "花费要更高才会提醒你。" } }),
        num("improve_budget_usd", "每次自我改进预算", "一次自我改进（提案加回放）最多花多少，到了就停。默认 $3。", { default: 3, unit: "美元/次", widen: { when: "up", note: "自我改进每次可以花更多。" } }),
        num("expert_daily_limit", "专家把关每天次数", "第二意见模型每天最多用几次，用完就等第二天。默认 20。", { default: 20, unit: "次/天", usage: "expert_today", widen: { when: "up", note: "最贵的一档每天可以用更多次。" } }),
      ] },
      { title: "敏感词", fields: [
        { key: "sensitive_words", type: "tags", label: "敏感词", help: "群名含这些词的群默认完全不读，邮件也会避开。默认是下面这些词。去掉一个，相应的群可能开始送去模型。",
          default: ["HR", "人事", "薪酬", "绩效", "财务", "法务", "董事会"], placeholder: "输入后按回车", widen: { when: "remove", note: "群名含这个词的群不再自动关闭，消息可能开始送去模型。" } },
      ] },
    ],
  },

  "groups.yaml": {
    file: "groups.yaml", title: "群观察", summary: "它怎么看你所在的飞书群。没单独设置的群走默认档。",
    sections: [
      { title: "默认档位", fields: [
        { key: "default", type: "segment", label: "没单独设置的群", help: "默认「全部」。群名含敏感词的群仍然关闭，外部群和免打扰群仍然只出摘要，不受这里影响。档位越往左，读得越多、送模型的消息越多。",
          options: ACTIVATION, default: "always", widen: { when: "up", rank: ACT_RANK, note: "所有没单独设置的群都会多读，更多消息送去模型。" } },
        bool("reviewed", "首次过目已完成", "第一次开始读群前，管理群里的确认卡片会设置它。这里只显示。", { readonly: true }),
      ] },
      { title: "每个群", help: "按最近 7 天的消息数排序。选「默认」就回到上面的档位。", fields: [{
        key: "groups", type: "map", label: "群", keysFrom: "chats", inline: ["activation"], dropWhenOnly: ["name"], fillName: true,
        keyField: { label: "群", patternHint: "群 ID 要以 oc_ 开头" },
        fields: [
          { key: "activation", type: "segment", label: "观察方式", help: "这个群的档位。", options: ACTIVATION, widen: { when: "up", rank: ACT_RANK, note: "这个群会多读，更多消息送去模型。" } },
          text("name", "群名", "保存时自动记下，方便看文件时认群。", { readonly: true }),
          text("reply", "回复方式", "这里只显示，要改去「高级 › 查看原文」。", { readonly: true, advanced: true }),
        ],
      }] },
    ],
  },

  "sources.yaml": {
    file: "sources.yaml", title: "信息源", summary: "群消息之外，它还从哪里看事。读到的内容只进分拣、记成事件，不能发任何东西。",
    sections: [
      { title: "飞书私聊", fields: [group("feishu", "飞书", "", [
        bool("dm", "读别人发给我的私聊", "打开后，别人发给你的单聊会送去模型分拣，只记事件，不起草。你和它自己的私聊不算。默认关。", { default: false, widen: { when: "on", note: "别人发给你的私聊内容会开始送去模型。" } }),
      ])] },
      { title: "其他来源", help: "暂时不想读就关开关。新来源第一次只记下起点，不回溯旧内容。", fields: [{
        key: "sources", type: "list", label: "信息源", identity: "id", removable: true, titleFrom: "kind", rowMeta: "source", inline: ["enabled"],
        add: {
          label: "添加信息源", suggestKey: ["repo", "run", "url", "kind"], defaults: { kind: "git", every: "30m", domain: "work" },
          steps: [
            { title: "哪一类", fields: ["kind"] },
            { title: "从哪里读", help: "只有你选的内容会被读取。", fields: ["repo", "url", "run", "env", "args"] },
            { title: "怎么读", fields: ["id", "every", "domain"] },
          ],
        },
        fields: [
          bool("enabled", "启用", "关掉就暂停读取，设置和进度都留着。默认开。", { default: true, widen: { when: "on", note: "这个来源会重新开始读取。" } }),
          text("id", "名字", "用来识别这个来源，建好后不能改。", { required: true, createOnly: true, placeholder: "release-notes", patternHint: "小写字母开头，可用字母、数字、_ 和 -，2～32 个字符" }),
          { key: "kind", type: "select", label: "类型", help: "建好后不能改，想换就新建一个。", required: true, createOnly: true, options: [
            { value: "git", label: "代码仓库", help: "仓库任何分支的新提交。" },
            { value: "fetch", label: "网页", help: "一个网页新出现的文字。" },
            { value: "feishu-mail", label: "飞书邮箱", help: "你的收件箱和已发送，只读。邮件正文会送去模型分拣。" },
            { value: "command", label: "插件", help: "运行服务器上已经装好的插件。插件只能由主人在服务器上安装。" },
          ] },
          { key: "every", type: "duration", label: "多久看一次", help: "默认 30 分钟，最短 1 分钟。调短更及时，模型花费也更高。", default: "30m" },
          { key: "domain", type: "select", label: "归到", help: "记成工作的事还是私人的事。默认工作。", default: "work", options: [{ value: "work", label: "工作" }, { value: "personal", label: "私人" }] },
          { key: "repo", type: "picker", label: "仓库", help: "从「代码仓库」配置里选。", optionsFrom: "repos", required: true, showIf: { key: "kind", in: ["git"] } },
          text("url", "网址", "http 或 https 开头。地址里别带密钥。", { required: true, placeholder: "https://example.com/changelog", patternHint: "要以 http:// 或 https:// 开头", showIf: { key: "kind", in: ["fetch"] } }),
          { key: "run", type: "picker", label: "插件", help: "服务器插件目录里已经装好的插件。", optionsFrom: "plugins", required: true, patternHint: "插件目录名：小写字母、数字、_ 和 -", showIf: { key: "kind", in: ["command"] } },
          { key: "env", type: "multiselect", label: "给它的密钥", help: "插件只拿到这里勾选的密钥。模型端点和飞书的密钥不能给插件，所以不在列表里。", optionsFrom: "plugin_secrets", showIf: { key: "kind", in: ["command"] }, widen: { when: "add", note: "这个插件能读到新勾选的密钥。" } },
          { key: "args", type: "kv", label: "插件参数", help: "原样传给插件，具体填什么看插件说明。", valueType: "text", showIf: { key: "kind", in: ["command"] }, keyField: { label: "参数名" } },
        ],
      }] },
    ],
  },

  "people.yaml": {
    file: "people.yaml", title: "人", summary: "它认识的人。认人只看 ID，名字只用于显示。",
    sections: [
      { title: "你自己", fields: [group("owner", "主人", "", [
        text("name", "名字", "它怎么称呼你。"),
        group("ids", "身份", "你的 ID 决定谁能指挥它，这里不能改。确实要换，去「高级 › 查看原文」。", [
          text("feishu", "飞书 ID", "", { readonly: true }), text("wechat", "微信 ID", "", { readonly: true }),
        ]),
      ])] },
      { title: "其他人", help: "这里的信息决定它怎么对待这个人。只是见过的人不用加，他们在「生活 › 人」里。", fields: [{
        key: ".", type: "map", label: "人", extra: true, excludeKeys: ["owner"], removable: true,
        keyField: { label: "标识", help: "只用来识别，建好后不变。", placeholder: "lao-wang", pattern: "^[a-z0-9][a-z0-9_-]*$", patternHint: "小写字母或数字开头，可用字母、数字、_ 和 -" },
        add: { label: "添加一个人", suggestKey: [], steps: [{ title: "是谁", help: "最好从见过的人里选，ID 不会填错。", fields: ["$key", "name", "ids"] }, { title: "什么关系", fields: ["relation", "importance", "wechat_remark"] }] },
        fields: [
          text("name", "名字", "显示用的名字。"),
          group("ids", "身份", "它靠这些 ID 认人。", [
            { key: "feishu", type: "picker", label: "飞书", help: "从见过的人里选，也可以直接填 ou_ 开头的 ID。", optionsFrom: "persons", open: true, pattern: "^ou_", patternHint: "飞书 ID 以 ou_ 开头" },
            text("wechat", "微信", "这个人的微信 ID。"),
          ]),
          text("relation", "关系", "你们是什么关系，写给它看的。", { suggest: ["家人", "伴侣", "朋友", "同事", "上级", "下属", "客户", "合作方"] }),
          { key: "importance", type: "select", label: "重要程度", help: "选「重要」后，发给这个人的内容会先过专家把关，意见显示在审批卡片上。不选就是普通。", options: [{ value: "high", label: "重要" }] },
          text("wechat_remark", "微信备注", "你在微信里给 TA 的唯一备注，发消息时用来找人和核对。", { advanced: true }),
        ],
      }] },
    ],
  },

  "feishu.yaml": {
    file: "feishu.yaml", title: "飞书群", summary: "它用哪个群做管理、哪个群做工作台。",
    sections: [{ title: "固定的群", help: "只能从它已知的群里选。列表里没有的话，先把机器人拉进群，等下一次同步。", fields: [
      { key: "admin_chat", type: "picker", label: "管理群", help: "审批卡片、配置改动、巡检告警都发到这里，你也在这里发管理命令。换群后这些都跟着走，选错会收不到审批。", optionsFrom: "chats", widen: { when: "change", note: "审批卡片和所有管理通知都会发到新群，群里的人都能看到。" } },
      { key: "workbench_chat", type: "picker", label: "工作台", help: "你在这个话题群里开的话题，每个都是一条独立的工作会话。", optionsFrom: "chats", widen: { when: "change", note: "工作会话的内容会发到新群，群里的人都能看到。" } },
    ] }],
  },

  "repos.yaml": {
    file: "repos.yaml", title: "代码仓库", summary: "任务能拿到哪些仓库的副本，批准后推送到哪里。",
    sections: [{ title: "仓库", help: "加在这里后，任务就能拿到副本。推送仍然要你在卡片上批准，而且只推到 sbot/ 开头的分支。", fields: [{
      key: ".", type: "map", label: "仓库", removable: true,
      keyField: { label: "名字", help: "任务和信息源用这个名字指代仓库。", placeholder: "my-project", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", patternHint: "字母或数字开头，可用字母、数字、. _ -" },
      add: { label: "添加仓库", suggestKey: [], steps: [{ title: "哪个仓库", fields: ["$key", "url", "branch"] }] },
      fields: [
        text("url", "地址", "git 能访问的地址。地址里别带密码或 token。", { placeholder: "git@github.com:team/project.git", widen: { when: "change", note: "批准的推送会发到这个地址，任务也会拿到这里的代码。" } }),
        text("branch", "主分支", "任务从这个分支开始。默认 main。", { placeholder: "main" }),
      ],
    }] }],
  },

  "console.yaml": {
    file: "console.yaml", title: "控制台访问", summary: "谁能登录这个控制台，以及公网入口。",
    sections: [
      { title: "Tailscale 账号", fields: [
        { key: "owners", type: "tags", label: "能登录的账号", help: "经 Tailscale 进来时，只有这些账号能打开控制台。至少留一个，也不能移除你正在用的账号。", placeholder: "输入账号后按回车", widen: { when: "add", note: "这个账号将能看到和修改这里的一切。" } },
      ] },
      { title: "公网入口", fields: [group("web", "公网入口", "默认关。填了地址，再加上服务器上设好的密码，才能从公网打开。清空就关闭。", [
        text("origin", "地址", "https:// 加主机名，不带路径和结尾的 /。", { placeholder: "https://console.example.com", patternHint: "要写成 https://主机名，不带路径和结尾的 /", widen: { when: "change", note: "控制台可以从这个公网地址用密码登录。" } }),
      ])] },
    ],
  },

  "models.yaml": {
    file: "models.yaml", title: "模型与预算", summary: "四档模型各用什么、每天能花多少。改动下一次调用起生效。密钥在「模型与密钥」页填。",
    sections: [
      { title: "预算", fields: [group("budgets", "预算", "", [
        num("daily_cost", "每天花费上限", "今天花到这个数，模型调用直接被拒绝，直到第二天。不填就不限。调大能多用，调小更省，但到了它就停下来。", { unit: "美元/天", usage: "cost_today", widen: { when: "up", clearing: true, note: "一天可以花更多钱才会停。" } }),
        num("run_output_tokens", "每轮输出上限", "一轮对话最多输出多少 token，防止失控。默认 60000。", { default: 60000, unit: "token", widen: { when: "up", note: "单轮对话可以输出更多，也更费钱。" } }),
      ])] },
      { title: "四档模型", fields: [group("tiers", "档位", "", [
        tier("chat", "总控", "主对话用这一档，最影响体验。"),
        tier("work", "执行", "任务、起草、解读、夜间整理。"),
        tier("light", "读取", "分拣、摘要、检查、搜索。调用最多，选便宜快的。"),
        tier("expert", "专家", "第二意见：把关、提案、评审。可以不配。"),
      ])] },
      { title: "端点", advanced: true, help: "模型请求发到哪里、用哪个密钥。改这里影响所有用它的档位。", fields: [{
        key: "endpoints", type: "map", label: "端点", removable: true,
        keyField: { label: "名字", placeholder: "main", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", patternHint: "字母或数字开头，可用字母、数字、_ 和 -" },
        add: { label: "添加端点", suggestKey: [], defaults: { auth: "bearer" }, steps: [{ title: "端点", fields: ["$key", "base_url", "auth", "key_ref"] }] },
        fields: [
          text("base_url", "地址", "https 地址；不想写进配置仓库就写 secret:密钥名。", { placeholder: "https://api.example.com", widen: { when: "change", note: "模型请求和密钥都会发到新地址。" } }),
          { key: "auth", type: "select", label: "认证方式", help: "看服务商要求。", options: [{ value: "bearer", label: "Bearer" }, { value: "x-api-key", label: "x-api-key" }] },
          { key: "key_ref", type: "picker", label: "密钥", help: "用哪个密钥。只选名字，值在「模型与密钥」页填，这里看不到。", optionsFrom: "secrets", open: true, patternHint: "大写字母开头，只用大写字母、数字和下划线", widen: { when: "change", note: "这个端点会改用另一个密钥。" } },
        ],
      }] },
    ],
  },
};
