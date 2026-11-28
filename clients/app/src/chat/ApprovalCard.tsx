// One approval card (DESIGN §底3.3, §办3.3, §触1.1; protocol/api/write.ts): send / plan / proposal / rollback are
// approved or rejected, glance and ask are answered, a send or plan draft can be edited by me or sent back with
// 「改一下」, and anything pending can be snoozed. Everything on the card is untrusted and shown as plain text: the
// draft especially, so what I read is byte for byte what goes out.
//
// The on-screen version: a decision carries the draft_version I was shown. If a newer draft arrives while the card is
// open, the buttons wait until I've said I saw it (the hub would refuse the old version with 409 anyway; this keeps
// me from approving text I didn't read).
//
// A node's card (W4, requester node:<device>): the tool, command, path and cwd are shown whole (folded when long,
// never cut: a cut command could hide its tail), its diff as a diff, and a request too big for the card says so and
// can be pulled in full. An ask with AskUserQuestion's questions is answered per question (`answers`), and only when
// every one has an answer; the answer goes with the version on screen like any decision.
import { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'
import type { Approval } from '../../../../protocol/api/entities.ts'
import { ApprovalRes } from '../../../../protocol/api/write.ts'
import { actions, writes } from '../conn/client.ts'
import { refOf } from '../conn/actions.ts'
import { useWrites } from '../store/hooks.ts'
import type { Rec } from '../store/store.ts'
import { Btn, Refusal, Row } from '../ui/kit.tsx'
import { CodeBlock } from '../render/CodeBlock.tsx'
import { conn } from '../conn/client.ts'
import { pullBlob } from '../html/pull.ts'
import { DiffView } from '../task/DiffView'
import { decodeText, shaOf, splitDiff } from '../task/diff.ts'
import { answersOf, detailOf, pick, type Picks, type Question } from './permission.ts'

const KIND: Record<string, string> = { send: '发出去', plan: '计划', glance: '看一眼', ask: '问我', proposal: '提案', rollback: '回滚' }
const STATUS: Record<string, string> = { pending: '等你', approved: '批了', rejected: '拒了', expired: '过期了', superseded: '换了新稿', invalidated: '作废了' }
const DELIVERY: Record<string, string> = { queued: '排着', streaming: '在发', sending: '在发', sent: '发出去了', failed: '没发出去', unknown: '不知道发没发出去', expired: '过期没发', unrouted: '没有出口' }
const SNOOZE: Record<string, string> = { tonight: '今晚', morning: '明早', monday: '周一' }

type Option = { id: string; label: string; kind: string }
const optionsOf = (v: unknown): Option[] => (Array.isArray(v) ? v : [])
  .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && typeof (o as { id?: unknown }).id === 'string')
  .map((o) => ({ id: String(o.id), label: typeof o.label === 'string' ? o.label : String(o.id), kind: typeof o.kind === 'string' ? o.kind : '' }))
const yes = (k: string) => /^(allow|approve|approved|yes|accept)/i.test(k)
const time = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const plain = (v: unknown, max = 2000): string => {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v.slice(0, max)
  try { return JSON.stringify(v, null, 2).slice(0, max) } catch { return '' }
}

type Mode = { m: 'view' } | { m: 'edit'; text: string; base: number } | { m: 'redraft'; note: string } | { m: 'reject'; note: string }

