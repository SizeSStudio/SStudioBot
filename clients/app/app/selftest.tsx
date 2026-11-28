// The P11 ③ evil samples, rendered the normal way. The desktop's `--selftest` loads this and counts every request that
// isn't sbot-app:// and every CSP error: both must be zero (CI `clients` job). The same samples run in node in
// test/render.test.ts.
import { useEffect, useMemo, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { EVIL_SAMPLES } from '../src/selftest/evil.ts'
import { Markdown } from '../src/render/Markdown.tsx'
import { parseMarkdown } from '../src/render/md.ts'

export default function Selftest() {
  const trees = useMemo(() => EVIL_SAMPLES.map((s) => ({ id: s.id, tree: parseMarkdown(s.md) })), [])
  const [done, setDone] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDone(true), 300); return () => clearTimeout(t) }, [])
  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="p-4 gap-2">
      <Text className="text-foreground font-semibold">自检：恶意样本 {trees.length} 条</Text>
      {trees.map((s) => (
        <View key={s.id} testID="selftest-sample" className="border border-border rounded p-2">
          <Text className="text-muted-foreground text-xs">{s.id}</Text>
          <Markdown tree={s.tree} />
        </View>
      ))}
      {done ? <Text testID="selftest-done" className="text-muted-foreground text-xs">完</Text> : null}
    </ScrollView>
  )
}
