import type { ReactElement } from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native'

/** One row of a conversation: a stored row, or text still streaming. */
export type ChatRow = { key: string }

export type ChatListProps<T extends ChatRow> = {
  data: T[]
  renderItem: (p: { item: T; index: number }) => ReactElement
  onScroll?: (e: NativeSyntheticEvent<NativeScrollEvent>) => void
  ListHeaderComponent?: ReactElement | null
}
