// 安卓：Legend List，倒序贴底；离底超过一屏停止跟随（07 列表）
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
