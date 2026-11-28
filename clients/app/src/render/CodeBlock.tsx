import { memo, useMemo, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { FOLD_PREVIEW, foldLines, highlight, splitRuns, TOKEN_COLORS, type Run } from './code.ts'

// 安卓不认 CSS 式的字体回退串，给了反而每个 span 都去查字体；用平台自带的等宽名
const MONO_FONT = Platform.select({ web: 'Menlo, Consolas, "Courier New", monospace', ios: 'Menlo', default: 'monospace' })
const MONO = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: 18 }

const FOLD_LINES = foldLines(Platform.OS)

const spans = (runs: Run[]) => runs.map((r, i) => (r.cls ? <Text key={i} style={{ color: TOKEN_COLORS[r.cls] }}>{r.text}</Text> : r.text))

export const CodeBlock = memo(function CodeBlock({ text, lang, open }: { text: string; lang: string; open: boolean }) {
  const lines = useMemo(() => text.split('\n'), [text])
  const [expanded, setExpanded] = useState(false)
  const folded = !expanded && lines.length > FOLD_LINES
  const shown = folded ? lines.slice(0, FOLD_PREVIEW).join('\n') : text
  // 正在流（fence 没收尾）的不高亮
  const runs = useMemo(() => (open ? [{ text: shown, cls: null }] : highlight(shown, lang)), [shown, lang, open])
  const byLine = useMemo(() => splitRuns(runs), [runs])
  return (
    <View className="rounded-lg bg-muted p-3 my-1">
      {/* 每行一个 Text：安卓的文字排版按 Text 分段，整块一个巨型 spannable 把 UI 线程卡 20 s 以上（P11 ⑤） */}
      {byLine.map((l, i) => <Text key={i} selectable style={MONO} className="text-foreground">{l.length ? spans(l) : ' '}</Text>)}
      {folded ? (
        <Pressable onPress={() => setExpanded(true)} className="mt-2"><Text className="text-muted-foreground text-xs">展开（共 {lines.length} 行）</Text></Pressable>
      ) : null}
    </View>
  )
})
