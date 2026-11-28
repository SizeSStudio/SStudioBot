// Android (07 「diff」): the file list, and a file's text diff in a lowlight `diff` code block (one <Text> per line).
// No side-by-side, no word diff. Untrusted text, shown as text.
import { CodeBlock } from '../render/CodeBlock.tsx'
import type { SplitDiff } from './diff.ts'
import { DiffFiles } from './DiffFiles.tsx'

export function DiffView({ diff, testID, allOpen }: { diff: SplitDiff; testID?: string; allOpen?: boolean }) {
  return <DiffFiles diff={diff} testID={testID} allOpen={allOpen} render={(f) => <CodeBlock text={f.text} lang="diff" open={false} />} />
}
