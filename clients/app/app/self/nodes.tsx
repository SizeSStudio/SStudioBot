// 节点 (§办3.2, §办3.4): every machine that runs agents for me, whether it's there, which version, which agents and
// what's left of their quota, and the worktrees I can clean up (only when I press 清理; the branch stays).
// Worktrees aren't a stream entity: the list is GET /nodes, fetched again when a node or task moves.
import { useEffect, useState } from 'react'
import { Link } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { NodesRes } from '../../../../protocol/api/tasks.ts'
import type { Worktree } from '../../../../protocol/api/entities.ts'
import { actions, conn, store, useConn, writes } from '../../src/conn/client.ts'
import { worktreeRef } from '../../src/conn/actions.ts'
import { useList, useWrites } from '../../src/store/hooks.ts'
import { agentsOf, nodeStatusText, quotaLines } from '../../src/task/status.ts'
import { Btn, Refusal, Row } from '../../src/ui/kit.tsx'

export default function Nodes() {
  const nodes = useList(store, 'node')
  const tasks = useList(store, 'task')
  const live = useConn().s === 'live'
  const [wts, setWts] = useState<Worktree[] | null>(null)
  const [n, setN] = useState(0)
  const moved = nodes.reduce((m, x) => Math.max(m, x.seq), 0) + tasks.reduce((m, x) => Math.max(m, x.seq), 0)
  useEffect(() => {
    if (!live) return
    const h = setTimeout(() => {
      void conn.request('GET', '/api/v1/nodes').then((r) => {
        const p = r.status === 200 ? NodesRes.safeParse(r.body) : null
        if (!p?.success) return
        for (const x of p.data.nodes) store.current('node', x, p.data.seq)
        setWts(p.data.worktrees)
      }, () => {})
    }, 300)
    return () => clearTimeout(h)
  }, [live, moved, n])
  return (
    <ScrollView testID="nodes" className="flex-1 bg-background" contentContainerClassName="p-4 gap-3">
      <Link href="/self" className="text-muted-foreground">‹ 它自己</Link>
      <Text className="text-foreground text-xl font-semibold">节点</Text>
      {nodes.length ? nodes.map(({ data: d }) => {
        const agents = agentsOf(d)
        const q = quotaLines(d)
        const mine = (wts ?? []).filter((w) => w.node === d.id)
        return (
          <View key={d.id} testID="node-row" className="rounded-lg border border-border p-3 gap-1">
            <Row>
              <Text selectable className="text-foreground font-semibold flex-1">{d.name}</Text>
              <Text testID="node-status" className={`text-xs ${d.status === 'online' ? 'text-foreground' : 'text-muted-foreground'}`}>{nodeStatusText(d.status)}</Text>
            </Row>
            <Text selectable className="text-muted-foreground text-xs">
              {[d.platform, d.os, d.version ? `v${d.version}` : '', d.sha ? d.sha.slice(0, 7) : '', d.running ? `在跑 ${d.running}` : ''].filter(Boolean).join(' · ')}
              {d.target_sha && d.sha && d.target_sha !== d.sha ? ` · 要升到 ${d.target_sha.slice(0, 7)}` : ''}
            </Text>
            {agents.length ? <Text selectable className="text-muted-foreground text-xs">agent：{agents.map((a) => `${a.kind}${a.version ? ` ${a.version}` : ''}`).join('，')}</Text> : null}
            {q.map((l, i) => <Text key={i} selectable className="text-muted-foreground text-xs">{l}</Text>)}
            {mine.map((w) => <WorktreeRow key={w.path} w={w} onDone={() => setN((x) => x + 1)} />)}
            {wts === null && d.cleanable ? <Text className="text-muted-foreground text-xs">有 {d.cleanable} 个 worktree 可以清理（连上之后列出来）</Text> : null}
          </View>
        )
      }) : <Text className="text-muted-foreground">还没有节点。在一台机器上装好节点程序、配对之后出现在这里。</Text>}
    </ScrollView>
  )
}

function WorktreeRow({ w, onDone }: { w: Worktree; onDone: () => void }) {
  const target = worktreeRef(w.node, w.path)
  const { busy, refusal } = useWrites(writes, (x) => ({ busy: x.busy(target), refusal: x.refusal(target) }))
  return (
    <View testID="worktree-row" className="rounded border border-border p-2 gap-1">
      <Row>
        <View className="flex-1">
          <Text selectable className="text-foreground text-xs font-mono" numberOfLines={2}>{w.path}</Text>
          <Text selectable className="text-muted-foreground text-xs">{w.branch} · 任务 {w.task_id}（分支留着）</Text>
        </View>
        <Btn small label="清理" busy={busy} testID="worktree-cleanup" onPress={() => void actions.cleanupWorktree(w.node, w.path).then((r) => { if (r.ok) onDone() })} />
      </Row>
      <Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)} />
    </View>
  )
}
