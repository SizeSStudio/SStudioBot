// What a node's 看一眼 / 问我 card carries (protocol/node/v1.ts PermissionRequest.detail → Approval.request): the
// tool, the command, the path, a diff, and for an ask AskUserQuestion's questions. All of it is the agent's
// untrusted text: these functions only pick out strings and cap counts, the card shows them as plain text, whole (a
// command cut short could hide its tail, so nothing here is cut; the card folds long ones instead). Plain TS: node
// --test runs it.

export type Question = { question: string; header: string | null; options: { label: string; description: string | null }[]; multi: boolean }
export type Detail = {
  tool: string | null
  command: string | null
  path: string | null
  cwd: string | null
  /** anything else it gave (args), as JSON text */
  args: string | null
  diff: string | null
  questions: Question[]
  /** the request wasn't an object (an older node, or a preview of a big one): shown as it is */
  raw: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null)
const json = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  try { return JSON.stringify(v, null, 2) ?? null } catch { return null }
}

const MAX_QUESTIONS = 20, MAX_OPTIONS = 30

export function questionsOf(v: unknown): Question[] {
  if (!Array.isArray(v)) return []
  const out: Question[] = []
  for (const q of v.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object') continue
    const o = q as { question?: unknown; header?: unknown; options?: unknown; multiSelect?: unknown }
    const question = str(o.question)
    if (!question) continue
    // the answer is keyed by the question text: two the same can't both be answered, so the second is dropped
    if (out.some((x) => x.question === question)) continue
    const options = (Array.isArray(o.options) ? o.options : []).slice(0, MAX_OPTIONS)
      .map((x) => (x && typeof x === 'object' ? x as { label?: unknown; description?: unknown } : {}))
      .filter((x) => str(x.label))
      .map((x) => ({ label: x.label as string, description: str(x.description) }))
    out.push({ question, header: str(o.header), options, multi: o.multiSelect === true })
  }
  return out
}

export function detailOf(request: unknown): Detail {
  if (request === null || request === undefined) return { tool: null, command: null, path: null, cwd: null, args: null, diff: null, questions: [], raw: null }
  if (typeof request !== 'object' || Array.isArray(request)) {
    return { tool: null, command: null, path: null, cwd: null, args: null, diff: null, questions: [], raw: typeof request === 'string' ? request : json(request) }
  }
  const r = request as Record<string, unknown>
  const { tool, command, path, cwd, args, diff, questions, ...rest } = r
  const extra = Object.keys(rest).length ? rest : undefined
  return {
    tool: str(tool),
    command: str(command) ?? (command !== undefined ? json(command) : null),
    path: str(path),
    cwd: str(cwd),
    args: json(args ?? extra),
    diff: str(diff),
    questions: questionsOf(questions),
    raw: null,
  }
}

/** A pick for each question: the option labels I chose, or my own text (which wins when it isn't empty). */
export type Picks = Record<string, { chosen: string[]; text: string }>

/** question → answer, the way AskUserQuestion takes it (several picks joined with ", "); null until all are answered */
export function answersOf(qs: Question[], picks: Picks): Record<string, string> | null {
  if (!qs.length) return null
  const out: Record<string, string> = {}
  for (const q of qs) {
    const p = picks[q.question]
    const own = p?.text.trim() ?? ''
    const chosen = (p?.chosen ?? []).filter((l) => q.options.some((o) => o.label === l))
    const a = own || chosen.join(', ')
    if (!a) return null
    out[q.question] = a.slice(0, 4000)
  }
  return out
}

/** toggle (multi) or set (single) one option label in my picks */
export function pick(picks: Picks, q: Question, label: string): Picks {
  const cur = picks[q.question] ?? { chosen: [], text: '' }
  const chosen = q.multi ? (cur.chosen.includes(label) ? cur.chosen.filter((l) => l !== label) : [...cur.chosen, label]) : [label]
  return { ...picks, [q.question]: { ...cur, chosen } }
}
