// agent 做的 HTML：交给系统浏览器（桌面 bridge.html.open；安卓 FileProvider + ACTION_VIEW）
import { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'
import { bridge } from '../../src/bridge.ts'
import { openHtmlNative } from '../../src/device/html'
import { report } from '../../src/probe/report.ts'

export const SAMPLE_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>agent 页面</title>
<body><p>计数（localStorage）：<b id="n"></b></p><script>
try { const n = Number(localStorage.getItem('n') || 0) + 1; localStorage.setItem('n', String(n)); document.getElementById('n').textContent = n }
catch (e) { document.getElementById('n').textContent = '存不住：' + e }
</script></body></html>`

export default function HtmlProbe() {
  const [out, setOut] = useState('')
  const open = async () => {
    const sha = 'probe-sample'
    const r = bridge ? await bridge.html.open(sha, SAMPLE_HTML) : await openHtmlNative(sha, SAMPLE_HTML)
    setOut(r); report('html-open', { platform: Platform.OS, result: r })
  }
  return (
    <View testID="screen" className="flex-1 bg-background p-6 gap-3">
      <Pressable testID="html-open" onPress={() => void open()} className="self-start px-3 py-2 rounded-lg bg-primary"><Text className="text-primary-foreground">用浏览器打开</Text></Pressable>
      <Text className="text-muted-foreground text-xs">{out}</Text>
    </View>
  )
}
