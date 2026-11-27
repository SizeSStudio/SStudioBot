// 统一 diff → 文件列表（安卓只显示这层，点了再看原文块）。
export type DiffFile = { path: string; add: number; del: number; start: number; end: number }

export function parseDiffFiles(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let cur: DiffFile | null = null
  let pos = 0
  for (const line of patch.split('\n')) {
    const len = line.length + 1
    if (line.startsWith('diff --git ')) {
      if (cur) cur.end = pos
      const m = / b\/(.+)$/.exec(line)
      cur = { path: m?.[1] ?? line.slice(11), add: 0, del: 0, start: pos, end: pos }
      files.push(cur)
    } else if (cur) {
      if (line.startsWith('+') && !line.startsWith('+++')) cur.add++
      else if (line.startsWith('-') && !line.startsWith('---')) cur.del++
    }
    pos += len
  }
  if (cur) cur.end = pos
  return files
}
