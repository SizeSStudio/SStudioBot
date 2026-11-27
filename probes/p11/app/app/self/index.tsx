import { Link } from 'expo-router'
import { Text, View } from 'react-native'
export default function Self() {
  return (
    <View testID="screen" className="flex-1 bg-background p-6 gap-3">
      <Text className="text-foreground text-xl font-semibold">它自己</Text>
      <Link href="/self/devices" className="text-foreground underline">设备</Link>
    </View>
  )
}
