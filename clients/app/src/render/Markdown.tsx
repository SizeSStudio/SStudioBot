// 白名单节点 → RN 组件。不用 Image、WebView、dangerouslySetInnerHTML：图片只显示占位和地址。
import { memo, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { useLinkGate } from '../ui/linkGate.tsx'
import { CodeBlock } from './CodeBlock.tsx'
import type { MdNode } from './md.ts'

type N = MdNode

function inline(n: N, k: number, gate: ReturnType<typeof useLinkGate>): ReactNode {
  switch (n.t) {
    case 'text': return n.text
    case 'code': return <Text key={k} className="bg-muted rounded px-1" style={{ fontFamily: 'Menlo, Consolas, monospace' }}>{n.text}</Text>
    case 'br': return n.soft ? ' ' : '\n'
    case 'em': return <Text key={k} style={{ fontStyle: 'italic' }}>{n.c.map((c, i) => inline(c, i, gate))}</Text>
    case 'strong': return <Text key={k} style={{ fontWeight: '700' }}>{n.c.map((c, i) => inline(c, i, gate))}</Text>
    case 's': return <Text key={k} style={{ textDecorationLine: 'line-through' }}>{n.c.map((c, i) => inline(c, i, gate))}</Text>
    case 'link': {
      const text = n.c.map(c => (c.t === 'text' ? c.text : '')).join('')
      // 流式里补出来的半截链接是死的
      if (n.verdict.reason === 'streaming') return <Text key={k}>{n.c.map((c, i) => inline(c, i, gate))}</Text>
      return (
        <Text key={k} accessibilityRole="link" className="text-foreground underline" onPress={() => gate(n.verdict, text)}>
          {n.c.map((c, i) => inline(c, i, gate))}
        </Text>
      )
    }
    case 'image':
      return (
        <Text key={k} className="text-muted-foreground border border-border rounded px-1"
          onPress={n.verdict.reason === 'streaming' ? undefined : () => gate(n.verdict, n.alt)}>
          {`[图片 ${n.alt || ''}] ${n.src.length > 120 ? n.src.slice(0, 120) + '…' : n.src}`}
        </Text>
      )
    default: return null
  }
}

function block(n: N, k: number, gate: ReturnType<typeof useLinkGate>): ReactNode {
  switch (n.t) {
    case 'p': return <Text key={k} selectable className="text-foreground my-1" style={{ lineHeight: 24 }}>{n.c.map((c, i) => inline(c, i, gate))}</Text>
    case 'h': return <Text key={k} selectable className="text-foreground font-semibold my-1" style={{ fontSize: 22 - n.level * 2, lineHeight: 30 - n.level * 2 }}>{n.c.map((c, i) => inline(c, i, gate))}</Text>
    case 'pre': return <CodeBlock key={k} text={n.text} lang={n.lang} open={n.open} />
    case 'quote': return <View key={k} className="border-l-2 border-border pl-3 my-1">{n.c.map((c, i) => block(c, i, gate))}</View>
    case 'hr': return <View key={k} className="h-px bg-border my-2" />
    case 'ul':
    case 'ol':
      return (
        <View key={k} className="my-1">
          {n.c.map((li, i) => (
            <View key={i} className="flex-row gap-2">
              <Text className="text-muted-foreground" style={{ lineHeight: 24 }}>{n.t === 'ol' ? `${n.start + i}.` : '•'}</Text>
              <View className="flex-1">{'c' in li ? li.c.map((c, j) => block(c, j, gate)) : null}</View>
            </View>
          ))}
        </View>
      )
    case 'table':
      return (
        <View key={k} className="border border-border rounded my-1">
          {n.c.flatMap(sec => ('c' in sec ? sec.c : [])).map((tr, i) => (
            <View key={i} className="flex-row border-b border-border">
              {'c' in tr ? tr.c.map((cell, j) => (
                <Text key={j} selectable className={`flex-1 p-1 text-foreground ${cell.t === 'th' ? 'font-semibold' : ''}`}>{'c' in cell ? cell.c.map((c, x) => inline(c, x, gate)) : null}</Text>
              )) : null}
            </View>
          ))}
        </View>
      )
    case 'root': return <View key={k}>{n.c.map((c, i) => block(c, i, gate))}</View>
    default:
      // 行内节点落在块级位置（如 li 里紧挨的文字）：包一层段落
      return <Text key={k} selectable className="text-foreground" style={{ lineHeight: 24 }}>{inline(n, 0, gate)}</Text>
  }
}

export const Markdown = memo(function Markdown({ tree }: { tree: MdNode }) {
  const gate = useLinkGate()
  return <View>{block(tree, 0, gate)}</View>
})
