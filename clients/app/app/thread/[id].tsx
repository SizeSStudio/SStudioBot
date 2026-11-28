// One thread: rename, pin, archive (optimistic), the timeline, the composer.
import { useState } from 'react'
import { Link, useLocalSearchParams } from 'expo-router'
import { Text, TextInput, View } from 'react-native'
import { actions, store, writes } from '../../src/conn/client.ts'
import { refOf } from '../../src/conn/actions.ts'
import { Composer } from '../../src/chat/Composer.tsx'
import { Timeline } from '../../src/chat/Timeline.tsx'
import { useEntity, useWrites } from '../../src/store/hooks.ts'
import { Btn, Refusal, Row } from '../../src/ui/kit.tsx'
import { useViewing } from '../../src/ui/presence.tsx'

export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const t = useEntity(store, 'thread', id)
  const refusal = useWrites(writes, (w) => (id ? w.refusal(refOf('thread', id)) : undefined))
  const [rename, setRename] = useState<string | null>(null)
  useViewing(id ? `thread:${id}` : null)
  const d = t?.data
  const editable = !!d && d.kind !== 'feishu' && d.lane !== 'console:main'
  return (
    <View testID="thread" className="flex-1 bg-background">
      <View className="flex-row items-center gap-2 px-3 py-2 border-b border-border">
        <Link href="/threads" className="text-muted-foreground">‹</Link>
        {rename !== null && d ? (
          <>
            <TextInput testID="thread-rename-input" value={rename} onChangeText={setRename} maxLength={200} autoFocus className="flex-1 border border-border rounded-lg px-2 py-1 text-foreground" />
            <Btn small variant="primary" label="改" onPress={() => { void actions.patchThread(d.id, { title: rename.trim() || null }); setRename(null) }} testID="thread-rename-save" />
            <Btn small label="算了" onPress={() => setRename(null)} />
          </>
        ) : (
          <>
            <Text className="text-foreground font-semibold flex-1" numberOfLines={1}>{d?.domain === 'personal' ? '私人 · ' : ''}{d?.title ?? '线程'}</Text>
            {editable && d ? (
              <Row>
                <Btn small variant="ghost" label="改名" onPress={() => setRename(d.title ?? '')} testID="thread-rename" />
                <Btn small variant="ghost" label={d.pinned ? '取消置顶' : '置顶'} onPress={() => void actions.patchThread(d.id, { pinned: !d.pinned })} testID="thread-pin" />
                <Btn small variant="ghost" label={d.status === 'archived' ? '拿回来' : '收起'} onPress={() => void actions.patchThread(d.id, { status: d.status === 'archived' ? 'open' : 'archived' })} testID="thread-archive" />
              </Row>
            ) : null}
          </>
        )}
      </View>
      <View className="px-3"><Refusal op={refusal} onDismiss={(oid) => writes.dismiss(oid)} /></View>
      {d ? (
        <>
          <Timeline lane={d.lane} threadId={d.id} />
          <Composer thread={d} />
        </>
      ) : <Text className="text-muted-foreground p-6">没有这个线程（或者还没同步到）</Text>}
    </View>
  )
}
