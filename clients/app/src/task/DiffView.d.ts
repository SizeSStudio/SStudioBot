// Metro picks DiffView.web.tsx (desktop: @pierre/diffs) or DiffView.native.tsx (Android: file list + text); this is
// what tsc sees.
import type { ReactElement } from 'react'
import type { SplitDiff } from './diff.ts'
export declare function DiffView(p: { diff: SplitDiff; testID?: string; allOpen?: boolean }): ReactElement
