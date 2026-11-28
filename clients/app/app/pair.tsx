// 配对：系统唤起、粘贴配对码；扫码（expo-camera）只在安卓（真机待测）
import { useEffect, useState } from 'react'
import { Platform, Pressable, Text, TextInput, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { bridge } from '../src/bridge.ts'
import { parsePairLink } from '../src/device/pairLink.ts'
import { report } from '../src/probe/report.ts'

export default function Pair() {
  const params = useLocalSearchParams<{ link?: string }>()
  const [code, setCode] = useState(params.link ?? '')
  const [msg, setMsg] = useState('')
  useEffect(() => { bridge?.pair.onLink(l => { setCode(l); report('pair-onlink', { gotLink: true }) }) }, [])
  const accept = async () => {
    const p = parsePairLink(code)
    if (!p.ok) { setMsg(`配对码不对：${p.error}`); return }
    if (bridge) { const r = await bridge.pair.accept(code); setMsg(r.ok ? '已配对' : `拒绝：${r.error}`); report('pair-accept', r) }
    else setMsg('安卓：交给本地模块（真机待测）')
  }
  return (
    <View testID="screen" className="flex-1 bg-background p-6 gap-3">
      <Text className="text-foreground text-lg font-semibold">配对</Text>
      <TextInput testID="pair-input" value={code} onChangeText={setCode} placeholder="粘贴 sstudiobot://pair#v1… 或 v1.…" className="border border-border rounded-lg p-2 text-foreground" />
      <Pressable testID="pair-accept" onPress={() => void accept()} className="self-start px-3 py-2 rounded-lg bg-primary"><Text className="text-primary-foreground">配对</Text></Pressable>
      {Platform.OS !== 'web' ? <Text className="text-muted-foreground text-xs">扫码：expo-camera（真机待测）</Text> : null}
      <Text testID="pair-msg" className="text-foreground">{msg}</Text>
    </View>
  )
}
