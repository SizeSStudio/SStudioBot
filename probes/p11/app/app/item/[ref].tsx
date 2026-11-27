import { useLocalSearchParams } from 'expo-router'
import { Text, View } from 'react-native'
export default function Item() {
  const { ref } = useLocalSearchParams<{ ref: string }>()
  return <View testID="screen" className="flex-1 bg-background p-6"><Text className="text-foreground">条目 {ref}</Text></View>
}
