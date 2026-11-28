// The desktop doesn't scan (07: no camera permission at all); it takes a pasted code or a sstudiobot:// link.
export function Scanner(_: { onCode: (text: string) => void }) { return null }
