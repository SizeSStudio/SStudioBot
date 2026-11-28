import type { ReactElement } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'
import type { Msg } from './data.ts'

export type ChatListProps = {
  data: Msg[]
  renderItem: (p: { item: Msg; index: number }) => ReactElement
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
}
