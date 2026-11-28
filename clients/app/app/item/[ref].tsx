// sstudiobot://item/<ref> — where a tapped notification lands (07 「安卓」, protocol/api/push.ts PushData). Only the
// ref comes from the link: what is shown and decided here is the hub's state (the store, or a fresh GET), never what
// the notification said. A personal one is no different: its content only ever comes from the hub, on this device.
import { useEffect, useState } from 'react'
import { Link, Redirect, useLocalSearchParams } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { Ref } from '../../../../protocol/api/push.ts'
import { ApprovalsRes } from '../../../../protocol/api/read.ts'
import { actions, conn, store } from '../../src/conn/client.ts'
import { ApprovalCard } from '../../src/chat/ApprovalCard.tsx'
import { useConn } from '../../src/conn/client.ts'
import { useEntity } from '../../src/store/hooks.ts'
import { useViewing } from '../../src/ui/presence.tsx'

export default function ItemPage() {
  const { ref: raw } = useLocalSearchParams<{ ref: string }>()
  const ref = Ref.safeParse(raw).success ? raw! : null
  const [entity, id] = ref ? [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)] : ['', '']
  useViewing(ref)
  if (!ref) return <Shell><Text className="text-muted-foreground">这个链接不对</Text></Shell>
  if (entity === 'thread') return <Redirect href={{ pathname: '/thread/[id]', params: { id } }} />
  if (entity === 'approval') return <ApprovalItem id={id} />
  return <Other entity={entity} id={id} />
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView testID="item" className="flex-1 bg-background" contentContainerClassName="p-3 gap-3">
      <Link href="/waiting" className="text-muted-foreground">‹ 等你</Link>
      {children}
    </ScrollView>
  )
}

function ApprovalItem({ id }: { id: string }) {
  const a = useEntity(store, 'approval', id)
  const s = useConn()
  const [looked, setLooked] = useState<'no' | 'yes' | 'missing'>('no')
  // not in the store (decided, or older than the bootstrap): ask the hub for it
  useEffect(() => {
    if (a || s.s !== 'live' || looked !== 'no') return
    void conn.request('GET', '/api/v1/approvals', { query: { status: 'all' } }).then((r) => {
      const p = r.status === 200 ? ApprovalsRes.safeParse(r.body) : null
      const hit = p?.success ? p.data.approvals.find((x) => x.id === id) : undefined
      if (hit && p?.success) store.current('approval', hit, p.data.seq)
      setLooked(hit ? 'yes' : 'missing')
    }, () => setLooked('no'))
  }, [a, s.s, looked, id])
  useEffect(() => { if (a && s.s === 'live') void actions.markRead('approval', id) }, [a ? 1 : 0, s.s, id])
  return (
    <Shell>
      {a ? <ApprovalCard rec={a} /> : <Text className="text-muted-foreground">{looked === 'missing' ? '主上找不到这张卡了' : s.s === 'live' ? '在问主…' : '连上主之后显示'}</Text>}
    </Shell>
  )
}

function Other({ entity, id }: { entity: string; id: string }) {
  const task = useEntity(store, 'task', entity === 'task' ? id : undefined)
  const lane = task?.data.origin_lane
  const thread = lane ? store.threadByLane(lane) : undefined
  return (
    <Shell>
      {task ? <Text selectable className="text-foreground">任务 · {task.data.status}　{task.data.goal}</Text> : <Text className="text-muted-foreground">{entity === 'task' ? '这个任务不在这台上（任务页随 W4 来）' : '这类还打不开'}</Text>}
      {thread ? <Link href={{ pathname: '/thread/[id]', params: { id: thread.data.id } }} className="text-foreground underline">去所在的线程</Link> : null}
    </Shell>
  )
}
