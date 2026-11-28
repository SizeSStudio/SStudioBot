// 点链接先确认：显示完整地址、标出和链接文字不一致；确认后交给系统浏览器。
import { createContext, useContext, useState, type ReactNode } from 'react'
import { Linking, Modal, Pressable, Text, View } from 'react-native'
import { bridge } from '../bridge.ts'
import type { LinkVerdict } from '../render/links.ts'

type Ask = (v: LinkVerdict, text?: string) => void
const Ctx = createContext<Ask>(() => {})
export const useLinkGate = () => useContext(Ctx)

export function LinkGateProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ v: LinkVerdict; text?: string } | null>(null)
  const open = async (url: string) => {
    if (bridge) await bridge.link.open(url)
    else await Linking.openURL(url)
  }
  return (
    <Ctx.Provider value={(v, text) => setPending({ v, text })}>
      {children}
      <Modal transparent visible={pending !== null} onRequestClose={() => setPending(null)}>
        <View className="flex-1 items-center justify-center bg-black/40 p-6">
          <View className="w-full max-w-md rounded-lg bg-popover p-4 gap-3 border border-border">
            <Text className="text-foreground font-semibold">打开链接？</Text>
            <Text selectable className="text-muted-foreground text-xs" numberOfLines={6}>{pending?.v.url}</Text>
            {pending?.v.mismatch ? <Text className="text-destructive text-xs">链接文字和实际地址不是同一个网站：{pending.text}</Text> : null}
            {pending && !pending.v.ok ? <Text className="text-destructive text-xs">不放行：只开 http、https、mailto（这条是 {pending.v.scheme || '无法解析'}）</Text> : null}
            <View className="flex-row justify-end gap-2">
              <Pressable testID="link-cancel" onPress={() => setPending(null)} className="px-3 py-2 rounded-lg hover:bg-accent"><Text className="text-foreground">取消</Text></Pressable>
              {pending?.v.ok ? (
                <Pressable testID="link-open" onPress={() => { const u = pending.v.url; setPending(null); void open(u) }} className="px-3 py-2 rounded-lg bg-primary hover:opacity-80">
                  <Text className="text-primary-foreground">用浏览器打开</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </Modal>
    </Ctx.Provider>
  )
}
