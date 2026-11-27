import { Link } from 'expo-router'
import { Text, View } from 'react-native'

export function Placeholder({ title }: { title: string }) {
  return (
    <View testID="screen" className="flex-1 bg-background p-6 gap-3">
      <Text className="text-foreground text-xl font-semibold">{title}</Text>
      <Link href="/probe" className="text-muted-foreground underline">探针页</Link>
    </View>
  )
}
