// 安卓：只列文件和加减行数，点了看 lowlight diff 高亮的原文块（07）
import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { CodeBlock } from './CodeBlock.tsx'
import { parseDiffFiles } from './diff.ts'

export function DiffView({ patch, onListReady }: { patch: string; onListReady?: (ms: number) => void }) {
  const t0 = useMemo(() => performance.now(), [patch])
  const files = useMemo(() => parseDiffFiles(patch), [patch])
  const [sel, setSel] = useState<number | null>(null)
  return (
    <View onLayout={() => onListReady?.(performance.now() - t0)}>
      {files.map((f, i) => (
        <View key={f.path}>
          <Pressable onPress={() => setSel(sel === i ? null : i)} className="flex-row justify-between py-1">
            <Text className="text-foreground text-xs flex-1" numberOfLines={1}>{f.path}</Text>
            <Text className="text-xs" style={{ color: '#22863a' }}>+{f.add} </Text>
            <Text className="text-xs" style={{ color: '#b31d28' }}>-{f.del}</Text>
          </Pressable>
          {sel === i ? <CodeBlock text={patch.slice(f.start, f.end)} lang="diff" open={false} /> : null}
        </View>
      ))}
    </View>
  )
}
