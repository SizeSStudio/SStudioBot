// Desktop (07 「diff」): the same file list, a file opens in @pierre/diffs (a DOM component; RN Web renders it as is).
// The diff is untrusted text. @pierre/diffs turns it into hast and serializes with hast-util-to-html, which escapes
// every text node, and the CSP (no inline script, img-src 'self' data:) and main's webRequest filter stand behind
// that. Settings that keep it local (checked for 1.7.2, docs/tech/07):
//   - preferredHighlighter 'shiki-js': shiki's JS regex engine, no wasm (the CSP has no wasm-unsafe-eval)
//   - disableWorkerPool, and no WorkerPoolContextProvider: no workers
//   - grammars and themes are dynamic imports Metro bundles: they load from sbot-app://, never a CDN
//   - no loadDiffFiles (it would fetch whole files), no unsafeCSS, our own header (disableFileHeader) with the cleaned
//     path
// Anything it can't parse or render falls back to the lowlight text block.
import { Component, useMemo, type ReactNode } from 'react'
import { useUniwind } from 'uniwind'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import { CodeBlock } from '../render/CodeBlock.tsx'
import type { DiffFile, SplitDiff } from './diff.ts'
import { DiffFiles } from './DiffFiles.tsx'

class Fallback extends Component<{ text: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { /* shown as text below; nothing of the diff goes to a log */ }
  render() { return this.state.failed ? <CodeBlock text={this.props.text} lang="diff" open={false} /> : this.props.children }
}

function parseOne(f: DiffFile): FileDiffMetadata | null {
  try {
    const p = parsePatchFiles(f.text)
    const one = p.length === 1 && p[0]!.files.length === 1 ? p[0]!.files[0]! : null
    // the name only picks the grammar now (our header shows the path); keep it the cleaned one anyway
    return one ? { ...one, name: f.path, ...(one.prevName ? { prevName: f.old ?? undefined } : {}) } : null
  } catch { return null }
}

function PierreFile({ f }: { f: DiffFile }) {
  const { theme } = useUniwind()
  const fd = useMemo(() => parseOne(f), [f])
  if (!fd) return <CodeBlock text={f.text} lang="diff" open={false} />
  return (
    <Fallback text={f.text}>
      <FileDiff
        fileDiff={fd}
        disableWorkerPool
        options={{
          diffStyle: 'unified', overflow: 'wrap', themeType: theme === 'dark' ? 'dark' : 'light',
          preferredHighlighter: 'shiki-js', disableFileHeader: true, expandUnchanged: false,
        }}
      />
    </Fallback>
  )
}

export function DiffView({ diff, testID, allOpen }: { diff: SplitDiff; testID?: string; allOpen?: boolean }) {
  return <DiffFiles diff={diff} testID={testID} allOpen={allOpen} render={(f) => <PierreFile f={f} />} />
}
