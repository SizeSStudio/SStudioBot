import { Text, View } from 'react-native'
export default function NotFound() {
  return <View testID="not-found" className="flex-1 bg-background p-6"><Text className="text-foreground">路由不存在</Text></View>
}
