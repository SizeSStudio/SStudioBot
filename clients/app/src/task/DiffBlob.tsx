// A diff that lives in a blob (a task's final `diff_blob`, a `diff` step's `diff_ref`): pulled over the connection
// only when I open it (02 「大载荷」), decoded without throwing, split into files and shown as untrusted text
// (DiffView). Over DIFF_MAX it isn't pulled at all: 「去 git 上看」.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { conn } from '../conn/client.ts'
import { pullBlob } from '../html/pull.ts'
import { decodeText, DIFF_MAX, splitDiff, statLine, type SplitDiff, type Stat } from './diff.ts'
export { shaOf } from './diff.ts'
import { DiffView } from './DiffView'

export function DiffBlob({ sha, size, stat, label = 'diff', testID }: { sha: string; size?: number | null; stat?: Stat; label?: string; testID?: string }) {
  const [st, setSt] = useState<{ s: 'closed' } | { s: 'loading' } | { s: 'error'; error: string } | { s: 'open'; diff: SplitDiff }>({ s: 'closed' })
  const tooBig = typeof size === 'number' && size > DIFF_MAX
  const open = async () => {
    if (st.s === 'open') { setSt({ s: 'closed' }); return }
    if (tooBig || st.s === 'loading') return
    setSt({ s: 'loading' })
    try {
      const r = await pullBlob(sha, DIFF_MAX, { request: (m, p, o) => conn.request(m, p, o) })
      setSt(r.ok ? { s: 'open', diff: splitDiff(decodeText(r.bytes)) } : { s: 'error', error: r.error })
    } catch { setSt({ s: 'error', error: '没拉到，连上后再试' }) }
  }
  const line = statLine(stat)
  return (
    <View testID={testID ?? 'diff-blob'} className="gap-1">
      <Pressable onPress={() => void open()} accessibilityRole="button" testID="diff-blob-toggle">
        <Text className="text-muted-foreground text-xs">
          {st.s === 'open' ? '▾' : '▸'} {label}{line ? ` · ${line}` : ''}
          {tooBig ? ' · 太大了，去 git 上看' : st.s === 'loading' ? ' · 在拉…' : st.s === 'error' ? ` · ${st.error}` : ''}
        </Text>
      </Pressable>
      {st.s === 'open' ? <DiffView diff={st.diff} /> : null}
    </View>
  )
}
