import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { device } from '../../src/device/device'
import { report } from '../../src/probe/report.ts'

export default function Keys() {
  const [s, setS] = useState<Record<string, unknown>>({})
  useEffect(() => {
    void (async () => {
      try {
        const pk = await device.publicKey()
        const sig = await device.sign('00'.repeat(32), '11'.repeat(32))
        const r = { publicKey: pk, sigLen: sig.length, backend: await device.backend() }
        setS(r); report('keys', r)
      } catch (e) { setS({ error: String(e) }); report('keys', { error: String(e) }) }
    })()
  }, [])
  return <View testID="screen" className="flex-1 bg-background p-6"><Text selectable className="text-foreground text-xs">{JSON.stringify(s, null, 1)}</Text></View>
}
