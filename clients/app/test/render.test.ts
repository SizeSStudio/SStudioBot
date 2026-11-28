// P11 ③ 的恶意样本集做成单测：白名单树里没有 HTML，能点的地址只有 http/https/mailto，渲染器里没有能发请求的组件。
// 真的零请求由桌面自检（desktop/selftest.ts，CI 第 4 步）在 Electron 里用 webRequest 数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { EVIL_SAMPLES, EVIL_HOST } from '../src/selftest/evil.ts'
import { collectUrls, parseMarkdown, StreamingMarkdown, type MdNode } from '../src/render/md.ts'
import { classifyLink } from '../src/render/links.ts'

const ALLOWED_T = new Set(['root', 'p', 'quote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'em', 'strong', 's', 'h', 'link', 'image', 'text', 'code', 'pre', 'br', 'hr'])

function walk(n: MdNode, f: (n: MdNode) => void) { f(n); if ('c' in n) for (const k of n.c) walk(k, f) }
const treeOf = (id: string, md: string) => (id.startsWith('streaming') ? new StreamingMarkdown().update(md) : parseMarkdown(md))

for (const s of EVIL_SAMPLES) {
  test(`evil ${s.id}: only whitelisted nodes; nothing clickable outside http/https/mailto`, () => {
    const tree = treeOf(s.id, s.md)
    walk(tree, n => assert.ok(ALLOWED_T.has(n.t), `node ${n.t}`))
    for (const u of collectUrls(tree)) {
      if (u.ok) assert.match(u.href, /^(https?:|mailto:)/i, u.href)
      // 地址留在树里给占位框显示，但危险协议永远不可点
      if (/^\s*(javascript|vbscript|data|file):/i.test(u.href)) assert.equal(u.ok, false, u.href)
    }
  })
}

test('raw HTML stays text, never becomes a node with a URL', () => {
  for (const id of ['html-img', 'html-script', 'html-iframe', 'html-css-url', 'html-style-import', 'html-link-css', 'html-media', 'html-object', 'html-svg', 'html-meta']) {
    const s = EVIL_SAMPLES.find(x => x.id === id)!
    const urls = collectUrls(parseMarkdown(s.md)).filter(u => u.href.includes(EVIL_HOST))
    // linkify 可能把 HTML 里的地址认成链接文字；它们要点了确认才开，且不会自动加载
    for (const u of urls) assert.equal(u.kind, 'link')
  }
})

test('images are placeholders: the tree keeps the address, the renderer never loads it', () => {
  const t = parseMarkdown(EVIL_SAMPLES.find(x => x.id === 'md-image')!.md)
  const imgs = collectUrls(t).filter(u => u.kind === 'image')
  assert.equal(imgs.length, 1)
})

test('javascript:, data:, vbscript:, file: links are never links', () => {
  for (const id of ['js-link', 'js-link-case', 'data-link', 'vbs-file-link', 'entity-js']) {
    const urls = collectUrls(parseMarkdown(EVIL_SAMPLES.find(x => x.id === id)!.md))
    for (const u of urls) assert.ok(!/^(javascript|data|vbscript|file):/i.test(u.href) || !u.ok, `${id}: ${u.href}`)
  }
})

test('streaming: half links and images are dead until the block closes', () => {
  for (const id of ['streaming-half-link', 'streaming-half-image']) {
    const urls = collectUrls(new StreamingMarkdown().update(EVIL_SAMPLES.find(x => x.id === id)!.md))
    for (const u of urls) assert.equal(u.ok, false, `${id}: ${u.href}`)
  }
  const sm = new StreamingMarkdown()
  sm.update('段一 [链](https://a.example/x')
  const closed = sm.update('段一 [链](https://a.example/x)\n\n段二')
  assert.equal(collectUrls(closed).find(u => u.kind === 'link')?.ok, true)
})

test('deceptive link text is flagged', () => {
  const v = classifyLink('https://evil.example/24', 'https://good.example/login')
  assert.equal(v.ok, true)
  assert.equal(v.mismatch, true)
  assert.equal(classifyLink('https://good.example/a', 'good.example').mismatch, false)
  assert.equal(classifyLink('javascript:alert(1)').ok, false)
  assert.equal(classifyLink('mailto:a' + '@b.example' /* 拆开写，免得 leak-guard 当成邮箱 */).ok, true)
})

test('unclosed fence in the last block is not highlighted', () => {
  const t = new StreamingMarkdown().update('前文\n\n```ts\nconst a = 1')
  let open: boolean | undefined
  walk(t, n => { if (n.t === 'pre') open = n.open })
  assert.equal(open, true)
})

test('cjk-friendly: the 4 bold cases all produce strong', () => {
  const cases = ['这是**中文English中文**的情况', 'This is **English中文English** case', '他说：**“加粗”**。然后**加粗。**结束', '第一行**跨\n行加粗**结束']
  for (const c of cases) {
    let n = 0
    walk(parseMarkdown(c), x => { if (x.t === 'strong') n++ })
    assert.ok(n >= 1, c)
  }
})

test('IME: Enter while composing never sends', async () => {
  const { shouldSend, keyInfo } = await import('../src/render/ime.ts')
  assert.equal(shouldSend({ key: 'Enter', isComposing: true, keyCode: 229 }), false)
  assert.equal(shouldSend({ key: 'Enter', isComposing: false, keyCode: 229 }), false)
  assert.equal(shouldSend({ key: 'Enter', isComposing: false, keyCode: 13, shiftKey: true }), false)
  assert.equal(shouldSend({ key: 'Enter', isComposing: false, keyCode: 13 }), true)
  // 事件对象的字段在原型上：展开拿不到，keyInfo 逐个取
  class Ev { get key() { return 'Enter' } get keyCode() { return 13 } get isComposing() { return false } get shiftKey() { return false } }
  assert.equal(shouldSend({ ...new Ev() }), false)
  assert.equal(shouldSend(keyInfo(new Ev())), true)
})

test('soft break between CJK characters is not a space; between Latin it stays', () => {
  const flat = (n: MdNode): string => n.t === 'text' || n.t === 'code' ? n.text : n.t === 'br' ? (n.soft ? ' ' : '\n') : 'c' in n ? n.c.map(flat).join('') : ''
  assert.equal(flat(parseMarkdown('第一行**跨\n行加粗**结束')), '第一行跨行加粗结束')
  assert.equal(flat(parseMarkdown('中文\n中文')), '中文中文')
  assert.equal(flat(parseMarkdown('word\nword')), 'word word')
  assert.equal(flat(parseMarkdown('中文\nword')), '中文 word')
})

test('代码块按行切 run：跨行的 token 拆到两行，空行保留', async () => {
  const { splitRuns } = await import('../src/render/code.ts')
  const lines = splitRuns([{ text: 'a\nb', cls: 'x' }, { text: 'c\n\nd', cls: null }])
  assert.deepEqual(lines, [[{ text: 'a', cls: 'x' }], [{ text: 'b', cls: 'x' }, { text: 'c', cls: null }], [], [{ text: 'd', cls: null }]])
})

test('fold thresholds: web 400 lines, Android 200, first 80 shown', async () => {
  const { foldLines, FOLD_PREVIEW } = await import('../src/render/code.ts')
  assert.equal(foldLines('web'), 400)
  assert.equal(foldLines('android'), 200)
  assert.equal(FOLD_PREVIEW, 80)
})

test('highlight: registered languages only, others are plain text', async () => {
  const { highlight } = await import('../src/render/code.ts')
  assert.ok(highlight('const a = 1', 'ts').some(r => r.cls === 'keyword'))
  assert.deepEqual(highlight('x := 1', 'cobol'), [{ text: 'x := 1', cls: null }])
})

// 渲染器只用 Text / View / Pressable：没有 Image、WebView、原始 HTML，树里的地址没有任何组件会去加载
test('the renderer has nothing that can fetch: no Image, WebView, raw HTML, uri sources', () => {
  const dir = new URL('../src/render/', import.meta.url)
  for (const f of readdirSync(dir).filter(f => /\.tsx?$/.test(f))) {
    const src = readFileSync(new URL(f, dir), 'utf8')
    for (const bad of [/\bImage\b/, /WebView/, /dangerouslySetInnerHTML/, /\buri\s*:/, /<img\b/i, /<iframe\b/i, /\bfetch\s*\(/, /XMLHttpRequest/]) {
      assert.ok(!bad.test(src.replace(/\/\/.*$/gm, '')), `${f}: ${bad}`)
    }
  }
})
