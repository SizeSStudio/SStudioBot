// One lane's conversation (07 「store」「渲染」): inputs, finished items, approvals and tasks from the store in time
// order, then whatever is still streaming. W3: approvals are live cards, my inputs show 发送中 / 排队中 (withdrawable),
// agent HTML opens in the system browser, and what I've seen is marked read. Everything shown is untrusted: text goes through the
// markdown whitelist (src/render/), tool bodies as code, never HTML. Follows the bottom unless I scrolled up a screen;
// then «有新消息». Older history pages in with threads/:id/items?before=.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import type { LegendListRef } from '@legendapp/list/react-native'
import { ThreadItemsRes } from '../../../../protocol/api/read.ts'
import type { Item, Task } from '../../../../protocol/api/entities.ts'
import { actions, conn, store, useConn, writes } from '../conn/client.ts'
import { refOf } from '../conn/actions.ts'
import { htmlRefOf, openHtml } from '../html/open.ts'
import { useList, useTimeline, useWrites } from '../store/hooks.ts'
import type { Live, Rec, TimelineRow } from '../store/store.ts'
import { Btn, Refusal, Row as HRow } from '../ui/kit.tsx'
import { useForeground } from '../ui/presence.tsx'
import { ApprovalCard } from './ApprovalCard.tsx'
import { CodeBlock } from '../render/CodeBlock.tsx'
import { Markdown } from '../render/Markdown.tsx'
import { parseMarkdown, StreamingMarkdown } from '../render/md.ts'
import { ChatList } from './ChatList'
import type { ChatRow } from './types.ts'

type Row = ChatRow & ({ kind: 'row'; row: TimelineRow } | { kind: 'live'; live: Live })

const time = (ts: number) => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
const json = (v: unknown) => { try { return JSON.stringify(v, null, 2) ?? '' } catch { return String(v) } }
const textOf = (body: unknown): string => (body && typeof body === 'object' && typeof (body as { text?: unknown }).text === 'string' ? (body as { text: string }).text : '')

const Md = memo(function Md({ text }: { text: string }) {
  const tree = useMemo(() => parseMarkdown(text), [text])
  return <Markdown tree={tree} />
})

const INPUT_STATUS: Record<string, string> = { failed: '出错了', dropped: '撤回了', interrupted: '被打断了' }

function InputRow({ rec, busyLane }: { rec: Rec<'input'>; busyLane: boolean }) {
  const d = rec.data
  const target = refOf('input', d.id)
  const { op, refusal, busy } = useWrites(writes, (w) => ({ op: rec.pending ? w.op(rec.pending) : undefined, refusal: w.refusal(target), busy: w.busy(target) }))
  // waiting its turn behind a running one: it can still be withdrawn (DELETE inputs/:id)
  const queued = !rec.pending && d.status === 'received' && busyLane
  const state = rec.pending ? (op?.state === 'queued' ? '等连上' : '发送中') : queued ? '排队中' : INPUT_STATUS[d.status] ?? ''
  return (
    <View testID="input-row" className={`mx-3 my-1 rounded-lg p-3 ${d.owner ? 'bg-muted self-end max-w-[85%]' : 'border border-border self-start max-w-[85%]'} ${rec.pending ? 'opacity-70' : ''}`}>
      {!d.owner && d.sender_name ? <Text className="text-muted-foreground text-xs mb-1">{d.sender_name}</Text> : null}
      <Text selectable className="text-foreground" style={{ lineHeight: 22 }}>{d.text ?? `（${d.kind}）`}</Text>
      <HRow>
        <Text className="text-muted-foreground text-[10px] mt-1">{time(d.ts)}{state ? ` · ${state}` : ''}</Text>
        {queued && d.owner ? <Btn small variant="ghost" label="撤回" busy={busy} onPress={() => void actions.withdrawInput(d.id)} testID="input-withdraw" /> : null}
      </HRow>
      <Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)} />
    </View>
  )
}

function HtmlOpen({ body }: { body: unknown }) {
  const h = htmlRefOf(body)
  const [msg, setMsg] = useState('')
  if (!h) return null
  return (
    <HRow>
      <Text className="text-muted-foreground text-xs flex-1" numberOfLines={1}>{h.name} · {Math.ceil(h.size / 1024)} KB</Text>
      <Btn small label="用浏览器打开" onPress={() => { setMsg('…'); void openHtml(h).then((r) => setMsg(r.ok ? '' : r.error), () => setMsg('没拉到，连上后再试')) }} testID="html-open" />
      {msg ? <Text className="text-muted-foreground text-xs">{msg}</Text> : null}
    </HRow>
  )
}

