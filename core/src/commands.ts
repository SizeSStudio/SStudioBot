// Owner commands in the DM (DESIGN §1.2 /stop, §3.3 /new, §5.3 /model). Handled by code, never by a model.
// Plain text replies; /group answers with a switch card in the admin group.

import { all, one, kvGet } from "./db.ts";
import { TIERS, models, log, jobsConf, type Tier } from "./config.ts";
import { editConfig, localStamp } from "./memory.ts";
import { sendGroupCard } from "./observer.ts";
import { listTasks } from "./tasks.ts";
import { queueReply, type TurnContext } from "./tools.ts";
import type { Dispatcher } from "./dispatcher.ts";
import type { Scheduler } from "./timers.ts";
import { OWNER_DM_LANE } from "./feishu.ts";
import { runImprove, improveStatus } from "./improve.ts";

const HELP = `命令：
/new 下一条消息开新会话（旧会话的要点会带过去）
/stop 停下正在跑的这一轮
/model 看四档模型；/model <chat|work|light|expert> <模型名> 改某一档
/usage 今天的用量；/usage 7 最近 7 天
/group <关键词> 在管理群发这些群的观察开关卡片
/tasks 没结束的任务；/tasks all 全部
/job 看定时任务；/job <名字> 现在跑一次（比如 /job morning 早报、/job dream 整理记忆）
/improve 不管门槛，现在看一次信号出改进提案；/improve status 看样本数和提案记录`;

export function makeCommandHandler(d: Dispatcher, afterReply: () => void, sched?: Scheduler) {
  return async (cmd: string, arg: string, turn: TurnContext, inboxId: number) => {
    const reply = (text: string) => { queueReply({ runId: `cmd_${inboxId}`, lane: OWNER_DM_LANE, turn }, text); afterReply(); };
    log("cmd", cmd, { arg: arg.slice(0, 60) });
    try {
      switch (cmd) {
        case "help": return reply(HELP);
        case "new": d.markRoll(OWNER_DM_LANE); return reply("好，下一条消息开新会话。");
        case "stop": return reply((await d.stop(OWNER_DM_LANE)) ? "已停下当前这一轮。" : "现在没有在跑的。");
        case "model": return reply(arg ? setModel(arg) : showModels());
        case "usage": return reply(usage(Number(arg) || 1));
        case "group": return reply(arg ? await sendGroupCard(arg) : "用法：/group <群名里的关键词>");
        case "tasks": return reply(listTasks(arg !== "all"));
        case "job": return reply(arg ? (sched ? await sched.runNow(arg.trim()) : "定时器没启动") : showJobs());
        case "improve":
          if (arg.trim() === "status") return reply(improveStatus());
          reply("开始看最近的信号，有提案会发到管理群（几分钟）。");
          return reply(`自我改进：${await runImprove(jobsConf().improve ?? {}, { force: true })}`);
      }
    } catch (e: any) { reply(`命令出错：${e?.message ?? e}`); }
  };
}

function showModels() {
  const m = models();
  const lines = TIERS.map((t) => {
    const c = m.tiers[t];
    if (!c) return `- ${t}：未配置`;
    const p = c.price ? `，$${c.price.in}/$${c.price.out} 每百万 token` : "";
    return `- ${t}：\`${c.model}\`（端点 ${c.endpoint}${p}）`;
  });
  const b = m.budgets ?? {};
  return `${lines.join("\n")}\n预算：每轮 ${b.run_output_tokens ?? 60000} 输出 token；每天 $${b.daily_cost ?? "不限"}\n改法：/model chat <模型名>`;
}

function setModel(arg: string) {
  const [tier, name] = arg.split(/\s+/);
  if (!TIERS.includes(tier as Tier) || !name) return "用法：/model <chat|work|light|expert> <模型名>";
  if (!models().tiers[tier as Tier]) return `档位 ${tier} 还没配置端点，先改 models.yaml。`;
  const before = models().tiers[tier as Tier]!.model;
  if (before === name) return `${tier} 已经是 \`${name}\`。`;
  editConfig("models.yaml", (doc) => { doc.setIn(["tiers", tier, "model"], name); return `${tier} ${before} → ${name}`; }, "command");
  return `${tier}：\`${before}\` → \`${name}\`。下一个请求起生效；这一档的会话会在下一轮换新（旧要点带过去）。`;
}

function usage(days: number) {
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  const rows = all(`SELECT tier, model, COUNT(*) n, SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read) cr, SUM(cache_write) cw, SUM(cost) c
                    FROM usage WHERE ts>=? GROUP BY tier, model ORDER BY c DESC`, since.getTime());
  const runs = one("SELECT COUNT(*) n, SUM(status='failed') f FROM runs WHERE started>=?", since.getTime())!;
  if (!rows.length) return `${days === 1 ? "今天" : `最近 ${days} 天`}还没有模型调用。`;
  const k = (x: number) => (x ?? 0) >= 1000 ? `${((x ?? 0) / 1000).toFixed(1)}k` : String(x ?? 0);
  const total = rows.reduce((s, r) => s + (r.c ?? 0), 0);
  return `${days === 1 ? "今天" : `最近 ${days} 天`}：${runs.n} 轮（失败 ${runs.f ?? 0}），约 $${total.toFixed(3)}\n` +
    rows.map((r) => `- ${r.tier}（${r.model}）：${r.n} 次，输入 ${k(r.i)} / 输出 ${k(r.o)} / 缓存读 ${k(r.cr)} 写 ${k(r.cw)}，$${(r.c ?? 0).toFixed(3)}`).join("\n");
}

function showJobs() {
  const jobs = Object.entries(jobsConf());
  if (!jobs.length) return "config/jobs.yaml 里还没有定时任务。";
  return jobs.map(([name, j]) => {
    const last = JSON.parse(kvGet(`job.${name}.last`) ?? "null");
    const when = j.every === "day" ? `每天 ${j.at}` : j.every === "week" ? `每周${"日一二三四五六"[Number(j.weekday ?? 0)]} ${j.at}` : `每月 ${j.day ?? 1} 日 ${j.at}`;
    return `- ${name}（${j.do}）：${when}${last ? `；上次 ${localStamp(last.at).slice(5)} ${last.outcome}` : ""}`;
  }).join("\n");
}
