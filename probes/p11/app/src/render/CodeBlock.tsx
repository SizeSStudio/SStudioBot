import { memo, useMemo, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { FOLD_LINES, FOLD_PREVIEW, highlight, splitRuns, TOKEN_COLORS, type Run } from './code.ts'

// 安卓不认 CSS 式的字体回退串，给了反而每个 span 都去查字体；用平台自带的等宽名
const MONO_FONT = Platform.select({ web: 'Menlo, Consolas, "Courier New", monospace', ios: 'Menlo', default: 'monospace' })
const MONO = { fontFamily: MONO_FONT, fontSize: 12, lineHeight: 18 }

// 探针用：one = 整块一个 Text（旧做法），lines = 每行一个 Text（默认）
export const codeBlockMode: { value: 'one' | 'lines'; font: 'platform' | 'css' } = { value: 'lines', font: 'platform' }

const spans = (runs: Run[]) => runs.map((r, i) => (r.cls ? <Text key={i} style={{ color: TOKEN_COLORS[r.cls] }}>{r.text}</Text> : r.text))

export const CodeBlock = memo(function CodeBlock({ text, lang, open }: { text: string; lang: string; open: boolean }) {
  const lines = useMemo(() => text.split('\n'), [text])
  const [expanded, setExpanded] = useState(false)
  const folded = !expanded && lines.length > FOLD_LINES
  const shown = folded ? lines.slice(0, FOLD_PREVIEW).join('\n') : text
  // 正在流（fence 没收尾）的不高亮
  const runs = useMemo(() => (open ? [{ text: shown, cls: null }] : highlight(shown, lang)), [shown, lang, open])
  const byLine = useMemo(() => (codeBlockMode.value === 'lines' ? splitRuns(runs) : null), [runs])
  const style = codeBlockMode.font === 'css' ? { ...MONO, fontFamily: 'Menlo, Consolas, "Courier New", monospace' } : MONO
  return (
    <View className="rounded-lg bg-muted p-3 my-1">
      {byLine ? (
        // 每行一个 Text：安卓的文字排版按 Text 分段，单个巨型 spannable 会把 UI 线程卡死
        byLine.map((l, i) => <Text key={i} selectable style={style} className="text-foreground">{l.length ? spans(l) : ' '}</Text>)
      ) : (
        <Text selectable style={style} className="text-foreground">{spans(runs)}</Text>
      )}
      {folded ? (
        <Pressable onPress={() => setExpanded(true)} className="mt-2"><Text className="text-muted-foreground text-xs">展开（共 {lines.length} 行）</Text></Pressable>
      ) : null}
    </View>
  )
})
