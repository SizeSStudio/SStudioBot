import '../global.css'
import { useEffect } from 'react'
import { Stack, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useUniwind } from 'uniwind'
import { boot, useConn } from '../src/conn/client.ts'
import { device } from '../src/device/device'
import { setIncomingLink } from '../src/pair/incoming.ts'
import { setupNotifications } from '../src/push/notify'
import { ConnBanner, UpgradeScreen } from '../src/ui/ConnBanner.tsx'
import { LinkGateProvider } from '../src/ui/linkGate.tsx'
import { PresenceRoot } from '../src/ui/presence.tsx'

export default function Root() {
  const { theme } = useUniwind()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const s = useConn()
  useEffect(() => { void boot() }, [])
  // a sstudiobot://pair link from the OS (Electron: via main; Android: Linking) opens the pair screen, filled in
  useEffect(() => device.onLink((l) => { setIncomingLink(l); router.push('/pair') }), [router])
  // a tapped notification opens its item (Android; inert without FCM)
  useEffect(() => setupNotifications((route) => router.push(route as never)), [router])
  return (
    <LinkGateProvider>
      {/* Android 15 forces edge-to-edge: leave the top inset or the header sits under the status bar */}
      {/* third-party components ignore className (Uniwind maps RN's own only), hence insets + View */}
      <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
        {s.s === 'upgrade' ? <UpgradeScreen min={s.min} /> : (
          <PresenceRoot>
            <ConnBanner />
            <Stack screenOptions={{ headerShown: false }} />
          </PresenceRoot>
        )}
      </View>
      {/* status bar icons follow the app's theme, not the system's */}
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
    </LinkGateProvider>
  )
}
