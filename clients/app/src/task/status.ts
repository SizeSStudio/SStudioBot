// How a task reads on screen (DESIGN §触6.1 办, §触6.5 任务 thread, §办3.4): one status line, who has to move now,
// which buttons make sense, and what a steer did. Buttons follow what the node's adapter said it can do (`caps`),
// never the agent's name (§办3.2). Plain TS: node --test runs it.
import type { Node, Task } from '../../../../protocol/api/entities.ts'

/** you: I have to do something · run: it is working · wait: waiting on time or a machine · done · bad */
export type Tone = 'you' | 'run' | 'wait' | 'done' | 'bad'
export type TaskLine = { label: string; tone: Tone; detail: string | null }

const ENDED = new Set(['done', 'failed', 'cancelled'])
export const isEnded = (t: Pick<Task, 'status'>) => ENDED.has(t.status)
/** a turn is going on the node now */
export const isTurning = (t: Pick<Task, 'status'>) => t.status === 'running' || t.status === 'waiting'

export const hhmm = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

export function taskLine(t: Task, nodeName?: string): TaskLine {
  if (t.needs_you) {
    return {
      label: '需要你处理', tone: 'you',
      detail: t.status === 'interrupted' ? '节点或 agent 重启了，这一轮断在半路；说一句就在同一个 session 里接着来' : '很久没有输出了：看看它卡在哪，插一句、停或换机器',
    }
  }
  if (t.waiting_approval) return { label: '等你答', tone: 'you', detail: '它在等一张看一眼 / 问我卡（就在下面）' }
  if (t.status === 'queued' && t.quota_until != null) return { label: '等额度', tone: 'wait', detail: `额度用完了，${hhmm(t.quota_until)} 自动接着跑` }
  if (t.status === 'waiting_node') return { label: '等节点', tone: 'wait', detail: `「${nodeName ?? t.node ?? '节点'}」没在线；上线了自动开始` }
  switch (t.status) {
    case 'queued': return { label: '排着', tone: 'wait', detail: null }
    case 'running': return { label: '在跑', tone: 'run', detail: null }
    case 'waiting': return { label: '在等', tone: 'run', detail: null }
    case 'interrupted': return { label: '断了', tone: 'you', detail: '说一句就接着来' }
    case 'done': return { label: '做完了', tone: 'done', detail: null }
    case 'failed': return { label: '失败了', tone: 'bad', detail: t.error }
    case 'cancelled': return { label: '取消了', tone: 'done', detail: null }
    default: return { label: t.status, tone: 'wait', detail: null }
  }
}

/** The 办 order (§触6.1): waiting on me > finished while I wasn't looking > running > the rest; newest first inside. */
export function taskRank(t: Task, seenUpTo: number | undefined): number {
  const line = taskLine(t)
  if (line.tone === 'you') return 0
  if (isEnded(t) && (t.ended ?? t.ts) > (seenUpTo ?? 0)) return 1
  if (line.tone === 'run') return 2
  if (line.tone === 'wait') return 3
  return 4
}

export type Can = { stop: boolean; cancel: boolean; move: boolean; steerNow: boolean }
/** What the buttons can do now. steerNow: the agent takes a message mid-turn (else it waits for the next turn). */
export function can(t: Task): Can {
  return {
    stop: isTurning(t),
    cancel: !isEnded(t),
    // the hub refuses a move while a turn runs (409 「先停」): the button says so instead of failing
    move: t.status !== 'cancelled' && !isTurning(t),
    steerNow: isTurning(t) && t.caps?.steer === true,
  }
}

/** Said before I send: what will happen to it. */
export function steerHint(t: Task): string {
  if (t.status === 'cancelled') return '任务取消了，发不进去'
  if (t.waiting_approval) return '它在等卡片：发的话会先把那张卡拒掉，再交给它'
  if (isTurning(t)) return t.caps?.steer === true ? '它在跑：这句会插进这一轮' : '这个 agent 不支持中途插话：这句排到下一轮开头'
  if (t.status === 'interrupted' || t.needs_you) return '发了就在同一个 session 里接着来'
  if (isEnded(t)) return '发了会接着这个 session 再跑一轮'
  return '发了排在下一轮'
}

/** Said after, from what the hub answered (TaskSteerRes): never claims more than it did. */
export function steerOutcome(r: { applied?: unknown; queued?: unknown } | null | undefined): string {
  if (r?.applied === true) return '插进这一轮了'
  return '这一轮接不了，排到下一轮开头'
}

// ── nodes ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type AgentInfo = { kind: string; version: string | null }
/** Node.agents is [{kind, version}] as the node said; anything else is skipped. */
export function agentsOf(n: Pick<Node, 'agents'> | undefined): AgentInfo[] {
  const v = n?.agents
  return (Array.isArray(v) ? v : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { kind?: unknown }).kind === 'string')
    .map((a) => ({ kind: String(a.kind).slice(0, 100), version: typeof a.version === 'string' ? a.version.slice(0, 40) : null }))
}

const NODE_STATUS: Record<string, string> = { online: '在线', offline: '离线', draining: '收尾中（不接新活）', outdated: '版本旧了（在升级）' }
export const nodeStatusText = (s: string) => NODE_STATUS[s] ?? s

/** {<agent>: {left, resets_at}} → one short line per agent */
export function quotaLines(n: Pick<Node, 'quotas'>): string[] {
  const q = n.quotas
  if (!q || typeof q !== 'object' || Array.isArray(q)) return []
  return Object.entries(q as Record<string, unknown>).slice(0, 10).map(([k, v]) => {
    const o = (v && typeof v === 'object' ? v : {}) as { left?: unknown; resets_at?: unknown }
    const left = typeof o.left === 'number' || typeof o.left === 'string' ? `剩 ${String(o.left).slice(0, 20)}` : ''
    const at = typeof o.resets_at === 'number' ? `${hhmm(o.resets_at)} 恢复` : ''
    return `${k.slice(0, 40)}：${[left, at].filter(Boolean).join('，') || '没报'}`
  })
}
