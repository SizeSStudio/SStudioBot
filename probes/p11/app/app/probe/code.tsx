// ⑤ 400 行代码块高亮耗时、2000 行 diff 文件列表耗时
import { useEffect, useState } from 'react'
import { ScrollView, Text } from 'react-native'
import { highlight } from '../../src/render/code.ts'
import { parseDiffFiles } from '../../src/render/diff.ts'
import { CodeBlock, codeBlockMode } from '../../src/render/CodeBlock.tsx'
import { useLocalSearchParams } from 'expo-router'
import { DiffView } from '../../src/render/DiffView'
import { now, report } from '../../src/probe/report.ts'

export function makeCode(lines = 400) {
  const out: string[] = []
  for (let i = 0; i < lines; i++) out.push(i % 10 === 0 ? `// 第 ${i} 行注释` : `export async function f${i}(x: number): Promise<string> { const s = \`v\${x + ${i}}\`; return s.repeat(2) }`)
  return out.join('\n')
}

export function makePatch(totalLines = 2000, files = 20) {
  const per = Math.floor(totalLines / files)
  let p = ''
  for (let f = 0; f < files; f++) {
    p += `diff --git a/src/mod${f}.ts b/src/mod${f}.ts\n--- a/src/mod${f}.ts\n+++ b/src/mod${f}.ts\n@@ -1,${per} +1,${per} @@\n`
    for (let i = 0; i < per; i++) p += (i % 3 === 0 ? '+' : i % 3 === 1 ? '-' : ' ') + `const v${i} = compute(${i}, "s${f}")\n`
  }
  return p
}

export default function CodeProbe() {
  // ?mode=one|lines&font=css|platform&code=0：对照安卓上代码块的几种渲染法
  const q = useLocalSearchParams<{ mode?: string; font?: string; code?: string }>()
  codeBlockMode.value = q.mode === 'one' ? 'one' : 'lines'
  codeBlockMode.font = q.font === 'css' ? 'css' : 'platform'
  const withCode = q.code !== '0'
  const [t0] = useState(() => now())
  const [code] = useState(() => makeCode(400))
  const [patch] = useState(() => makePatch(2000, 20))
  const [res, setRes] = useState<Record<string, number>>({})
  // 基准放在列表出来之后跑，免得把 JS 线程占住、算进列表耗时
  const listed = res.diffListMs !== undefined
  useEffect(() => {
    if (!listed) return
    const runs: number[] = []
    for (let i = 0; i < 5; i++) { const t = now(); highlight(code, 'typescript'); runs.push(now() - t) }
    const t = now(); parseDiffFiles(patch); const parse = now() - t
    const r = { highlight400Ms: Math.round(Math.min(...runs)), highlight400FirstMs: Math.round(runs[0]!), diffParse2000Ms: Math.round(parse * 10) / 10 }
    setRes(x => ({ ...x, ...r }))
  }, [code, patch, listed])
  const onList = (ms: number) => setRes(x => (x.diffListMs ? x : { ...x, diffListMs: Math.round(ms) }))
  const onPage = () => setRes(x => (x.pageMs ? x : { ...x, pageMs: Math.round(now() - t0) }))
  useEffect(() => { if (res.diffListMs !== undefined && res.highlight400Ms !== undefined && res.pageMs !== undefined) report('code', { mode: codeBlockMode.value, font: codeBlockMode.font, withCode, ...res }) }, [res])
  return (
    <ScrollView testID="screen" className="flex-1 bg-background" contentContainerClassName="p-4 gap-3" onContentSizeChange={onPage}>
      <Text testID="code-result" className="text-foreground text-xs">{JSON.stringify(res)}</Text>
      <DiffView patch={patch} onListReady={onList} />
      {withCode ? <CodeBlock text={code} lang="typescript" open={false} /> : null}
    </ScrollView>
  )
}