export function ApprovalCard({ rec }: { rec: Rec<'approval'> }) {
  const a = rec.data
  const target = refOf('approval', a.id)
  const { busy, refusal } = useWrites(writes, (w) => ({ busy: w.busy(target), refusal: w.refusal(target) }))
  const [seen, setSeen] = useState(a.draft_version)
  const [mode, setMode] = useState<Mode>({ m: 'view' })
  const [answer, setAnswer] = useState('')
  // a card that shows up already decided, or that I just decided, follows the hub's version without asking
  useEffect(() => { if (a.status !== 'pending') setSeen(a.draft_version) }, [a.status, a.draft_version])
  const pending = a.status === 'pending'
  const stale = pending && a.draft_version !== seen
  const canAct = pending && !stale && !busy
  const hasDraft = a.kind === 'send' || a.kind === 'plan' || a.kind === 'proposal' || a.kind === 'rollback'
  const editable = a.kind === 'send' || a.kind === 'plan'
  const opts = optionsOf(a.options)
  const detail = useMemo(() => detailOf(a.request), [a.request])
  const node = a.kind === 'glance' || a.kind === 'ask'
  const questions = a.kind === 'ask' ? detail.questions : []
  const [picks, setPicks] = useState<Picks>({})
  const answers = answersOf(questions, picks)

  const save = async (text: string, base: number) => {
    const r = await actions.saveDraft(a.id, text, base)
    if (r.ok) {
      const p = ApprovalRes.safeParse(r.body)
      // I just saved this draft myself: advance `seen` so the card doesn't ask me to confirm my own edit
      setSeen(p.success ? p.data.approval.draft_version : base + 1)
      setMode({ m: 'view' })
    }
    // 409: the store now has the hub's draft (shown above); my text stays in the box, and saving again is on top of
    // the version I can now see
    else if (r.conflict?.approval) setMode({ m: 'edit', text, base: r.conflict.approval.draft_version })
  }

  return (
    <View testID="approval-card" className="mx-3 my-1 rounded-lg p-3 border border-border bg-card gap-2">
      <Text className="text-muted-foreground text-xs">
        {KIND[a.kind] ?? a.kind} · {STATUS[a.status] ?? a.status}{a.draft_version > 1 ? ` · 第 ${a.draft_version} 版` : ''}
        {a.expires_at && pending ? ` · ${time(a.expires_at)} 前` : ''}
        {a.snooze && pending ? ` · 暂缓到${SNOOZE[a.snooze] ?? a.snooze}${a.snooze_until ? `（${time(a.snooze_until)}）` : ''}` : ''}
        {rec.pending ? ' · …' : ''}
      </Text>
      {a.title ? <Text selectable className="text-foreground font-semibold">{a.title}</Text> : null}
      {a.kind === 'send' && (a.channel || a.target) ? (
        <Text selectable className="text-muted-foreground text-xs">发到 {a.channel ?? ''} {plain(a.target, 200)}{a.as_identity === 'user' ? ' · 以我的名义' : ''}</Text>
      ) : null}
      {hasDraft && a.draft !== null ? (
        <View testID="approval-draft" className="rounded bg-muted p-2"><Text selectable className="text-foreground" style={{ lineHeight: 22 }}>{a.draft}</Text></View>
      ) : null}
      {node ? <RequestDetail a={a} /> : null}
      {stale ? (
        <View testID="approval-stale" className="rounded border border-border p-2 gap-1">
          <Text className="text-foreground text-xs">稿子刚换成第 {a.draft_version} 版（上面就是）。看过再定。</Text>
          <Btn small label="看过了" onPress={() => setSeen(a.draft_version)} testID="approval-seen" />
        </View>
      ) : null}

      {pending && mode.m === 'view' ? (
        <Row wrap>
          {questions.length ? null : node ? opts.map((o) => (
            <Btn key={o.id} small label={o.label} variant={yes(o.kind) ? 'primary' : 'outline'} busy={busy} disabled={!canAct}
              onPress={() => void actions.decide(a, seen, { action: 'answer', option_id: o.id })} testID={`approval-option-${o.id}`} />
          )) : (
            <>
              <Btn small label={a.kind === 'send' ? '批准，发出去' : '批准'} variant="primary" busy={busy} disabled={!canAct}
                onPress={() => void actions.decide(a, seen, { action: 'approve' })} testID="approval-approve" />
              <Btn small label="拒绝" busy={busy} disabled={!canAct} onPress={() => setMode({ m: 'reject', note: '' })} testID="approval-reject" />
            </>
          )}
          {editable ? <Btn small label="改稿" disabled={!canAct} onPress={() => setMode({ m: 'edit', text: a.draft ?? '', base: seen })} testID="approval-edit" /> : null}
          {editable ? <Btn small label="改一下" disabled={!canAct} onPress={() => setMode({ m: 'redraft', note: '' })} testID="approval-redraft" /> : null}
          {(['tonight', 'morning', 'monday'] as const).map((u) => (
            <Btn key={u} small variant="ghost" label={`暂缓到${SNOOZE[u]}`} disabled={!canAct || a.snooze === u} onPress={() => void actions.snooze(a.id, u)} testID={`approval-snooze-${u}`} />
          ))}
        </Row>
      ) : null}
      {pending && mode.m === 'view' && questions.length ? (
        <View testID="approval-questions" className="gap-2">
          {questions.map((q, i) => <QuestionForm key={q.question} q={q} i={i} picks={picks} setPicks={setPicks} disabled={!canAct} />)}
          <Row wrap>
            <Btn small variant="primary" label={answers ? '答' : '每一问都答了才能发'} busy={busy} disabled={!canAct || !answers}
              onPress={() => { if (answers) void actions.decide(a, seen, { action: 'answer', answers }) }} testID="approval-answers-send" />
            {opts.filter((o) => !yes(o.kind)).map((o) => (
              <Btn key={o.id} small label={o.label} busy={busy} disabled={!canAct}
                onPress={() => void actions.decide(a, seen, { action: 'answer', option_id: o.id })} testID={`approval-option-${o.id}`} />
            ))}
          </Row>
        </View>
      ) : null}
      {pending && mode.m === 'view' && a.kind === 'ask' && !questions.length ? (
        <Row>
          <TextInput value={answer} onChangeText={setAnswer} placeholder="自己答" maxLength={4000} className="flex-1 border border-border rounded-lg p-2 text-foreground" />
          <Btn small label="答" busy={busy} disabled={!canAct || !answer.trim()} onPress={() => { void actions.decide(a, seen, { action: 'answer', text: answer.trim() }); setAnswer('') }} />
        </Row>
      ) : null}

      {pending && mode.m === 'edit' ? (
        <View className="gap-2">
          <TextInput testID="approval-edit-input" multiline value={mode.text} onChangeText={(t) => setMode({ ...mode, text: t })} maxLength={20_000}
            className="border border-border rounded-lg p-2 text-foreground min-h-24" />
          <Row>
            <Btn small variant="primary" label="存这一版" busy={busy} disabled={!mode.text.trim()} onPress={() => void save(mode.text, mode.base)} testID="approval-edit-save" />
            <Btn small label="算了" onPress={() => setMode({ m: 'view' })} />
          </Row>
        </View>
      ) : null}
      {pending && (mode.m === 'redraft' || mode.m === 'reject') ? (
        <View className="gap-2">
          <TextInput testID="approval-note" value={mode.note} onChangeText={(t) => setMode({ ...mode, note: t })} maxLength={mode.m === 'redraft' ? 4000 : 1000}
            placeholder={mode.m === 'redraft' ? '哪里要改（会交给写这稿的那边）' : '为什么不行（可以不写）'} className="border border-border rounded-lg p-2 text-foreground" />
          <Row>
            {mode.m === 'redraft' ? (
              <Btn small variant="primary" label="让它改" busy={busy} disabled={!canAct || !mode.note.trim()}
                onPress={() => { void actions.redraft(a.id, mode.note.trim(), seen); setMode({ m: 'view' }) }} testID="approval-redraft-send" />
            ) : (
              <Btn small variant="destructive" label="拒绝" busy={busy} disabled={!canAct}
                onPress={() => { void actions.decide(a, seen, { action: 'reject', ...(mode.note.trim() ? { note: mode.note.trim() } : {}) }); setMode({ m: 'view' }) }} testID="approval-reject-send" />
            )}
            <Btn small label="算了" onPress={() => setMode({ m: 'view' })} />
          </Row>
        </View>
      ) : null}

      <Refusal op={refusal} onDismiss={(id) => writes.dismiss(id)}
        extra={refusal?.state === 'conflict' && mode.m === 'edit' ? <Text className="text-foreground text-xs">你写的还在框里；上面是现在的稿子。</Text> : null} />

      {!pending ? <Outcome a={a} /> : null}
    </View>
  )
}

