// The few controls the write screens share: a button that knows 处理中 / 等连上, and the in-place line for a write the
// hub refused. Everything the hub says (its `error`) is shown as plain text.
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { refusalText, type Op } from '../conn/writes.ts'

type Variant = 'primary' | 'outline' | 'ghost' | 'destructive'
const BOX: Record<Variant, string> = {
  primary: 'bg-primary', outline: 'border border-border', ghost: '', destructive: 'bg-destructive',
}
const LABEL: Record<Variant, string> = {
  primary: 'text-primary-foreground', outline: 'text-foreground', ghost: 'text-muted-foreground', destructive: 'text-white',
}

/** `busy`: the op this button started and the hub hasn't finished (it shows why and can't be pressed again). */
export function Btn({ label, onPress, variant = 'outline', busy, disabled, testID, small }: {
  label: string; onPress: () => void; variant?: Variant; busy?: Op | undefined; disabled?: boolean; testID?: string; small?: boolean
}) {
  const off = !!busy || !!disabled
  const text = busy ? (busy.state === 'queued' ? '等连上…' : '处理中…') : label
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ disabled: off, busy: !!busy }} disabled={off} onPress={onPress}
      className={`${small ? 'px-2 py-1' : 'px-3 py-2'} rounded-lg ${BOX[variant]} ${off ? 'opacity-50' : 'hover:opacity-80'}`}>
      <Text className={`${LABEL[variant]} ${small ? 'text-xs' : 'text-sm'}`}>{text}</Text>
    </Pressable>
  )
}

export function Row({ children, wrap }: { children: ReactNode; wrap?: boolean }) {
  return <View className={`flex-row items-center gap-2 ${wrap ? 'flex-wrap' : ''}`}>{children}</View>
}

/** A refused write, where it happened: what it means, the hub's reason, a way to make it go away. */
export function Refusal({ op, onDismiss, extra }: { op: Op | undefined; onDismiss: (id: string) => void; extra?: ReactNode }) {
  if (!op) return null
  return (
    <View testID="refusal" className="rounded-lg border border-destructive p-2 gap-1">
      <Text className="text-destructive text-xs">{refusalText(op.status ?? 0)}{op.error ? `（${op.error}）` : ''}</Text>
      {extra}
      <Pressable onPress={() => onDismiss(op.id)} className="self-end px-2 py-0.5"><Text className="text-muted-foreground text-xs">知道了</Text></Pressable>
    </View>
  )
}
