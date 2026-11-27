import { Tabs } from 'expo-router'

const TABS: [string, string][] = [['index', '对话'], ['ban', '办'], ['du', '读'], ['can', '参'], ['jue', '觉'], ['gai', '改']]

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      {TABS.map(([name, title]) => <Tabs.Screen key={name} name={name} options={{ title, tabBarIcon: () => null }} />)}
    </Tabs>
  )
}
