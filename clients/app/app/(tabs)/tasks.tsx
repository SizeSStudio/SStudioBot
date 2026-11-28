// 任务 (DESIGN §触6.1 办): what waits on me first, then what finished since I last looked, then what runs, then the
// rest (status.ts taskRank). The store holds the unfinished ones from the bootstrap and the stream; the finished
// ones of late come from GET /tasks?status=all once I'm connected.
import { useEffect, useMemo } from 'react'
import { Link } from 'expo-router'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { TasksRes } from '../../../../protocol/api/tasks.ts'
import { conn, store, useConn } from '../../src/conn/client.ts'
import { refOf } from '../../src/conn/actions.ts'
import { useList } from '../../src/store/hooks.ts'
import { taskLine, taskRank } from '../../src/task/status.ts'

const TONE: Record<string, string> = { you: 'text-destructive', run: 'text-foreground', wait: 'text-muted-foreground', done: 'text-muted-foreground', bad: 'text-destructive' }

export default function Tasks() {
  const all = useList(store, 'task')
  const reads = useList(store, 'read')
  const nodes = useList(store, 'node')
  const live = useConn().s === 'live'
  useEffect(() => {
    if (!live) return
    void conn.request('GET', '/api/v1/tasks', { query: { status: 'all' } }).then((r) => {
      const p = r.status === 200 ? TasksRes.safeParse(r.body) : null
      if (p?.success) for (const t of p.data.tasks) store.current('task', t, p.data.seq)
    }, () => {})
  }, [live])
  const rows = useMemo(() => {
    const seen = new Map(reads.map((r) => [r.data.ref, r.data.upto_ts ?? r.data.read_at]))
    return all.map((r) => ({ t: r.data, rank: taskRank(r.data, seen.get(refOf('task', r.data.id)) ?? undefined) }))
      .sort((a, b) => a.rank - b.rank || b.t.ts - a.t.ts)
  }, [all, reads])
  const name = (id: string | null) => (id ? nodes.find((n) => n.data.id === id)?.data.name ?? id : '')
  return (
    <View testID="tasks" className="flex-1 bg-background">
      <View className="flex-row items-center px-3 py-2 border-b border-border">
        <Text className="text-foreground font-semibold flex-1">任务</Text>
        <Link href="/task/new" testID="task-new-link" className="text-foreground underline">派活</Link>
      </View>
      <ScrollView contentContainerClassName="py-2">
        {rows.length ? rows.map(({ t }) => {
          const line = taskLine(t, name(t.node))
          return (
            <Link key={t.id} href={{ pathname: '/task/[id]', params: { id: t.id } }} asChild>
              <Pressable testID="task-row" className="mx-3 my-1 rounded-lg p-3 border border-border">
                <Text className={`text-xs ${TONE[line.tone]}`}>{line.label}{t.agent ? ` · ${t.agent}` : ''}{t.node ? ` · ${name(t.node)}` : ''}</Text>
                <Text className="text-foreground" numberOfLines={2}>{t.goal}</Text>
                {line.detail ? <Text className="text-muted-foreground text-xs" numberOfLines={1}>{line.detail}</Text> : null}
              </Pressable>
            </Link>
          )
        }) : <Text className="text-muted-foreground p-6 text-center">没有任务</Text>}
      </ScrollView>
    </View>
  )
}
