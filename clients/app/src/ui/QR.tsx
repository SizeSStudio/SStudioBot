// A QR code drawn with Views (uqr only computes the matrix): no image, no SVG, nothing loaded. Each row is merged
// into runs of dark modules so a 41×41 code is a few hundred Views, not 1681.
import { useMemo } from 'react'
import { View } from 'react-native'
import { encode } from 'uqr'

export function QR({ text, size = 240 }: { text: string; size?: number }) {
  const rows = useMemo(() => {
    const q = encode(text, { ecc: 'M', border: 2 })
    return q.data.map((row) => {
      const runs: { x: number; w: number }[] = []
      let x = 0
      while (x < row.length) {
        if (!row[x]) { x++; continue }
        const s = x
        while (x < row.length && row[x]) x++
        runs.push({ x: s, w: x - s })
      }
      return runs
    })
  }, [text])
  const n = rows.length
  const m = size / n
  return (
    <View testID="qr" accessibilityLabel="配对二维码" style={{ width: size, height: size, backgroundColor: '#ffffff' }}>
      {rows.map((runs, y) => runs.map((r) => (
        <View key={`${y}:${r.x}`} style={{ position: 'absolute', left: r.x * m, top: y * m, width: r.w * m + 0.5, height: m + 0.5, backgroundColor: '#000000' }} />
      )))}
    </View>
  )
}
