// 桌面：@pierre/diffs（DOM 组件）；文件列表和安卓同一套。语法和主题必须打进包，抓包查有没有去 CDN。
import { useMemo, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { PatchDiff } from '@pierre/diffs/react'
import { parseDiffFiles } from './diff.ts'

export function DiffView({ patch, onListReady }: { patch: string; onListReady?: (ms: number) => void }) {
  const t0 = useMemo(() => performance.now(), [patch])
  const files = useMemo(() => parseDiffFiles(patch), [patch])
  const [sel, setSel] = useState<number | null>(null)
  return (
    <View onLayout={() => onListReady?.(performance.now() - t0)}>
      {files.map((f, i) => (
        <View key={f.path}>
          <Pressable testID={`diff-file-${i}`} onPress={() => setSel(sel === i ? null : i)} className="flex-row justify-between py-1 hover:bg-accent">
            <Text className="text-foreground text-xs flex-1" numberOfLines={1}>{f.path}</Text>
            <Text className="text-xs" style={{ color: '#22863a' }}>+{f.add} </Text>
            <Text className="text-xs" style={{ color: '#b31d28' }}>-{f.del}</Text>
          </Pressable>
          {sel === i ? (
            <div data-testid="pierre-diff">
              <PatchDiff patch={patch.slice(f.start, f.end)} disableWorkerPool options={{ theme: { light: 'pierre-light', dark: 'pierre-dark' }, diffStyle: 'unified' }} />
            </div>
          ) : null}
        </View>
      ))}
    </View>
  )
}