function ToolRow({ d, live }: { d: Item; live?: Live }) {
  const [open, setOpen] = useState(false)
  const key = d.live_key ?? d.id
  const toggle = () => {
    const next = !open
    setOpen(next)
    // tool output streams only to connections that expanded it (02)
    if (d.status === 'running') void (next ? conn.expand(key) : conn.collapse(key))
  }
  const body = d.body as { args?: unknown; result?: unknown; preview?: string } | null
  return (
    <View className="mx-3 my-0.5">
      <Pressable onPress={toggle} accessibilityRole="button">
        <Text className="text-muted-foreground text-xs">{open ? '▾' : '▸'} 工具 {d.name ?? ''} · {d.status}{d.truncated ? ' · 截断了' : ''}</Text>
      </Pressable>
      {open ? (
        <View>
          {body?.preview !== undefined ? <CodeBlock text={body.preview} lang="" open={false} /> : null}
          {body?.args !== undefined ? <CodeBlock text={json(body.args)} lang="json" open={false} /> : null}
          {live?.text ? <CodeBlock text={live.text} lang="" open /> : body?.result !== undefined ? <CodeBlock text={typeof body.result === 'string' ? body.result : json(body.result)} lang="" open={false} /> : null}
          <HtmlOpen body={d.body} />
          {d.blob ? <Text className="text-muted-foreground text-xs">全文 {Math.ceil(d.blob.size / 1024)} KB 在主上</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

function ItemRow({ d }: { d: Item }) {
  if (d.kind === 'tool') return <ToolRow d={d} />
  if (d.kind === 'notice') return <View className="mx-3 my-1"><Text className="text-muted-foreground text-xs">{textOf(d.body)}</Text><HtmlOpen body={d.body} /></View>
  return (
    <View className="mx-3 my-1 rounded-lg p-3 border border-border">
      <Md text={textOf(d.body) || ((d.body as { preview?: string } | null)?.preview ?? '')} />
      {d.truncated ? <Text className="text-muted-foreground text-xs">（太长，截断了）</Text> : null}
      <HtmlOpen body={d.body} />
    </View>
  )
}

function CardRow({ title, status, kind }: { title: string; status: string; kind: string }) {
  return (
    <View className="mx-3 my-1 rounded-lg p-3 border border-border bg-card">
      <Text className="text-muted-foreground text-xs">{kind} · {status}</Text>
      <Text selectable className="text-foreground">{title}</Text>
    </View>
  )
}

function LiveRow({ l }: { l: Live }) {
  const sm = useRef(new StreamingMarkdown()).current
  const tree = useMemo(() => sm.update(l.text), [l.text, sm])
  if (l.tool !== undefined) return <Text className="mx-3 text-muted-foreground text-xs">▸ 工具 {l.tool} 在跑…</Text>
  return (
    <View className="mx-3 my-1 rounded-lg p-3 border border-border">
      <Markdown tree={tree} />
      {l.stale ? <Text className="text-muted-foreground text-xs">（接上中…）</Text> : <Text className="text-muted-foreground text-xs">▍</Text>}
    </View>
  )
}

function renderRow(item: Row, busyLane: boolean): ReactElement {
  if (item.kind === 'live') return <LiveRow l={item.live} />
  const { row } = item
  switch (row.entity) {
    case 'input': return <InputRow rec={row.rec as Rec<'input'>} busyLane={busyLane} />
    case 'item': return <ItemRow d={row.rec.data as Item} />
    case 'approval': return <ApprovalCard rec={row.rec as Rec<'approval'>} />
    case 'task': { const t = row.rec.data as Task; return <CardRow kind="任务" status={t.status} title={t.goal} /> }
  }
}

export function Timeline({ lane, threadId }: { lane: string; threadId: string | undefined }) {
  const { rows, live } = useTimeline(store, lane)
  const runs = useList(store, 'run')
  const busyLane = useMemo(() => runs.some((r) => r.data.lane === lane && r.data.status === 'running'), [runs, lane])
  const render = useCallback(({ item }: { item: Row }) => renderRow(item, busyLane), [busyLane])
  // read up to the newest line the hub has (my own pending lines don't count); only while the app is in front and live
  const liveConn = useConn().s === 'live'
  const fg = useForeground()
  const newest = useMemo(() => rows.reduce((m, r) => (r.rec.pending ? m : Math.max(m, r.ts)), 0), [rows])
  useEffect(() => {
    if (threadId && !threadId.startsWith('op:') && newest > 0 && fg && liveConn) void actions.markRead('thread', threadId, newest)
  }, [threadId, newest, fg, liveConn])
  const data = useMemo<Row[]>(() => [
    ...rows.map((row) => ({ key: `${row.entity}:${row.id}`, kind: 'row' as const, row })),
    ...live.map((l) => ({ key: `live:${l.run}:${l.item}`, kind: 'live' as const, live: l })),
  ], [rows, live])
  const listRef = useRef<LegendListRef>(null)
  const atBottom = useRef(true)
  const [unseen, setUnseen] = useState(false)
  const seen = useRef(data.length)
  useEffect(() => {
    if (data.length > seen.current && !atBottom.current) setUnseen(true)
    seen.current = data.length
  }, [data.length])

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    // more than a screen from the bottom: stop following (07)
    atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < layoutMeasurement.height
    if (atBottom.current) setUnseen(false)
  }, [])

  const [paging, setPaging] = useState<string | null>(null)
  const before = threadId ? store.nextBefore(threadId) : null
  const older = async () => {
    if (!threadId || !before || paging) return
    setPaging('…')
    try {
      const r = await conn.request('GET', `/api/v1/threads/${encodeURIComponent(threadId)}/items`, { query: { before, limit: '50' } })
      if (r.status !== 200) throw new Error(String(r.status))
      store.page(threadId, ThreadItemsRes.parse(r.body))
      setPaging(null)
    } catch { setPaging('没拉到，连上后再试') }
  }
  const header = before ? (
    <Pressable onPress={() => void older()} className="self-center my-2 px-3 py-1 rounded-lg border border-border">
      <Text className="text-muted-foreground text-xs">{paging ?? '更早的'}</Text>
    </Pressable>
  ) : null

  if (!data.length) return <View className="flex-1 items-center justify-center"><Text className="text-muted-foreground">还没有内容</Text></View>
  return (
    <View className="flex-1">
      <ChatList ref={listRef} data={data} renderItem={render as never} onScroll={onScroll} ListHeaderComponent={header} />
      {unseen ? (
        <Pressable onPress={() => { setUnseen(false); void listRef.current?.scrollToEnd({ animated: true }) }} className="absolute bottom-4 self-center px-3 py-1 rounded-lg bg-primary">
          <Text className="text-primary-foreground text-xs">有新消息</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
