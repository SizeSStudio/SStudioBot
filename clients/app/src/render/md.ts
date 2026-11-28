// markdown → 白名单节点树。纯函数，不碰 RN；渲染器只做节点 → 组件的映射。
import MarkdownIt from 'markdown-it'
import cjkFriendly from 'markdown-it-cjk-friendly'
import remend from 'remend'
import { classifyLink, type LinkVerdict } from './links.ts'

export type MdNode =
  | { t: 'root' | 'p' | 'quote' | 'ul' | 'li' | 'table' | 'thead' | 'tbody' | 'tr' | 'em' | 'strong' | 's'; c: MdNode[] }
  | { t: 'h'; level: number; c: MdNode[] }
  | { t: 'ol'; start: number; c: MdNode[] }
  | { t: 'th' | 'td'; align: string | null; c: MdNode[] }
  | { t: 'link'; href: string; verdict: LinkVerdict; c: MdNode[] }
  | { t: 'image'; src: string; alt: string; verdict: LinkVerdict }
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'pre'; lang: string; text: string; open: boolean }
  | { t: 'br'; soft: boolean }
  | { t: 'hr' }

type Container = Extract<MdNode, { c: MdNode[] }>

const md = new MarkdownIt({ html: false, linkify: true, typographer: false }).use(cjkFriendly)

const OPEN: Record<string, string> = {
  paragraph_open: 'p', blockquote_open: 'quote', bullet_list_open: 'ul', list_item_open: 'li',
  table_open: 'table', thead_open: 'thead', tbody_open: 'tbody', tr_open: 'tr',
  em_open: 'em', strong_open: 'strong', s_open: 's',
}

type Tok = ReturnType<typeof md.parse>[number]

function walk(tokens: Tok[], root: Container, dead: boolean) {
  const stack: Container[] = [root]
  const top = () => stack[stack.length - 1]
  for (const tok of tokens) {
    if (tok.nesting === 1) {
      let node: Container
      const simple = OPEN[tok.type]
      if (simple) node = { t: simple, c: [] } as Container
      else if (tok.type === 'heading_open') node = { t: 'h', level: Number(tok.tag.slice(1)) || 1, c: [] }
      else if (tok.type === 'ordered_list_open') node = { t: 'ol', start: Number(tok.attrGet('start') ?? 1), c: [] }
      else if (tok.type === 'th_open' || tok.type === 'td_open') {
        const style = String(tok.attrGet('style') ?? '')
        node = { t: tok.type === 'th_open' ? 'th' : 'td', align: /text-align:(\w+)/.exec(style)?.[1] ?? null, c: [] }
      } else if (tok.type === 'link_open') {
        const href = String(tok.attrGet('href') ?? '')
        node = { t: 'link', href, verdict: classifyLink(href), c: [] }
      } else node = { t: 'strong', c: [] } // 不认识的容器：取不到这里（html: false），保守按普通文字容器
      top().c.push(node)
      stack.push(node)
      continue
    }
    if (tok.nesting === -1) {
      const node = stack.pop()
      if (node && node.t === 'link') {
        const text = node.c.map(n => (n.t === 'text' || n.t === 'code' ? n.text : '')).join('')
        node.verdict = classifyLink(node.href, text)
        if (dead) node.verdict = { ...node.verdict, ok: false, reason: 'streaming' }
      }
      continue
    }
    switch (tok.type) {
      case 'inline': walk(tok.children ?? [], top(), dead); fixCjkBreaks(top().c); break
      case 'text': top().c.push({ t: 'text', text: tok.content }); break
      case 'code_inline': top().c.push({ t: 'code', text: tok.content }); break
      case 'softbreak': top().c.push({ t: 'br', soft: true }); break
      case 'hardbreak': top().c.push({ t: 'br', soft: false }); break
      case 'hr': top().c.push({ t: 'hr' }); break
      case 'fence':
      case 'code_block': {
        const lang = (tok.info ?? '').trim().split(/\s+/)[0] ?? ''
        top().c.push({ t: 'pre', lang, text: tok.content, open: false })
        break
      }
      case 'image': {
        const src = String(tok.attrGet('src') ?? '')
        const alt = (tok.children ?? []).map(c => c.content).join('') || tok.content
        let verdict = classifyLink(src)
        if (dead) verdict = { ...verdict, ok: false, reason: 'streaming' }
        top().c.push({ t: 'image', src, alt, verdict })
        break
      }
      default:
        // html_inline / html_block 在 html:false 下不会出现；万一出现按纯文字
        if (tok.content) top().c.push({ t: 'text', text: tok.content })
    }
  }
}

// 中文之间的软换行不渲染成空格（「跨\n行」不变成「跨 行」）
const CJK = /[\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

function edge(n: MdNode | undefined, last: boolean): string {
  if (!n) return ''
  if (n.t === 'text' || n.t === 'code') return last ? n.text.slice(-1) : n.text.slice(0, 1)
  if ('c' in n) return edge(last ? n.c[n.c.length - 1] : n.c[0], last)
  return ''
}

function fixCjkBreaks(c: MdNode[]) {
  for (let i = 0; i < c.length; i++) {
    const n = c[i]!
    if (n.t === 'br' && n.soft && CJK.test(edge(c[i - 1], true)) && CJK.test(edge(c[i + 1], false))) c[i] = { t: 'text', text: '' }
    else if ('c' in n) fixCjkBreaks(n.c)
  }
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

// 最后一块里有没有没收尾的 fence（正在流的代码块不高亮）
function unclosedFence(src: string): boolean {
  let open: string | null = null
  for (const line of src.split('\n')) {
    const m = FENCE_RE.exec(line)
    if (!m) continue
    if (open === null) open = m[1]![0]!.repeat(m[1]!.length)
    else if (m[1]![0] === open[0] && m[1]!.length >= open.length && line.trim() === m[1]) open = null
  }
  return open !== null
}

export function parseMarkdown(src: string): MdNode {
  const root: Container = { t: 'root', c: [] }
  walk(md.parse(src, {}), root, false)
  return root
}

// 流式：先过 remend，再只重解析最后一块；前面已闭合的块缓存 token。
export class StreamingMarkdown {
  private closed: MdNode[] = []
  private closedLen = 0

  update(full: string): MdNode {
    // 最后一个空行之前的部分是闭合的（不在 fence 里时）
    let cut = full.lastIndexOf('\n\n')
    while (cut > this.closedLen && unclosedFence(full.slice(0, cut))) cut = full.lastIndexOf('\n\n', cut - 1)
    if (cut > this.closedLen) {
      const head = full.slice(this.closedLen, cut)
      const r: Container = { t: 'root', c: [] }
      walk(md.parse(head, {}), r, false)
      this.closed.push(...r.c)
      this.closedLen = cut
    }
    const tail = full.slice(this.closedLen)
    const r: Container = { t: 'root', c: [] }
    const open = unclosedFence(tail)
    walk(md.parse(remend(tail), {}), r, true)
    if (open) for (const n of r.c) if (n.t === 'pre') n.open = true
    return { t: 'root', c: [...this.closed, ...r.c] }
  }

  reset() { this.closed = []; this.closedLen = 0 }
}

// 测试和抓包用：树里所有会被渲染成「可点」的地址
export function collectUrls(n: MdNode, out: { href: string; ok: boolean; kind: 'link' | 'image' }[] = []) {
  if (n.t === 'link') out.push({ href: n.href, ok: n.verdict.ok, kind: 'link' })
  if (n.t === 'image') out.push({ href: n.src, ok: n.verdict.ok, kind: 'image' })
  if ('c' in n) for (const k of n.c) collectUrls(k, out)
  return out
}
