// The main conversation (lane console:main), read-only until W3 adds the composer.
import { Link } from 'expo-router'
import { Text, View } from 'react-native'
import { store } from '../../src/conn/client.ts'
import { Timeline } from '../../src/chat/Timeline.tsx'
import { useList } from '../../src/store/hooks.ts'

const MAIN = 'console:main'

export default function Chat() {
  const threads = useList(store, 'thread')
  const main = threads.find((t) => t.data.lane === MAIN)
  return (
    <View testID="first-screen" className="flex-1 bg-background">
      <View className="flex-row items-center gap-3 px-3 py-2 border-b border-border">
        <Text className="text-foreground font-semibold flex-1">对话</Text>
        <Link href="/self" className="text-muted-foreground text-xs underline">它自己</Link>
      </View>
      <Timeline lane={MAIN} threadId={main?.data.id} />
    </View>
  )
}