/** One AskUserQuestion question: its options (one, or several when multiSelect), or my own words. */
function QuestionForm({ q, i, picks, setPicks, disabled }: { q: Question; i: number; picks: Picks; setPicks: (f: (p: Picks) => Picks) => void; disabled: boolean }) {
  const p = picks[q.question] ?? { chosen: [], text: '' }
  return (
    <View testID="approval-question" className="rounded border border-border p-2 gap-1">
      {q.header ? <Text selectable className="text-muted-foreground text-xs">{q.header}</Text> : null}
      <Text selectable className="text-foreground">{q.question}{q.multi ? '（可多选）' : ''}</Text>
      {q.options.map((o, j) => {
        const on = p.chosen.includes(o.label)
        return (
          <Pressable key={j} testID={`approval-q${i}-o${j}`} accessibilityRole={q.multi ? 'checkbox' : 'radio'} accessibilityState={{ checked: on, disabled }}
            disabled={disabled} onPress={() => setPicks((s) => pick(s, q, o.label))}
            className={`rounded px-2 py-1 border ${on ? 'border-primary bg-muted' : 'border-border'}`}>
            <Text selectable className="text-foreground text-sm">{q.multi ? (on ? '☑ ' : '☐ ') : (on ? '◉ ' : '○ ')}{o.label}</Text>
            {o.description ? <Text selectable className="text-muted-foreground text-xs">{o.description}</Text> : null}
          </Pressable>
        )
      })}
      <TextInput testID={`approval-q${i}-text`} value={p.text} editable={!disabled} maxLength={4000} placeholder="或者自己说（写了就用这个）"
        onChangeText={(t) => setPicks((s) => ({ ...s, [q.question]: { ...(s[q.question] ?? { chosen: [] }), text: t } }))}
        className="border border-border rounded-lg p-2 text-foreground text-sm" />
    </View>
  )
}

