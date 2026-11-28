import '../global.css'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { PortalHost } from '@rn-primitives/portal'
import { useUniwind } from 'uniwind'
import { LinkGateProvider } from '../src/ui/linkGate.tsx'

export default function Root() {
  const { theme } = useUniwind()
  const insets = useSafeAreaInsets()
  return (
    <LinkGateProvider>
      {/* 安卓 15 起强制 edge-to-edge：不留顶部安全区，标题压在状态栏下，按钮点不到 */}
      {/* 第三方组件不认 className（Uniwind 只映射 RN 自带组件），所以用 insets + View */}
      <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
        <Stack screenOptions={{ headerShown: false }} />
      </View>
      {/* 状态栏图标跟应用主题走，不跟系统 */}
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <PortalHost />
    </LinkGateProvider>
  )
}
