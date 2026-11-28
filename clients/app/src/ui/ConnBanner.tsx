// The connection's state in one line above the content (07 「连接」): nothing when live; «等主上线» on 4404; the retry
// countdown with "retry now"; a stop with "pair again" when the hub refused or removed this device.
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { conn, unpair, useConn, usePairing } from '../conn/client.ts'

export function ConnBanner() {
  const s = useConn()
  const paired = usePairing()
  const router = useRouter()
  const [, tick] = useState(0)
  useEffect(() => {
    if (s.s !== 'retry' && s.s !== 'waiting_hub') return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [s.s])
  const wait = 'at' in s ? Math.max(0, Math.ceil((s.at - Date.now()) / 1000)) : 0

  let text: string | null = null
  let action: { label: string; run: () => void } | null = null
  switch (s.s) {
    case 'live': return null
    case 'idle': case 'stopped':
      if (paired) return null
      text = '还没配对'; action = { label: '去配对', run: () => router.push('/pair') }; break
    case 'connecting': case 'handshake': case 'auth': text = '连接中…'; break
    case 'sync': text = '同步中…'; break
    case 'retry': text = `断了，${wait} 秒后重连`; action = { label: '现在重连', run: () => conn.retryNow() }; break
    case 'waiting_hub': text = `等主上线（${wait} 秒后再试）`; action = { label: '现在试', run: () => conn.retryNow() }; break
    case 'auth_failed':
      text = s.why === 'removed' ? '这台设备在主上被删了' : '主不认这台设备了'
      action = { label: '重新配对', run: () => void unpair().then(() => router.push('/pair')) }; break
    case 'pair_failed': text = `配对没成：${s.why}`; action = { label: '换个码', run: () => router.push('/pair') }; break
    case 'upgrade': return null // the root layout shows the full-screen notice
  }
  return (
    <View testID="conn-banner" className="flex-row items-center gap-2 px-3 py-1 bg-muted border-b border-border">
      <Text className="text-foreground text-xs flex-1">{text}</Text>
      {action ? <Pressable onPress={action.run} className="px-2 py-0.5 rounded border border-border"><Text className="text-foreground text-xs">{action.label}</Text></Pressable> : null}
    </View>
  )
}

export function UpgradeScreen({ min }: { min: number | null }) {
  return (
    <View testID="upgrade" className="flex-1 items-center justify-center p-6 gap-2 bg-background">
      <Text className="text-foreground text-lg font-semibold">要升级 App</Text>
      <Text className="text-muted-foreground text-center">主需要更新的协议{min !== null ? `（至少 ${min}）` : ''}。这一版不连了，装新版再开。</Text>
    </View>
  )
}