/** What a node asked to do, whole: each field as text (folded when long), its diff, and the rest when it was too big. */
function RequestDetail({ a }: { a: Approval }) {
  const d = useMemo(() => detailOf(a.request), [a.request])
  const diff = useMemo(() => (d.diff ? splitDiff(d.diff) : null), [d.diff])
  const [full, setFull] = useState<{ s: 'no' } | { s: 'loading' } | { s: 'error'; error: string } | { s: 'yes'; text: string }>({ s: 'no' })
  const blob = a.request_blob
  const sha = shaOf(blob?.ref)
  const pull = async () => {
    if (!sha || full.s === 'loading') return
    setFull({ s: 'loading' })
    try {
      const r = await pullBlob(sha, 4 * 1024 * 1024, { request: (m, p, o) => conn.request(m, p, o) })
      setFull(r.ok ? { s: 'yes', text: decodeText(r.bytes) } : { s: 'error', error: r.error })
    } catch { setFull({ s: 'error', error: '没拉到，连上后再试' }) }
  }
  const field = (label: string, v: string | null, lang = '') => (v ? (
    <View key={label}><Text className="text-muted-foreground text-xs">{label}</Text><CodeBlock text={v} lang={lang} open={false} /></View>
  ) : null)
  return (
    <View testID="approval-request" className="gap-1">
      {a.requester?.startsWith('node:') ? <Text className="text-muted-foreground text-xs">来自节点 {a.requester.slice(5, 105)}{d.tool ? ` · 工具 ${d.tool.slice(0, 200)}` : ''}</Text> : d.tool ? <Text className="text-muted-foreground text-xs">工具 {d.tool.slice(0, 200)}</Text> : null}
      {field('命令', d.command, 'bash')}
      {field('路径', d.path)}
      {field('在哪个目录', d.cwd)}
      {diff ? <View><Text className="text-muted-foreground text-xs">要做的改动</Text><DiffView diff={diff} testID="approval-diff" /></View> : null}
      {field('参数', d.args, 'json')}
      {field('原样', d.raw)}
      {blob ? (
        <View className="gap-1">
          <Pressable onPress={() => void pull()} testID="approval-request-full" accessibilityRole="button">
            <Text className="text-foreground text-xs underline">
              上面只是开头：全文 {Math.ceil(blob.size / 1024)} KB{full.s === 'loading' ? ' · 在拉…' : full.s === 'error' ? ` · ${full.error}` : full.s === 'yes' ? '' : ' · 点开拉全文'}
            </Text>
          </Pressable>
          {full.s === 'yes' ? <CodeBlock text={full.text} lang="json" open={false} /> : null}
        </View>
      ) : null}
    </View>
  )
}

function Outcome({ a }: { a: Approval }) {
  const answer = plain(a.answer, 400)
  return (
    <View className="gap-0.5">
      {a.decided_at ? <Text className="text-muted-foreground text-xs">{STATUS[a.status] ?? a.status} · {time(a.decided_at)}{a.decided_by ? ` · ${a.decided_by}` : ''}</Text> : null}
      {a.decide_note ? <Text selectable className="text-muted-foreground text-xs">{a.decide_note}</Text> : null}
      {answer ? <Text selectable className="text-muted-foreground text-xs">答：{answer}</Text> : null}
      {a.delivery ? <Text className="text-muted-foreground text-xs">{DELIVERY[a.delivery.status] ?? a.delivery.status}{a.delivery.error ? `：${a.delivery.error}` : ''}</Text> : null}
      {a.result ? <Text selectable className="text-muted-foreground text-xs">{a.result}</Text> : null}
    </View>
  )
}
