// ① 明暗切换、hover、弹出层定位
import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { Uniwind, useUniwind } from 'uniwind'
import * as Popover from '@rn-primitives/popover'
import { report } from '../../src/probe/report.ts'

// 原生上没有 getComputedStyle：用 measureInWindow 报弹出层相对按钮的位置
const triggerRef = { current: null as View | null }

const content = (
  <Popover.Content side="bottom" align="start" sideOffset={6} testID="popover-content" className="w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
    // 网页的 onLayout 事件没有 currentTarget；网页的位置由 desktop/probe.ts 用 getBoundingClientRect 量
    onLayout={e => { if (Platform.OS === 'web') return; const t = e.currentTarget as unknown as View | undefined; t?.measureInWindow?.((x, y, w, h) => { triggerRef.current?.measureInWindow((tx, ty, tw, th) => report('ui-popover', { trigger: { x: tx, bottom: ty + th, w: tw }, content: { x, y, w, h } })) }) }}>
    <Text className="text-foreground">弹出层内容：应贴着按钮下方、左对齐。</Text>
  </Popover.Content>
)

export default function UiProbe() {
  const { theme } = useUniwind()
  const [hovered, setHovered] = useState(false)
  const box = useRef<View>(null)
  useEffect(() => { report('ui-theme', { theme }) }, [theme])
  return (
    <View testID="screen" className="flex-1 bg-background p-6 gap-4">
      <Text testID="theme-label" className="text-foreground text-lg">当前：{theme}</Text>
      <View className="flex-row gap-2">
        {(['light', 'dark', 'system'] as const).map(t => (
          <Pressable key={t} testID={`theme-${t}`} onPress={() => Uniwind.setTheme(t)} className="px-3 py-2 rounded-lg bg-primary hover:opacity-70 active:opacity-50">
            <Text className="text-primary-foreground">{t}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable testID="hover-target" ref={box} onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
        className="p-4 rounded-lg border border-border bg-background hover:bg-accent">
        <Text className="text-foreground">悬停这里（hover:bg-accent）{hovered ? ' · hover 中' : ''}</Text>
      </Pressable>
      <Popover.Root>
        <Popover.Trigger ref={r => { triggerRef.current = r as unknown as View }} testID="popover-trigger" className="self-start px-3 py-2 rounded-lg border border-border hover:bg-accent">
          <Text className="text-foreground">弹出层</Text>
        </Popover.Trigger>
        <Popover.Portal>
          {/* Radix 的 Portal 只能套一个子元素：网页上只放 Content，Overlay 只在原生放（reusables 同样） */}
          {Platform.OS === 'web' ? content : <><Popover.Overlay style={{ position: 'absolute', inset: 0 }} />{content}</>}
        </Popover.Portal>
      </Popover.Root>
      <View className="flex-row gap-2">
        {['bg-background', 'bg-muted', 'bg-primary', 'bg-accent', 'bg-popover'].map(c => <View key={c} testID={`swatch-${c}`} className={`w-10 h-10 rounded-lg border border-border ${c}`} />)}
      </View>
    </View>
  )
}
