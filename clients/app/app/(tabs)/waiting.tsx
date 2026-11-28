// 等你: every pending card, oldest deadline first (snoozed ones last, marked). The cards are the same as in the
// timeline; this is just all of them in one place.
import { useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { store } from '../../src/conn/client.ts'
import { ApprovalCard } from '../../src/chat/ApprovalCard.tsx'
import { useList } from '../../src/store/hooks.ts'

export default function Waiting() {
  const all = useList(store, 'approval')
  const pending = useMemo(() => all.filter((a) => a.data.status === 'pending').sort((a, b) =>
    Number(!!a.data.snooze) - Number(!!b.data.snooze) || (a.data.expires_at ?? Infinity) - (b.data.expires_at ?? Infinity) || a.data.ts - b.data.ts), [all])
  return (
    <View testID="waiting" className="flex-1 bg-background">
      <View className="px-3 py-2 border-b border-border"><Text className="text-foreground font-semibold">等你{pending.length ? ` ${pending.length}` : ''}</Text></View>
      <ScrollView contentContainerClassName="py-2">
        {pending.length ? pending.map((a) => <ApprovalCard key={a.data.id} rec={a} />) : <Text className="text-muted-foreground p-6 text-center">没有等你定的</Text>}
      </ScrollView>
    </View>
  )
}
