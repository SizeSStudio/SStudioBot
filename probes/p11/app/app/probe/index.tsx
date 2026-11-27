import { Link } from 'expo-router'
import { ScrollView, Text } from 'react-native'

const PAGES = [['/probe/ui', '① Uniwind：明暗、hover、弹出层'], ['/?auto=1', '② 对话流（自动）'], ['/probe/evil', '③ 恶意样本'], ['/probe/cjk', '④ 中文'], ['/probe/code', '⑤ 长代码和 diff'], ['/probe/html', 'agent 的 HTML'], ['/probe/keys', '设备密钥'], ['/pair', '配对'], ['/self', '它自己'], ['/item/demo-ref', '通知唤起的一条']] as const

export default function ProbeIndex() {
  return (
    <ScrollView testID="screen" className="flex-1 bg-background" contentContainerClassName="p-6 gap-3">
      {PAGES.map(([href, t]) => <Link key={href} href={href} className="text-foreground underline">{t}</Link>)}
    </ScrollView>
  )
}
