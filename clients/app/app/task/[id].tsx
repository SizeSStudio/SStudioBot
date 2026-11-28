// A task's own thread (DESIGN §触6.5, §办3.4; 07 「任务」): the goal, where it stands (需要你处理, 等额度 till when,
// 等节点), its steps live from the unified events (the Timeline of lane task:<id>), its cards, the finished diff, and
// a box to steer it that says before and after what really happens to the line. Buttons follow the adapter's caps
// and the task's state (status.ts can), not the agent's name.
// The detail (sessions, worktrees, PRs, diff_stat) isn't in the stream's task events: it is fetched again, a moment
// after the task changes.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocalSearchParams } from 'expo-router'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { TaskRes, TaskSteerRes } from '../../../../protocol/api/tasks.ts'
import type { Task } from '../../../../protocol/api/entities.ts'
import { actions, conn, store, useConn, writes } from '../../src/conn/client.ts'
import { refOf, taskLane } from '../../src/conn/actions.ts'
import { Timeline } from '../../src/chat/Timeline.tsx'
import { classifyLink } from '../../src/render/links.ts'
import { keyInfo, shouldSend } from '../../src/render/ime.ts'
import { useEntity, useList, useWrites } from '../../src/store/hooks.ts'
import { DiffBlob, shaOf } from '../../src/task/DiffBlob.tsx'
import { agentsOf, can, steerHint, steerOutcome, taskLine } from '../../src/task/status.ts'
import { Btn, Refusal, Row } from '../../src/ui/kit.tsx'
import { useLinkGate } from '../../src/ui/linkGate.tsx'
import { useViewing } from '../../src/ui/presence.tsx'

const TONE: Record<string, string> = { you: 'text-destructive', run: 'text-foreground', wait: 'text-muted-foreground', done: 'text-muted-foreground', bad: 'text-destructive' }
const CI: Record<string, string> = { pending: 'CI 在跑', green: 'CI 绿了', red: 'CI 红了', none: '没有 CI' }

/** GET /tasks/:id, again a moment after the task's row moves (and when the connection comes back) */
function useDetail(id: string | undefined, seq: number | undefined): Task | null {
  const [d, setD] = useState<Task | null>(null)
  const live = useConn().s === 'live'
  useEffect(() => {
    if (!id || !live) return
    let gone = false
    const h = setTimeout(() => {
      void conn.request('GET', `/api/v1/tasks/${encodeURIComponent(id)}`).then((r) => {
        const p = r.status === 200 ? TaskRes.safeParse(r.body) : null
        if (gone || !p?.success) return
        setD(p.data.task)
        // not in the store yet (ended before the bootstrap): the list and the buttons use the hub's copy
        if (!store.get('task', id)) store.current('task', p.data.task, p.data.seq)
      }, () => {})
    }, seq === undefined ? 0 : 400)
    return () => { gone = true; clearTimeout(h) }
  }, [id, seq, live])
  return d
}

export default function TaskPage() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const rec = useEntity(store, 'task', id)
  const detail = useDetail(id, rec?.seq)
  useViewing(id ? `task:${id}` : null)
  const t = rec?.data
  // the stream's row is newer for status; the detail adds what the stream leaves out
  const full = useMemo(() => (t ? { ...detail, ...t, sessions: detail?.sessions, worktrees: detail?.worktrees, prs: detail?.prs, diff_stat: t.diff_stat ?? detail?.diff_stat } as Task : detail), [t, detail])
  const lane = id ? taskLane(id) : undefined
  // the hub makes the task's thread itself; it may arrive after the task does
  const threads = useList(store, 'thread')
  const thread = useMemo(() => threads.find((x) => x.data.lane === lane), [threads, lane])
  return (
    <View testID="task" className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 px-3 py-2 border-b border-border">
        <Link href="/tasks" className="text-muted-foreground">‹</Link>
        <Text selectable className="text-foreground font-semibold flex-1" numberOfLines={2}>{full?.goal ?? '任务'}</Text>
      </View>
      {full ? (
        <>
          <Head t={full} />
          {lane ? <Timeline lane={lane} threadId={thread?.data.id} /> : null}
          <Steer t={full} />
        </>
      ) : <Text className="text-muted-foreground p-6">{id ? '在问主…（连上之后显示）' : '没有这个任务'}</Text>}
    </View>
  )
}

