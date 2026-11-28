// Metro picks ChatList.web.tsx or ChatList.native.tsx; this is what tsc sees.
import type { ForwardRefExoticComponent, RefAttributes } from 'react'
import type { LegendListRef } from '@legendapp/list/react-native'
import type { ChatListProps, ChatRow } from './types.ts'
export declare const ChatList: ForwardRefExoticComponent<ChatListProps<ChatRow> & RefAttributes<LegendListRef>>
