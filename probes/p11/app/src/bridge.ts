// 渲染进程能碰到的只有 preload 给的这几个函数（07 bridge）；安卓上没有，走各自的原生实现。
export type SbotBridge = {
  device: { publicKey(): Promise<string>; sign(handshakeHash: string, challenge: string): Promise<string>; backend(): Promise<string> }
  pair: { accept(link: string): Promise<{ ok: boolean; error?: string }>; onLink(cb: (link: string) => void): void }
  link: { open(url: string): Promise<boolean> }
  html: { open(sha: string, html: string): Promise<string> }
  notify(title: string, body: string, ref: string): void
  probe: { report(name: string, data: unknown): void }
}

export const bridge: SbotBridge | undefined =
  typeof window !== 'undefined' ? (window as unknown as { sbot?: SbotBridge }).sbot : undefined
