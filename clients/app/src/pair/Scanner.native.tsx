// Android: scan the pairing QR (it's the sstudiobot://pair link). The camera is asked for only when I tap "扫码".
// 待测（手机）：scanning a code shown by `sbot pair` on a terminal, permission denied path.
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { PAIR_LINK_PREFIX } from '../../../../protocol/pair.ts'

export function Scanner({ onCode }: { onCode: (text: string) => void }) {
  const [perm, ask] = useCameraPermissions()
  const [on, setOn] = useState(false)
  if (!on) {
    return (
      <Pressable testID="pair-scan" onPress={() => void (perm?.granted ? Promise.resolve(perm) : ask()).then((p) => setOn(!!p?.granted))} className="self-start px-3 py-2 rounded-lg border border-border">
        <Text className="text-foreground">扫码</Text>
      </Pressable>
    )
  }
  return (
    <View className="h-72 rounded-lg overflow-hidden">
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={(r) => { if (r.data.startsWith(PAIR_LINK_PREFIX) || r.data.startsWith('v1.')) { setOn(false); onCode(r.data) } }}
      />
    </View>
  )
}
