// Typing into a thread (protocol/api/write.ts MessageReq): the message shows at once (optimistic), waits its turn
// behind a running turn (排队中, withdrawable until it starts), and a running turn can be stopped. Enter sends on the
// web unless the IME is composing (render/ime.ts); Shift+Enter is a new line. Feishu mirror threads are read-only (D9).
import { useMemo, useState } from 'react'
import { Text, TextInput, View } from 'react-native'
import type { Thread } from '../../../../protocol/api/entities.ts'
import { actions, store, writes } from '../conn/client.ts'
import { refOf } from '../conn/actions.ts'
import { keyInfo, shouldSend } from '../render/ime.ts'
import { useList, useWrites } from '../store/hooks.ts'
import { Btn, Refusal, Row } from '../ui/kit.tsx'

export function Composer({ thread }: { thread: Thread }) {
  const [text, setText] = useState('')
  const runs = useList(store, 'run')
  const running = useMemo(() => runs.filter((r) => r.data.lane === thread.lane && r.data.status === 'running'), [runs, thread.lane])
  const lane = refOf('lane', thread.lane)
  const failed = useWrites(writes, (w) => w.forTarget(lane).filter((o) => o.state === 'failed' || o.state === 'conflict'))
  const stopBusy = useWrites(writes, (w) => running.map((r) => w.busy(refOf('run', r.data.id))).find(Boolean))
  const readOnly = thread.kind === 'feishu'
  const temp = thread.id.startsWith('op:') // the hub hasn't made it yet

  const send = () => {
    const t = text.trim()
    if (!t || readOnly || temp) return
    setText('')
    void actions.sendMessage(thread, t)
  }

  if (readOnly) return <Text className="px-3 py-2 text-muted-foreground text-xs border-t border-border">飞书那边的对话，这里只看；回复在飞书里。</Text>
  return (
    <View className="border-t border-border px-3 py-2 gap-2">
      {failed.map((o) => (
        <Refusal key={o.id} op={o} onDismiss={(id) => writes.dismiss(id)} extra={
          <Row>
            <Text selectable className="text-foreground text-xs flex-1" numberOfLines={3}>没发出去：{String((o.body as { text?: unknown }).text ?? '')}</Text>
            <Btn small label="再发" onPress={() => { writes.dismiss(o.id); void actions.sendMessage(thread, String((o.body as { text?: unknown }).text ?? '')) }} />
          </Row>
        } />
      ))}
      {running.length ? (
        <Row>
          <Text className="text-muted-foreground text-xs flex-1">在回…　现在发的会排在这一轮后面</Text>
          <Btn small label="停" variant="outline" busy={stopBusy} onPress={() => { for (const r of running) void actions.stopRun(r.data.id) }} testID="run-stop" />
        </Row>
      ) : null}
      <Row>
        <TextInput testID="composer-input" value={text} onChangeText={setText} multiline maxLength={20_000} editable={!temp}
          placeholder={temp ? '线程还在建…' : '说点什么'} className="flex-1 border border-border rounded-lg p-2 text-foreground max-h-40"
          onKeyPress={(e) => {
            const ne = e.nativeEvent as unknown as Parameters<typeof keyInfo>[0] & { preventDefault?: () => void }
            if (shouldSend(keyInfo(ne))) { (e as unknown as { preventDefault?: () => void }).preventDefault?.(); send() }
          }} />
        <Btn label="发" variant="primary" disabled={!text.trim() || temp} onPress={send} testID="composer-send" />
      </Row>
    </View>
  )
}
