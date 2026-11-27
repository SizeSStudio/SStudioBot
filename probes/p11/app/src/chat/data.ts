// 500 条历史：中文为主，夹 markdown 和代码，长短不一。
const PARAS = [
  '今天把**中继的信封**改完了，`type | sid | payload` 三段，主那条 WS 多路复用。',
  '下面是一段代码：\n\n```ts\nconst x = await fetch(url)\nif (!x.ok) throw new Error(String(x.status))\n```',
  '- 第一条\n- 第二条：**中文包 English 加粗**\n- 第三条',
  '> 引用一段话，看行高会不会裁掉「字」的上下沿。',
  '短的。',
  '这一条比较长。'.repeat(12),
  '| 列 | 值 |\n|---|---|\n| 甲 | 1 |\n| 乙 | 2 |',
]

export type Msg = { id: string; role: 'me' | 'agent'; text: string }

export function makeHistory(n = 500): Msg[] {
  const out: Msg[] = []
  for (let i = 0; i < n; i++) out.push({ id: `h${i}`, role: i % 3 === 0 ? 'me' : 'agent', text: `#${i} ` + PARAS[i % PARAS.length]! })
  return out
}

// 2000 字回复，切成段按 50 段/秒推
export function makeReply(chars = 2000, segLen = 10): string[] {
  const base = '流式回复里有**加粗**、`代码`、链接 https://example.com/doc 和中文标点，，。。看贴底和帧率。\n\n'
  let s = ''
  while (s.length < chars) s += base
  s = s.slice(0, chars)
  const segs: string[] = []
  for (let i = 0; i < s.length; i += segLen) segs.push(s.slice(i, i + segLen))
  return segs
}
