// ③ 恶意样本：全部渲染一遍，外部请求必须为 0（Electron 主进程用 session.webRequest 记）
import { useEffect, useMemo } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { EVIL_SAMPLES } from '../../src/probe/evil.ts'
import { Markdown } from '../../src/render/Markdown.tsx'
import { parseMarkdown, StreamingMarkdown } from '../../src/render/md.ts'
import { DiffView } from '../../src/render/DiffView'
import { report } from '../../src/probe/report.ts'

const EVIL_PATCH = `diff --git a/x.html b/x.html
--- a/x.html
+++ b/x.html
@@ -1,2 +1,3 @@
 <p>hi</p>
-<img src="https://evil.example/30.png">
+<script src="https://evil.example/31.js"></script>
+<link rel="stylesheet" href="https://evil.example/32.css">
`

export default function Evil() {
  const trees = useMemo(() => EVIL_SAMPLES.map(s => ({ id: s.id, tree: s.id.startsWith('streaming') ? new StreamingMarkdown().update(s.md) : parseMarkdown(s.md) })), [])
  useEffect(() => { const t = setTimeout(() => report('evil-rendered', { samples: trees.length }), 1500); return () => clearTimeout(t) }, [trees])
  return (
    <ScrollView testID="screen" className="flex-1 bg-background" contentContainerClassName="p-4 gap-2">
      {trees.map(({ id, tree }) => (
        <View key={id} testID={`evil-${id}`} className="border-b border-border pb-2">
          <Text className="text-muted-foreground text-xs">{id}</Text>
          <Markdown tree={tree} />
        </View>
      ))}
      <View testID="evil-diff"><DiffView patch={EVIL_PATCH} /></View>
    </ScrollView>
  )
}
