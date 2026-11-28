// The file list both platforms start from (07 「diff」): which files, how many lines each way; tapping one opens its
// part of the diff through `render` (each platform's own). Paths were cleaned by splitDiff; still plain text.
import { useState, type ReactElement } from 'react'
import { Pressable, Text, View } from 'react-native'
import type { DiffFile, SplitDiff } from './diff.ts'

/** `allOpen`: every file starts open (the selftest page renders them all) */
export function DiffFiles({ diff, render, testID, allOpen }: { diff: SplitDiff; render: (f: DiffFile) => ReactElement; testID?: string; allOpen?: boolean }) {
  const [open, setOpen] = useState<Set<number>>(() => new Set(allOpen ? diff.files.map((_, i) => i) : diff.files.length === 1 ? [0] : []))
  const toggle = (i: number) => setOpen((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })
  if (!diff.files.length) return <Text className="text-muted-foreground text-xs">没有改动（或者认不出是 diff）</Text>
  return (
    <View testID={testID} className="gap-1">
      <Text className="text-muted-foreground text-xs">{diff.files.length} 个文件 · <Text style={{ color: '#22863a' }}>+{diff.added}</Text> <Text style={{ color: '#b31d28' }}>−{diff.removed}</Text>{diff.truncated ? ' · 太长，后面的没显示' : ''}</Text>
      {diff.files.map((f, i) => (
        <View key={i} className="rounded border border-border">
          <Pressable testID="diff-file" accessibilityRole="button" onPress={() => toggle(i)} className="flex-row items-center gap-2 px-2 py-1">
            <Text className="text-muted-foreground text-xs">{open.has(i) ? '▾' : '▸'}</Text>
            <Text selectable className="text-foreground text-xs flex-1 font-mono" numberOfLines={2}>{f.old ? `${f.old} → ${f.path}` : f.path}</Text>
            <Text className="text-xs">{f.binary ? <Text className="text-muted-foreground">二进制</Text> : <><Text style={{ color: '#22863a' }}>+{f.added}</Text> <Text style={{ color: '#b31d28' }}>−{f.removed}</Text></>}</Text>
          </Pressable>
          {open.has(i) && !f.binary ? render(f) : null}
        </View>
      ))}
    </View>
  )
}
