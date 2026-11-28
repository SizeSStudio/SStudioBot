// 派活 from the app (protocol/api/tasks.ts TaskStart): the goal, which node, which of its agents, optionally a repo on
// it. No node picked: the hub's default; no agent: that node's first. Confirmed: the task page opens once the hub
// made it.
import { useState } from 'react'
import { Link, useRouter } from 'expo-router'
import { ScrollView, Text, TextInput, View } from 'react-native'
import { TaskStartRes } from '../../../../protocol/api/tasks.ts'
import { actions, store, writes } from '../../src/conn/client.ts'
import { useList, useWrites } from '../../src/store/hooks.ts'
import { agentsOf, nodeStatusText } from '../../src/task/status.ts'
import { Btn, Refusal, Row } from '../../src/ui/kit.tsx'

export default function NewTask() {
  const router = useRouter()
  const nodes = useList(store, 'node')
  const [goal, setGoal] = useState('')
  const [node, setNode] = useState<string | null>(null)
  const [agent, setAgent] = useState<string | null>(null)
  const [repo, setRepo] = useState('')
  const { busy, refusal } = useWrites(writes, (w) => ({ busy: w.busy('task-new'), refusal: w.refusal('task-new') }))
  const picked = nodes.find((n) => n.data.id === node)?.data
  const agents = agentsOf(picked)
  const send = async () => {
    const g = goal.trim()
    if (!g) return
    const r = await actions.startTask({ goal: g, ...(node ? { node } : {}), ...(agent ? { agent } : {}), ...(repo.trim() ? { repo: repo.trim() } : {}) })
    const p = r.ok ? TaskStartRes.safeParse(r.body) : null
    if (p?.success) {
      store.current('task', p.data.task)
      router.replace({ pathname: '/task/[id]', params: { id: p.data.task.id } })
    }
  }
  return (
    <ScrollView testID="task-new" className="flex-1 bg-background" contentContainerClassName="p-4 gap-3">
      <Link href="/tasks" className="text-muted-foreground">‹ 任务</Link>
      <Text className="text-foreground text-xl font-semibold">派活</Text>
      <TextInput testID="task-goal" value={goal} onChangeText={setGoal} multiline maxLength={20_000} placeholder="要它做什么"
        className="border border-border rounded-lg p-2 text-foreground min-h-24" />
      <Text className="text-muted-foreground text-xs">哪台（不选：默认那台）</Text>
      <Row wrap>
        {nodes.length ? nodes.map((n) => (
          <Btn key={n.data.id} small variant={node === n.data.id ? 'primary' : 'outline'} testID={`task-node-${n.data.id}`}
            label={`${n.data.name} · ${nodeStatusText(n.data.status)}`} onPress={() => { setNode(node === n.data.id ? null : n.data.id); setAgent(null) }} />
        )) : <Text className="text-muted-foreground text-xs">还没有节点登记</Text>}
      </Row>
      {picked ? (
        <>
          <Text className="text-muted-foreground text-xs">用哪个 agent（不选：它的第一个）</Text>
          <Row wrap>
            {agents.map((a) => (
              <Btn key={a.kind} small variant={agent === a.kind ? 'primary' : 'outline'} testID={`task-agent-${a.kind}`}
                label={`${a.kind}${a.version ? ` ${a.version}` : ''}`} onPress={() => setAgent(agent === a.kind ? null : a.kind)} />
            ))}
          </Row>
          {picked.status !== 'online' ? <Text className="text-muted-foreground text-xs">它现在{nodeStatusText(picked.status)}：派了会等它上线</Text> : null}
        </>
      ) : null}
      <TextInput testID="task-repo" value={repo} onChangeText={setRepo} maxLength={1000} placeholder="仓库路径（那台机器上的，可以不填）"
        className="border border-border rounded-lg p-2 text-foreground" autoCapitalize="none" autoCorrect={false} />
      <View><Btn variant="primary" label="派" busy={busy} disabled={!goal.trim()} onPress={() => void send()} testID="task-start" /></View>
      <Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)} />
    </ScrollView>
  )
}
