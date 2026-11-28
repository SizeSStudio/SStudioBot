// lowlight 只注册常用语言；hast → 扁平的 [文字, class] 段，渲染成嵌套 <Text>。
import { createLowlight } from 'lowlight'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import diff from 'highlight.js/lib/languages/diff'
import markdown from 'highlight.js/lib/languages/markdown'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import ini from 'highlight.js/lib/languages/ini'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

export const lowlight = createLowlight({
  bash, shell, json, yaml, typescript, javascript, python, go, rust, sql, diff, markdown, css, xml, ini, dockerfile,
})
lowlight.registerAlias({ typescript: ['tsx', 'ts'], javascript: ['js', 'jsx'], bash: ['sh', 'zsh'], yaml: ['yml'] })

export type Run = { text: string; cls: string | null }

type HNode = { type: string; value?: string; tagName?: string; properties?: { className?: string[] }; children?: HNode[] }

function flatten(n: HNode, cls: string | null, out: Run[]) {
  if (n.type === 'text') { out.push({ text: n.value ?? '', cls }); return }
  const own = n.properties?.className?.[0]?.replace(/^hljs-/, '') ?? cls
  for (const k of n.children ?? []) flatten(k, own, out)
}

export function highlight(code: string, lang: string): Run[] {
  if (!lang || !lowlight.registered(lang)) return [{ text: code, cls: null }]
  const out: Run[] = []
  flatten(lowlight.highlight(lang, code) as unknown as HNode, null, out)
  return out
}

// 超过阈值先显示前 80 行加「展开」：网页 400 行，安卓 200 行（P11 ⑤：Hermes 上 400 行高亮冷启动首次超 150 ms ※，真机再核）
export const FOLD_PREVIEW = 80
export const foldLines = (platform: string): number => (platform === 'web' ? 400 : 200)

// 配色两套主题共用：都是中等饱和度，白底黑底都看得清
export const TOKEN_COLORS: Record<string, string> = {
  keyword: '#a626a4', built_in: '#c18401', type: '#c18401', literal: '#0184bb', number: '#986801',
  string: '#50a14f', comment: '#a0a1a7', title: '#4078f2', attr: '#986801', meta: '#4078f2',
  addition: '#22863a', deletion: '#b31d28', section: '#4078f2', variable: '#e45649', params: '#383a42',
}

// 把一串 run 按换行切成行，每行自己一组 run
export function splitRuns(runs: Run[]): Run[][] {
  const lines: Run[][] = [[]]
  for (const r of runs) {
    const parts = r.text.split('\n')
    parts.forEach((p, i) => {
      if (i > 0) lines.push([])
      if (p) lines[lines.length - 1]!.push({ text: p, cls: r.cls })
    })
  }
  return lines
}
