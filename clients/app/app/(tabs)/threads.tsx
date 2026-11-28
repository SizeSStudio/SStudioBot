// Threads, pinned on top, then newest first; open ones only (archived come with search, later waves). A new general
// thread is work or personal (personal stays off Feishu, §读5.1); it shows at once and opens when the hub has made it.
import { useMemo, useState } from 'react'
import { Link, useRouter } from 'expo-router'
import { FlatList, Text, TextInput, View } from 'react-native'
import { ThreadRes } from '../../../../protocol/api/write.ts'
import { actions, store, writes } from '../../src/conn/client.ts'
import { useList, useWrites } from '../../src/store/hooks.ts'
import { Btn, Refusal, Row } from '../../src/ui/kit.tsx'

const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

export default function Threads() {
  const router = useRouter()
  const all = useList(store, 'thread')
  const reads = useList(store, 'read')
  const [form, setForm] = useState<{ title: string; domain: 'work' | 'personal' } | null>(null)
  const refusal = useWrites(writes, (w) => w.refusal('threads'))
  const readUpto = useMemo(() => new Map(reads.map((r) => [r.data.ref, r.data.upto_ts ?? 0])), [reads])
  const threads = useMemo(() => all.filter((t) => t.data.status === 'open' && t.data.lane !== 'console:main')
    .sort((a, b) => Number(b.data.pinned) - Number(a.data.pinned) || (b.data.last_item_at ?? b.data.created_at) - (a.data.last_item_at ?? a.data.created_at)), [all])

  const create = async () => {
    if (!form) return
    const title = form.title.trim()
    setForm(null)
    const r = await actions.createThread({ ...(title ? { title } : {}), domain: form.domain })
    const t = r.ok ? ThreadRes.safeParse(r.body) : null
    if (t?.success) router.push({ pathname: '/thread/[id]', params: { id: t.data.thread.id } })
  }

  return (
    <View testID="threads" className="flex-1 bg-background">
      <View className="flex-row items-center px-3 py-2 border-b border-border">
        <Text className="text-foreground font-semibold flex-1">线程</Text>
        {form ? null : <Btn small label="新线程" onPress={() => setForm({ title: '', domain: 'work' })} testID="thread-new" />}
      </View>
      {form ? (
        <View className="px-3 py-2 gap-2 border-b border-border">
          <TextInput testID="thread-new-title" value={form.title} onChangeText={(title) => setForm({ ...form, title })} maxLength={200} placeholder="标题（可以不写）"
            className="border border-border rounded-lg p-2 text-foreground" />
          <Row>
            <Btn small label="工作" variant={form.domain === 'work' ? 'primary' : 'outline'} onPress={() => setForm({ ...form, domain: 'work' })} />
            <Btn small label="私人" variant={form.domain === 'personal' ? 'primary' : 'outline'} onPress={() => setForm({ ...form, domain: 'personal' })} testID="thread-new-personal" />
            <Text className="text-muted-foreground text-xs flex-1">{form.domain === 'personal' ? '私人的不进飞书，只在我的设备上' : ''}</Text>
          </Row>
          <Row>
            <Btn small variant="primary" label="开" onPress={() => void create()} testID="thread-new-create" />
            <Btn small label="算了" onPress={() => setForm(null)} />
          </Row>
        </View>
      ) : null}
      <View className="px-3"><Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)} /></View>
      <FlatList
        data={threads}
        keyExtractor={(t) => t.data.id}
        ListEmptyComponent={<Text className="text-muted-foreground p-6 text-center">还没有线程</Text>}
        renderItem={({ item: t }) => {
          const unread = (t.data.last_item_at ?? 0) > (readUpto.get(`thread:${t.data.id}`) ?? 0)
          const temp = t.data.id.startsWith('op:')
          const line = (
            <View className="gap-0.5">
              <Text className={`text-foreground ${unread ? 'font-semibold' : ''}`} numberOfLines={1}>
                {unread ? '● ' : ''}{t.data.pinned ? '📌 ' : ''}{t.data.title ?? '（没有标题）'}
              </Text>
              <Text className="text-muted-foreground text-xs">{t.data.domain === 'personal' ? '私人 · ' : ''}{t.data.kind} · {temp ? '在建…' : when(t.data.last_item_at ?? t.data.created_at)}</Text>
            </View>
          )
          return temp ? <View className="px-3 py-3 border-b border-border opacity-70">{line}</View> : (
            <Link href={{ pathname: '/thread/[id]', params: { id: t.data.id } }} className="px-3 py-3 border-b border-border">{line}</Link>
          )
        }}
      />
    </View>
  )
}
