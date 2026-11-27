import { bridge } from '../bridge.ts'

// 探针结果：Electron 经 bridge 交给主进程写文件，安卓打到 logcat（tag ReactNativeJS）。
export function report(name: string, data: unknown) {
  const g = globalThis as unknown as { __probe?: Record<string, unknown> }
  g.__probe ??= {}
  g.__probe[name] = data
  console.log('PROBE ' + JSON.stringify({ name, data }))
  bridge?.probe.report(name, data)
}

export const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

// JS 线程帧间隔：rAF 两端都有（Hermes 上就是 JS 帧）
export function frameMonitor() {
  const deltas: number[] = []
  let last = 0
  let on = true
  const tick = (t: number) => {
    if (last) deltas.push(t - last)
    last = t
    if (on) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return {
    stop() {
      on = false
      const s = [...deltas].sort((a, b) => a - b)
      const med = s[Math.floor(s.length / 2)] ?? 0
      return { frames: s.length, medianFps: med ? Math.round(1000 / med) : 0, maxFrameMs: Math.round(s[s.length - 1] ?? 0), over100: s.filter(d => d > 100).length, p95Ms: Math.round(s[Math.floor(s.length * 0.95)] ?? 0) }
    },
  }
}
