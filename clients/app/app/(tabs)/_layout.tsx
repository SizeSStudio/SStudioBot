// W2: the main conversation and the thread list, read-only. 办 · 读 · 参 · 觉 · 改 come with their waves (09).
import { Tabs } from 'expo-router'

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '对话', tabBarIcon: () => null }} />
      <Tabs.Screen name="threads" options={{ title: '线程', tabBarIcon: () => null }} />
    </Tabs>
  )
}
