// 对话：500 条历史 + 50 段/秒流 2000 字（P11 ②）。?auto=1 时自动跑一遍并报结果。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native'
import { useLocalSearchParams, Link } from 'expo-router'
import type { LegendListRef } from '@legendapp/list/react-native'
import { ChatList } from '../../src/chat/ChatList'
import { makeHistory, makeReply, type Msg } from '../../src/chat/data.ts'
import { Markdown } from '../../src/render/Markdown.tsx'
import { parseMarkdown, StreamingMarkdown } from '../../src/render/md.ts'
import { frameMonitor, report } from '../../src/probe/report.ts'

const treeCache = new Map<string, ReturnType<typeof parseMarkdown>>()
const treeOf = (m: Msg) => {
  let t = treeCache.get(m.id + m.text.length)
  if (!t) { t = parseMarkdown(m.text); treeCache.set(m.id + m.text.length, t) }
  return t
}

function Bubble({ m, streamTree }: { m: Msg; streamTree?: ReturnType<typeof parseMarkdown> }) {
  return (
    <View className={`mx-3 my-1 rounded-lg p-3 ${m.role === 'me' ? 'bg-muted self-end max-w-[85%]' : 'bg-background border border-border'}`}>
      <Markdown tree={streamTree ?? treeOf(m)} />
    </View>
  )
}

export default function Chat() {
  const { auto } = useLocalSearchParams<{ auto?: string }>()
  const [msgs, setMsgs] = useState<Msg[]>(() => makeHistory(500))
  const [streamText, setStreamText] = useState<string | null>(null)
  const [unseen, setUnseen] = useState(false)
  const listRef = useRef<LegendListRef>(null)
  const sm = useMemo(() => new StreamingMarkdown(), [])
  const atBottom = useRef(true)
  const streamTree = useMemo(() => (streamText === null ? undefined : sm.update(streamText)), [streamText, sm])

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
    const dist = contentSize.height - contentOffset.y - layoutMeasurement.height
    // 离底超过一屏就停止跟随
    atBottom.current = dist < layoutMeasurement.height
    if (atBottom.current) setUnseen(false)
  }, [])

  const stream = useCallback(async (opts: { scrollUpAt?: number } = {}) => {
    sm.reset()
    const segs = makeReply(2000, 10)
    const id = `r${Date.now()}`
    setMsgs(m => [...m, { id, role: 'agent', text: '' }])
    let acc = ''
    setStreamText('')
    const mon = frameMonitor()
    const samples: { seg: number; distFromBottom: number }[] = []
    let scrolledUpOffset: number | null = null
    for (let i = 0; i < segs.length; i++) {
      acc += segs[i]
      setStreamText(acc)
      if (!atBottom.current) setUnseen(true)
      await new Promise(r => setTimeout(r, 20)) // 50 段/秒
      const st = listRef.current?.getState()
      if (st && i % 20 === 19) samples.push({ seg: i, distFromBottom: Math.round(st.contentLength - st.scroll - st.scrollLength) })
      if (opts.scrollUpAt === i && st) { listRef.current?.scrollToOffset({ offset: Math.max(0, st.scroll - 1500), animated: false }); await new Promise(r => setTimeout(r, 100)); scrolledUpOffset = listRef.current?.getState().scroll ?? null }
    }
    const fps = mon.stop()
    const finalScroll = listRef.current?.getState().scroll ?? null
    setMsgs(m => m.map(x => (x.id === id ? { ...x, text: acc } : x)))
    setStreamText(null)
    return { fps, samples, scrolledUpOffset, finalScroll }
  }, [sm])

  useEffect(() => {
    if (!auto) return
    void (async () => {
      await new Promise(r => setTimeout(r, 1500))
      const stick = await stream()
      await new Promise(r => setTimeout(r, 500))
      const yank = await stream({ scrollUpAt: 60 })
      report('chat', { history: 500, chars: 2000, segPerSec: 50, stick, yank: { scrolledUpOffset: yank.scrolledUpOffset, finalScroll: yank.finalScroll, fps: yank.fps } })
    })()
  }, [auto, stream])

  const renderItem = useCallback(({ item }: { item: Msg }) => <Bubble m={item} streamTree={item.text === '' ? streamTree : undefined} />, [streamTree])

  return (
    <View testID="first-screen" className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 p-2 border-b border-border">
        <Text className="text-foreground font-semibold flex-1">对话</Text>
        <Link href="/probe" className="text-muted-foreground text-xs underline">探针</Link>
        <Pressable testID="stream" onPress={() => void stream().then(r => report('chat-manual', r))} className="px-3 py-1 rounded-lg bg-primary hover:opacity-80">
          <Text className="text-primary-foreground text-xs">流一段</Text>
        </Pressable>
      </View>
      <ChatList ref={listRef} data={msgs} renderItem={renderItem} onScroll={onScroll} />
      {unseen ? (
        <Pressable onPress={() => void listRef.current?.scrollToEnd({ animated: true })} className="absolute bottom-4 self-center px-3 py-1 rounded-lg bg-primary">
          <Text className="text-primary-foreground text-xs">有新消息</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
