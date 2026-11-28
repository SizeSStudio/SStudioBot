// 网页先用 Legend List（T26）；P11 ② 不过就换 @tanstack/react-virtual
import { forwardRef } from 'react'
import { LegendList, type LegendListRef } from '@legendapp/list/react-native'
import type { ChatListProps } from './types.ts'

export const ChatList = forwardRef<LegendListRef, ChatListProps>(function ChatList(p, ref) {
  return (
    <LegendList
      ref={ref}
      data={p.data}
      keyExtractor={m => m.id}
      renderItem={p.renderItem}
      estimatedItemSize={80}
      initialScrollAtEnd
      alignItemsAtEnd
      maintainScrollAtEnd
      maintainScrollAtEndThreshold={0.1}
      maintainVisibleContentPosition
      recycleItems={false}
      onScroll={p.onScroll}
      style={{ flex: 1 }}
    />
  )
})
