// Pairing (06 「配对」): paste the link or the v1. code, open a sstudiobot://pair link, or scan it (Android). The code
// is checked here, then the device makes a fresh key and the connection pairs; on the desktop main checks it again and
// reloads the page so the CSP lets it reach that relay.
import { useEffect, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { defaultName, pair, useConn, usePairing } from '../src/conn/client.ts'
import { device } from '../src/device/device'
import { onIncomingLink, takeIncomingLink } from '../src/pair/incoming.ts'
import { Scanner } from '../src/pair/Scanner'

export default function Pair() {
  const router = useRouter()
  const s = useConn()
  const paired = usePairing()
  const [code, setCode] = useState(() => takeIncomingLink() ?? '')
  const [name, setName] = useState(defaultName)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => onIncomingLink(() => setCode(takeIncomingLink() ?? '')), [])
  useEffect(() => { if (busy && s.s === 'live') router.replace('/') }, [busy, s.s, router])
  useEffect(() => { if (s.s === 'pair_failed') { setBusy(false); setMsg(`主没收这个码：${s.why}`) } }, [s])

  const accept = async (text = code) => {
    setMsg('')
    setBusy(true)
    const r = await pair(text, name).catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
    if (!r.ok) { setBusy(false); setMsg(r.error) }
    else setMsg('配对中…')
  }

  if (!device.canPair) return <View className="flex-1 p-6"><Text className="text-foreground">浏览器里不能配对：用桌面 App 或安卓。</Text></View>
  if (paired && !busy) return <View className="flex-1 p-6 gap-2"><Text className="text-foreground">这台已经配对了。要换一个主，先在「它自己 → 设备」里解除配对。</Text></View>
  return (
    <View testID="screen" className="flex-1 bg-background p-6 gap-3">
      <Text className="text-foreground text-lg font-semibold">配对</Text>
      <Text className="text-muted-foreground text-xs">在主上跑 sbot pair（或在私聊里发 /pair）拿码，10 分钟内有效，只能用一次。</Text>
      <TextInput testID="pair-input" value={code} onChangeText={setCode} placeholder="粘贴 sstudiobot://pair#v1… 或 v1.…" autoCapitalize="none" autoCorrect={false} secureTextEntry={false}
        className="border border-border rounded-lg p-2 text-foreground" />
      <TextInput testID="pair-name" value={name} onChangeText={setName} maxLength={100} placeholder="这台设备叫什么" className="border border-border rounded-lg p-2 text-foreground" />
      <View className="flex-row gap-2">
        <Pressable testID="pair-accept" disabled={busy || !code.trim()} onPress={() => void accept()} className={`px-3 py-2 rounded-lg bg-primary ${busy || !code.trim() ? 'opacity-50' : ''}`}>
          <Text className="text-primary-foreground">配对</Text>
        </Pressable>
      </View>
      <Scanner onCode={(t) => { setCode(t); void accept(t) }} />
      <Text testID="pair-msg" className="text-foreground">{msg}</Text>
    </View>
  )
}
