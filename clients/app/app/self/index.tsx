// 它自己: 省心 (§寸6: only narrows pushes; only I switch it, here or in a DM I typed), phone notifications (Android),
// devices.
import { Link } from 'expo-router'
import { Text, View } from 'react-native'
import { actions, push, store, usePush, writes } from '../../src/conn/client.ts'
import { useEntity, useWrites } from '../../src/store/hooks.ts'
import { Btn, Refusal, Row } from '../../src/ui/kit.tsx'

const PUSH: Record<string, string> = {
  unknown: '…', unavailable: '这一版没有手机推送（没接 Firebase）', off: '关着：推送走渠道', hub_off: '主那边还没开手机推送：推送走渠道',
  denied: '系统没给通知权限：推送走渠道', on: '开着', error: '没连上',
}

export default function Self() {
  const ease = useEntity(store, 'ease', 'ease')?.data
  const { busy, refusal } = useWrites(writes, (w) => ({ busy: w.busy('ease'), refusal: w.refusal('ease') }))
  const p = usePush()
  return (
    <View testID="screen" className="flex-1 bg-background p-6 gap-4">
      <Link href="/" className="text-muted-foreground">‹ 对话</Link>
      <Text className="text-foreground text-xl font-semibold">它自己</Text>

      <View className="rounded-lg border border-border p-3 gap-2">
        <Row>
          <Text className="text-foreground font-semibold flex-1">省心{ease?.on && ease.day ? ` · 第 ${ease.day} 天` : ''}</Text>
          <Btn small variant={ease?.on ? 'primary' : 'outline'} label={ease?.on ? '开着（点了关）' : '关着（点了开）'} busy={busy} disabled={!ease}
            onPress={() => void actions.setEase(!ease?.on)} testID="ease-toggle" />
        </Row>
        <Text className="text-muted-foreground text-xs">只少推一些；看得到的、闸门、审批、预算都不变。它自己不会切。</Text>
        <Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)} />
      </View>

      {p.s !== 'unavailable' ? (
        <View className="rounded-lg border border-border p-3 gap-2">
          <Row>
            <Text className="text-foreground font-semibold flex-1">手机通知</Text>
            <Btn small label={p.s === 'off' ? '打开' : '关掉'} onPress={() => void push.setEnabled(p.s === 'off')} testID="push-toggle" />
          </Row>
          <Text className="text-muted-foreground text-xs">{PUSH[p.s]}{p.s === 'error' && p.why ? `（${p.why}）` : ''}</Text>
        </View>
      ) : null}

      <Link href="/self/devices" className="text-foreground underline">设备</Link>
      <Link href="/self/nodes" testID="nodes-link" className="text-foreground underline">节点</Link>
    </View>
  )
}
