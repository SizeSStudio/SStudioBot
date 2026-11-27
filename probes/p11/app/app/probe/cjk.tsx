// ④ 中文：加粗 4 种情形、三种字体行高、输入法组字时回车不发送
import { useMemo, useRef, useState } from 'react'
import { Platform, ScrollView, Text, TextInput, View, type NativeSyntheticEvent, type TextInputKeyPressEventData } from 'react-native'
import { Markdown } from '../../src/render/Markdown.tsx'
import { parseMarkdown } from '../../src/render/md.ts'
import { report } from '../../src/probe/report.ts'
import { keyInfo, shouldSend } from '../../src/render/ime.ts'

export const BOLD_CASES = [
  ['中文包英文', '这是**中文English中文**的情况'],
  ['英文包中文', 'This is **English中文English** case'],
  ['紧贴标点', '他说：**“加粗”**。然后**加粗。**结束'],
  ['跨行', '第一行**跨\n行加粗**结束'],
] as const

const FONTS = ['-apple-system, "PingFang SC"', '"Microsoft YaHei"', '"Noto Sans CJK SC"']
const GLYPHS = '永國龘齉 gjpqy ÁÉ 「」《》'

export default function Cjk() {
  const bold = useMemo(() => BOLD_CASES.map(([k, src]) => ({ k, tree: parseMarkdown(src) })), [])
  const [text, setText] = useState('')
  const [sent, setSent] = useState<string[]>([])
  const composing = useRef(false)
  const onKey = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const k = keyInfo(e.nativeEvent as TextInputKeyPressEventData & { isComposing?: boolean; keyCode?: number; shiftKey?: boolean })
    if (k.key === 'Enter' && Platform.OS === 'web') {
      if (!k.shiftKey) (e as unknown as { preventDefault(): void }).preventDefault()
      if (shouldSend({ ...k, isComposing: k.isComposing || composing.current })) { setSent(s => [...s, text]); setText(''); report('ime-send', { text }) }
    }
  }
  return (
    <ScrollView testID="screen" className="flex-1 bg-background" contentContainerClassName="p-4 gap-3">
      {bold.map(({ k, tree }) => <View key={k} testID={`bold-${k}`}><Text className="text-muted-foreground text-xs">{k}</Text><Markdown tree={tree} /></View>)}
      {FONTS.map(f => (
        <View key={f} testID="lh-row" className="border border-border">
          <Text style={{ fontFamily: f, fontSize: 16, lineHeight: 24 }} className="text-foreground"
            onTextLayout={e => report(`lh-${f}`, e.nativeEvent.lines.map(l => ({ h: Math.round(l.height), asc: Math.round(l.ascender), desc: Math.round(l.descender) })))}>{f}：{GLYPHS}</Text>
        </View>
      ))}
      <TextInput testID="ime-input" value={text} onChangeText={setText} onKeyPress={onKey} multiline
        onSubmitEditing={() => { setSent(s => [...s, text]); setText('') }}
        {...(Platform.OS === 'web' ? { onCompositionStart: () => { composing.current = true }, onCompositionEnd: () => { composing.current = false } } as object : {})}
        placeholder="输入法组字时按回车不应发送" className="border border-border rounded-lg p-2 text-foreground" />
      <Text testID="sent-count" className="text-muted-foreground">已发送 {sent.length} 条：{sent.join(' | ')}</Text>
    </ScrollView>
  )
}
