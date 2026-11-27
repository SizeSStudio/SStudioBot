// 输入法组字时回车不发送（P11 ④）。网页读 DOM KeyboardEvent 的 isComposing，keyCode 229 兜底（Safari、部分输入法）。
// 注意：DOM 事件的字段是原型上的 getter，不能用 {...e} 展开，要逐个取。
export type KeyInfo = { key?: string; isComposing?: boolean; keyCode?: number; shiftKey?: boolean }

export function shouldSend(e: KeyInfo): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false
  if (e.isComposing || e.keyCode === 229) return false
  return true
}

export const keyInfo = (ne: KeyInfo): KeyInfo => ({ key: ne.key, isComposing: ne.isComposing, keyCode: ne.keyCode, shiftKey: ne.shiftKey })