function Head({ t }: { t: Task }) {
  const node = useEntity(store, 'node', t.node ?? undefined)?.data
  const line = taskLine(t, node?.name)
  const c = can(t)
  const target = refOf('task', t.id)
  const { busy, refusal } = useWrites(writes, (w) => ({ busy: w.busy(target), refusal: w.refusal(target) }))
  const [moving, setMoving] = useState(false)
  const [open, setOpen] = useState(false)
  const gate = useLinkGate()
  const diffSha = shaOf(t.diff_blob?.ref)
  return (
    <ScrollView className="max-h-80 border-b border-border" contentContainerClassName="px-3 py-2 gap-1">
      <Row wrap>
        <Text testID="task-status" className={`text-sm font-semibold ${TONE[line.tone]}`}>{line.label}</Text>
        <Text className="text-muted-foreground text-xs flex-1">
          {[node?.name ?? t.node, t.agent, t.attempt > 1 ? `第 ${t.attempt} 次` : '', t.turn ? `第 ${t.turn} 轮` : ''].filter(Boolean).join(' · ')}
        </Text>
        <Pressable onPress={() => setOpen(!open)}><Text className="text-muted-foreground text-xs">{open ? '收起' : '详情'}</Text></Pressable>
      </Row>
      {line.detail ? <Text selectable testID="task-detail" className="text-muted-foreground text-xs">{line.detail}</Text> : null}
      {t.queued_steers ? <Text testID="task-queued-steers" className="text-muted-foreground text-xs">还有 {t.queued_steers} 句插话排着，下一轮开头交给它</Text> : null}
      <Row wrap>
        {c.stop ? <Btn small label="停这一轮" busy={busy} onPress={() => void actions.stopTask(t.id)} testID="task-stop" /> : null}
        {c.move ? <Btn small label="换机器 / 换家" busy={busy} onPress={() => setMoving(!moving)} testID="task-move" /> : t.status !== 'cancelled' && !c.move ? <Text className="text-muted-foreground text-xs">先停这一轮才能换机器</Text> : null}
        {c.cancel ? <Btn small variant="destructive" label="取消任务" busy={busy} onPress={() => void actions.cancelTask(t.id)} testID="task-cancel" /> : null}
      </Row>
      {moving && c.move ? <Move t={t} done={() => setMoving(false)} /> : null}
      <Refusal op={refusal} onDismiss={(oid) => writes.dismiss(oid)} />
      {t.prs?.length ? t.prs.map((p) => (
        <Row key={p.id}>
          <Pressable testID="task-pr" onPress={() => gate(classifyLink(p.url), p.url)} className="flex-1">
            <Text className="text-foreground text-xs underline" numberOfLines={1}>{p.repo ? `${p.repo}#${p.number ?? ''}` : p.url}</Text>
          </Pressable>
          <Text className="text-muted-foreground text-xs">{p.state === 'open' ? CI[p.ci ?? 'none'] ?? p.ci : p.state === 'merged' ? '合了' : '关了'}</Text>
        </Row>
      )) : null}
      {diffSha ? <DiffBlob sha={diffSha} size={t.diff_blob?.size} stat={t.diff_stat} label="最后的改动" testID="task-diff" /> : null}
      {open ? (
        <View className="gap-0.5">
          {t.workdir ? <Text selectable className="text-muted-foreground text-xs">目录 {t.workdir}</Text> : null}
          {t.repo ? <Text selectable className="text-muted-foreground text-xs">仓库 {t.repo}</Text> : null}
          {t.worktrees?.map((w) => <Text key={w.path} selectable className="text-muted-foreground text-xs">worktree {w.path} · {w.branch} · {w.state}</Text>)}
          {t.sessions?.map((s) => <Text key={`${s.node}:${s.session_ref}`} selectable className="text-muted-foreground text-xs">session {s.agent} @ {s.node} · {s.proc}</Text>)}
          {t.error ? <Text selectable className="text-destructive text-xs">{t.error}</Text> : null}
        </View>
      ) : null}
    </ScrollView>
  )
}

