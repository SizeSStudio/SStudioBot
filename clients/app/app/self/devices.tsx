// Devices (06 「设备管理」, read-only in W2: rename and remove are on hub-admin.sock until W3). Names and platforms
// are what each device said about itself when it paired; this one is marked. Unpairing here forgets the key on this
// device; the hub keeps listing it until it is removed there (`sbot devices rm`).
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'expo-router'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { cryptoBackend, store, unpair, useConn, usePairing } from '../../src/conn/client.ts'
import { device } from '../../src/device/device'
import { useList } from '../../src/store/hooks.ts'

const when = (ts: number | null) => (ts ? new Date(ts).toLocaleString('zh-CN') : '—')

export default function Devices() {
  const list = useList(store, 'device')
  const paired = usePairing()
  const s = useConn()
  const [keyInfo, setKeyInfo] = useState('…')
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { void device.keyInfo().then(setKeyInfo, () => setKeyInfo('读不到')) }, [paired])
  const rows = useMemo(() => list.filter((d) => d.data.removed_at === null).sort((a, b) => (b.data.last_seen ?? 0) - (a.data.last_seen ?? 0)), [list])
  return (
    <ScrollView testID="devices" className="flex-1 bg-background" contentContainerClassName="p-6 gap-3">
      <Link href="/self" className="text-muted-foreground">‹ 它自己</Link>
      <Text className="text-foreground text-xl font-semibold">设备</Text>
      <View className="rounded-lg border border-border p-3 gap-1">
        <Text className="text-foreground font-semibold">这台</Text>
        <Text className="text-muted-foreground text-xs">连接：{s.s}　密钥：{keyInfo}　加密：{cryptoBackend}</Text>
        {paired ? <Text selectable className="text-muted-foreground text-xs">设备 id {paired.device_id.slice(0, 8)} · 中继 {new URL(paired.relay).host}</Text> : <Link href="/pair" className="text-foreground underline">去配对</Link>}
        {paired ? (confirm ? (
          <View className="flex-row gap-2 items-center">
            <Text className="text-destructive text-xs flex-1">解除后这台的密钥就删了，要用得重新配对。</Text>
            <Pressable onPress={() => setConfirm(false)} className="px-2 py-1 rounded border border-border"><Text className="text-foreground text-xs">算了</Text></Pressable>
            <Pressable testID="unpair" onPress={() => void unpair().then(() => setConfirm(false))} className="px-2 py-1 rounded bg-destructive"><Text className="text-white text-xs">解除配对</Text></Pressable>
          </View>
        ) : <Pressable onPress={() => setConfirm(true)} className="self-start px-2 py-1 rounded border border-border"><Text className="text-foreground text-xs">解除配对</Text></Pressable>) : null}
      </View>
      <Text className="text-muted-foreground text-xs">名字和平台是各设备配对时自己报的。改名、删设备在主上用 sbot devices（W3 起这里也能）。</Text>
      {rows.map((d) => (
        <View key={d.data.id} className="rounded-lg border border-border p-3 gap-0.5">
          <Text className="text-foreground">{d.data.name}{d.data.id === paired?.device_id ? '（这台）' : ''}</Text>
          <Text className="text-muted-foreground text-xs">{d.data.platform ?? '?'} · {d.data.role} · {d.data.id.slice(0, 8)}</Text>
          <Text className="text-muted-foreground text-xs">配对 {when(d.data.created_at)} · 最近 {when(d.data.last_seen)}{d.data.last_ip_masked ? ` · ${d.data.last_ip_masked}` : ''}</Text>
        </View>
      ))}
    </ScrollView>
  )
}
