// Threads, newest first, pinned on top; open ones only (archived come with search, later waves).
import { useMemo } from 'react'
import { Link } from 'expo-router'
import { FlatList, Text, View } from 'react-native'
import { store } from '../../src/conn/client.ts'
import { useList } from '../../src/store/hooks.ts'

const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')

export default function Threads() {
  const all = useList(store, 'thread')
  const threads = useMemo(() => all.filter((t) => t.data.status === 'open' && t.data.lane !== 'console:main')
    .sort((a, b) => Number(b.data.pinned) - Number(a.data.pinned) || (b.data.last_item_at ?? b.data.created_at) - (a.data.last_item_at ?? a.data.created_at)), [all])
  return (
    <View testID="threads" className="flex-1 bg-background">
      <View className="px-3 py-2 border-b border-border"><Text className="text-foreground font-semibold">线程</Text></View>
      <FlatList
        data={threads}
        keyExtractor={(t) => t.data.id}
        ListEmptyComponent={<Text className="text-muted-foreground p-6 text-center">还没有线程</Text>}
        renderItem={({ item: t }) => (
          <Link href={{ pathname: '/thread/[id]', params: { id: t.data.id } }} className="px-3 py-3 border-b border-border">
            <View className="gap-0.5">
              <Text className="text-foreground" numberOfLines={1}>{t.data.pinned ? '📌 ' : ''}{t.data.title ?? '（没有标题）'}</Text>
              <Text className="text-muted-foreground text-xs">{t.data.kind} · {when(t.data.last_item_at ?? t.data.created_at)}</Text>
            </View>
          </Link>
        )}
      />
    </View>
  )
}
