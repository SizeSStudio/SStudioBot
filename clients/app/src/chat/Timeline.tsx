// One lane's conversation, read-only in W2 (07 「store」「渲染」): inputs, finished items, approvals and tasks from the
// store in time order, then whatever is still streaming. Everything shown is untrusted: text goes through the
// markdown whitelist (src/render/), tool bodies as code, never HTML. Follows the bottom unless I scrolled up a screen;
// then «有新消息». Older history pages in with threads/:id/items?before=.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import type { LegendListRef } from '@legendapp/list/react-native'
import { ThreadItemsRes } from '../../../../protocol/api/read.ts'
import type { Approval, Input, Item, Task } from '../../../../protocol/api/entities.ts'
import { conn, store } from '../conn/client.ts'
import { useTimeline } from '../store/hooks.ts'
import type { Live, TimelineRow } from '../store/store.ts'
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

function InputRow({ d }: { d: Input }) {
  return (
    <View className={`mx-3 my-1 rounded-lg p-3 ${d.owner ? 'bg-muted self-end max-w-[85%]' : 'border border-border self-start max-w-[85%]'}`}>
      {!d.owner && d.sender_name ? <Text className="text-muted-foreground text-xs mb-1">{d.sender_name}</Text> : null}
      <Text selectable className="text-foreground" style={{ lineHeight: 22 }}>{d.text ?? `（${d.kind}）`}</Text>
      <Text className="text-muted-foreground text-[10px] mt-1">{time(d.ts)}{d.status === 'failed' || d.status === 'dropped' ? ` · ${d.status}` : ''}</Text>
    </View>
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
          {d.blob ? <Text className="text-muted-foreground text-xs">全文 {Math.ceil(d.blob.size / 1024)} KB 在主上（W3 能打开）</Text> : null}
        </View>
      ) : null}
    </View>
  )
}

function ItemRow({ d }: { d: Item }) {
  if (d.kind === 'tool') return <ToolRow d={d} />
  if (d.kind === 'notice') return <Text className="mx-3 my-1 text-muted-foreground text-xs">{textOf(d.body)}</Text>
  return (
    <View className="mx-3 my-1 rounded-lg p-3 border border-border">
      <Md text={textOf(d.body) || ((d.body as { preview?: string } | null)?.preview ?? '')} />
      {d.truncated ? <Text className="text-muted-foreground text-xs">（太长，截断了）</Text> : null}
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

function render({ item }: { item: Row }): ReactElement {
  if (item.kind === 'live') return <LiveRow l={item.live} />
  const { row } = item
  switch (row.entity) {
    case 'input': return <InputRow d={row.rec.data as Input} />
    case 'item': return <ItemRow d={row.rec.data as Item} />
    case 'approval': { const a = row.rec.data as Approval; return <CardRow kind={`审批 ${a.kind}`} status={a.status} title={a.title ?? a.draft ?? ''} /> }
    case 'task': { const t = row.rec.data as Task; return <CardRow kind="任务" status={t.status} title={t.goal} /> }
  }
}

export function Timeline({ lane, threadId }: { lane: string; threadId: string | undefined }) {
  const { rows, live } = useTimeline(store, lane)
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
