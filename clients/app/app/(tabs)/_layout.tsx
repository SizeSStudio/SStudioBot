// The main conversation, the thread list, 等你 (pending cards) and 任务 (W4). 读 · 参 · 觉 · 改 come with their waves (09).
import { Tabs } from 'expo-router'

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: '对话', tabBarIcon: () => null }} />
      <Tabs.Screen name="threads" options={{ title: '线程', tabBarIcon: () => null }} />
      <Tabs.Screen name="waiting" options={{ title: '等你', tabBarIcon: () => null }} />
      <Tabs.Screen name="tasks" options={{ title: '任务', tabBarIcon: () => null }} />
    </Tabs>
  )
}