/** 换机器 / 换家: another node, another agent, or both (the hub hands the context over in a new session) */
function Move({ t, done }: { t: Task; done: () => void }) {
  const nodes = useList(store, 'node')
  const [node, setNode] = useState(t.node ?? '')
  const agents = agentsOf(nodes.find((n) => n.data.id === node)?.data)
  const [agent, setAgent] = useState(t.agent ?? '')
  const changed = node !== (t.node ?? '') || agent !== (t.agent ?? '')
  return (
    <View testID="task-move-box" className="rounded border border-border p-2 gap-1">
      <Text className="text-muted-foreground text-xs">去哪台</Text>
      <Row wrap>{nodes.map((n) => <Btn key={n.data.id} small label={`${n.data.name}${n.data.status === 'online' ? '' : '（不在线）'}`} variant={node === n.data.id ? 'primary' : 'outline'} onPress={() => setNode(n.data.id)} testID={`move-node-${n.data.id}`} />)}</Row>
      <Text className="text-muted-foreground text-xs">用哪个 agent</Text>
      <Row wrap>{agents.map((a) => <Btn key={a.kind} small label={a.kind} variant={agent === a.kind ? 'primary' : 'outline'} onPress={() => setAgent(a.kind)} testID={`move-agent-${a.kind}`} />)}</Row>
      <Row>
        <Btn small variant="primary" label="换" disabled={!changed} testID="task-move-send"
          onPress={() => { void actions.moveTask(t.id, { ...(node !== t.node ? { node } : {}), ...(agent !== t.agent ? { agent } : {}) }); done() }} />
        <Btn small label="算了" onPress={done} />
      </Row>
    </View>
  )
}

/** The steer box: what will happen before I send (steerHint), what did happen after (steerOutcome, from the hub's answer). */
function Steer({ t }: { t: Task }) {
  const [text, setText] = useState('')
  const [said, setSaid] = useState<string | null>(null)
  const lane = refOf('lane', taskLane(t.id))
  const failed = useWrites(writes, (w) => w.forTarget(lane).filter((o) => o.state === 'failed' || o.state === 'conflict'))
  const gen = useRef(0)
  const off = t.status === 'cancelled'
  const send = () => {
    const s = text.trim()
    if (!s || off) return
    setText('')
    const g = ++gen.current
    setSaid('…')
    void actions.steerTask(t.id, s).then((r) => {
      if (g !== gen.current) return
      const p = r.ok ? TaskSteerRes.safeParse(r.body) : null
      setSaid(r.ok ? steerOutcome(p?.success ? p.data : null) : null)
    })
  }
  return (
    <View className="border-t border-border px-3 py-2 gap-1">
      {failed.map((o) => <Refusal key={o.id} op={o} onDismiss={(oid) => writes.dismiss(oid)} />)}
      <Text testID="steer-hint" className="text-muted-foreground text-xs">{said && said !== '…' ? said : steerHint(t)}</Text>
      <Row>
        <TextInput testID="steer-input" value={text} onChangeText={(v) => { setText(v); if (said && said !== '…') setSaid(null) }} multiline maxLength={20_000} editable={!off}
          placeholder={off ? '任务取消了' : '插一句'} className="flex-1 border border-border rounded-lg p-2 text-foreground max-h-40"
          onKeyPress={(e) => {
            const ne = e.nativeEvent as unknown as Parameters<typeof keyInfo>[0]
            if (shouldSend(keyInfo(ne))) { (e as unknown as { preventDefault?: () => void }).preventDefault?.(); send() }
          }} />
        <Btn label="发" variant="primary" disabled={!text.trim() || off} onPress={send} testID="steer-send" />
      </Row>
    </View>
  )
}
