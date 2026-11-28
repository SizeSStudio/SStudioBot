// Devices (06 「设备管理」; W3: rename, remove and invite from here too, all 确认后才算). Names and platforms are what
// each device said about itself when it paired; this one is marked. Removing this device from the hub is the same as
// the hub dropping it (4410): it stops, and pairing again needs a new code. Unpairing here forgets the key on this
// device; the hub keeps listing it until it is removed.
// An invite is a password for a few minutes: the link and QR are shown only after I ask, and go when I close them.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'expo-router'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { InviteRes } from '../../../../protocol/api/devices.ts'
import type { Device } from '../../../../protocol/api/entities.ts'
import { actions, cryptoBackend, store, unpair, useConn, usePairing, writes } from '../../src/conn/client.ts'
import { refOf } from '../../src/conn/actions.ts'
import { device } from '../../src/device/device'
import { useList, useWrites } from '../../src/store/hooks.ts'
import { Btn, Refusal, Row } from '../../src/ui/kit.tsx'
import { QR } from '../../src/ui/QR.tsx'

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
      {paired ? <Invite /> : null}
      <Text className="text-muted-foreground text-xs">名字和平台是各设备配对时自己报的。</Text>
      {rows.map((d) => <DeviceRow key={d.data.id} d={d.data} self={d.data.id === paired?.device_id} />)}
    </ScrollView>
  )
}

function DeviceRow({ d, self }: { d: Device; self: boolean }) {
  const target = refOf('device', d.id)
  const { busy, refusal } = useWrites(writes, (w) => ({ busy: w.busy(target), refusal: w.refusal(target) }))
  const [name, setName] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  return (
    <View testID="device-row" className="rounded-lg border border-border p-3 gap-1">
      {name !== null ? (
        <Row>
          <TextInput testID="device-rename-input" value={name} onChangeText={setName} maxLength={100} className="flex-1 border border-border rounded-lg px-2 py-1 text-foreground" />
          <Btn small variant="primary" label="改" busy={busy} disabled={!name.trim()} onPress={() => { void actions.renameDevice(d.id, name.trim()).then((r) => { if (r.ok) setName(null) }) }} testID="device-rename-save" />
          <Btn small label="算了" onPress={() => setName(null)} />
        </Row>
      ) : (
        <Text className="text-foreground">{d.name}{self ? '（这台）' : ''}</Text>
      )}
      <Text className="text-muted-foreground text-xs">{d.platform ?? '?'} · {d.role} · {d.id.slice(0, 8)}{d.push ? ' · 手机推送' : ''}</Text>
      <Text className="text-muted-foreground text-xs">配对 {when(d.created_at)} · 最近 {when(d.last_seen)}{d.last_ip_masked ? ` · ${d.last_ip_masked}` : ''}</Text>
      {removing ? (
        <Row>
          <Text className="text-destructive text-xs flex-1">{self ? '删掉这台：它马上断开，要用得重新配对。' : '删掉后它连不上了，同一把钥匙也不能再配。'}</Text>
          <Btn small label="算了" onPress={() => setRemoving(false)} />
          <Btn small variant="destructive" label="删掉" busy={busy} onPress={() => { void actions.removeDevice(d.id).then(() => setRemoving(false)) }} testID="device-remove-confirm" />
        </Row>
      ) : name === null ? (
        <Row>
          <Btn small variant="ghost" label="改名" busy={busy} onPress={() => setName(d.name)} testID="device-rename" />
          <Btn small variant="ghost" label="删掉" busy={busy} onPress={() => setRemoving(true)} testID="device-remove" />
        </Row>
      ) : null}
      <Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)} />
    </View>
  )
}

function Invite() {
  const { busy, refusal } = useWrites(writes, (w) => ({ busy: w.busy('invite'), refusal: w.refusal('invite') }))
  const [inv, setInv] = useState<InviteRes | null>(null)
  const [show, setShow] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    if (!inv) return
    const t = setInterval(() => { tick((n) => n + 1); if (Date.now() >= inv.expires) setInv(null) }, 1000)
    return () => clearInterval(t)
  }, [inv])
  const make = async () => {
    const r = await actions.invite()
    const p = r.ok ? InviteRes.safeParse(r.body) : null
    if (p?.success) { setInv(p.data); setShow(false) }
  }
  return (
    <View className="rounded-lg border border-border p-3 gap-2">
      <Text className="text-foreground font-semibold">加一台</Text>
      {inv ? (
        <View className="gap-2">
          <Text className="text-muted-foreground text-xs">这个码就是密码：{Math.max(0, Math.ceil((inv.expires - Date.now()) / 60_000))} 分钟内有效，只能用一次。在新设备上扫码，或粘贴链接。</Text>
          {!inv.relay_enabled ? <Text className="text-destructive text-xs">主的中继还没开（relay.enabled）：码能用，但开之前新设备连不上。</Text> : null}
          {show ? (
            <>
              <View className="self-start p-2 bg-white rounded"><QR text={inv.link} /></View>
              <Text testID="invite-link" selectable className="text-foreground text-xs">{inv.link}</Text>
            </>
          ) : <Btn small label="显示码" onPress={() => setShow(true)} testID="invite-show" />}
          <Btn small label="不用了" onPress={() => setInv(null)} />
        </View>
      ) : <Btn small label="出一个配对码" busy={busy} onPress={() => void make()} testID="invite-make" />}
      <Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)} />
    </View>
  )
}
