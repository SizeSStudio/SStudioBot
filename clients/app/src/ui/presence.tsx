// The platform side of presence (conn/presence.ts): AppState says front or back (RN Web maps it to the page's
// visibility), touches anywhere and, on the web, pointer presses, keys and the wheel count as activity; a screen says
// what it shows.
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from 'react'
import { AppState, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { conn, presence } from '../conn/client.ts'

export function PresenceRoot({ children }: { children: ReactNode }) {
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      presence.foreground(s === 'active')
      if (s === 'active') conn.retryNow() // back in front: don't sit out the backoff (07 「安卓后台」)
    })
    const doc = typeof document !== 'undefined' ? document : null
    const on = () => presence.activity()
    doc?.addEventListener('pointerdown', on, { passive: true })
    doc?.addEventListener('keydown', on, { passive: true })
    doc?.addEventListener('wheel', on, { passive: true })
    return () => {
      sub.remove()
      doc?.removeEventListener('pointerdown', on)
      doc?.removeEventListener('keydown', on)
      doc?.removeEventListener('wheel', on)
    }
  }, [])
  return <View className="flex-1" onTouchStart={() => presence.activity()}>{children}</View>
}

export function useForeground(): boolean {
  return useSyncExternalStore(presence.subscribe, () => presence.isForeground, () => presence.isForeground)
}

/** While this screen is focused, `ref` is what I'm viewing (thread:<id>, approval:<id>). */
export function useViewing(ref: string | null | undefined): void {
  useFocusEffect(useCallback(() => {
    if (!ref) return
    presence.view(ref)
    return () => { if (presence.viewing === ref) presence.view(null) }
  }, [ref]))
}
