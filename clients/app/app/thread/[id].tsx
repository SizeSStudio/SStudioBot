// One thread, read-only (W2).
import { Link, useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
import { store } from '../../src/conn/client.ts'
import { Timeline } from '../../src/chat/Timeline.tsx'
import { useEntity } from '../../src/store/hooks.ts'

export default function Thread() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const t = useEntity(store, 'thread', id)
  return (
    <View testID="thread" className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-3 py-2 border-b border-border">
        <Link href="/threads" className="text-muted-foreground">‹</Link>
        <Text className="text-foreground font-semibold flex-1" numberOfLines={1}>{t?.data.title ?? '线程'}</Text>
      </View>
      {t ? <Timeline lane={t.data.lane} threadId={t.data.id} /> : <Text className="text-muted-foreground p-6">没有这个线程（或者还没同步到）</Text>}
    </View>
  )
}
