// What Electron's preload gives the page (07 bridge; desktop/preload.cjs). Android has no bridge: it uses the
// device-key module directly. The private key never crosses: the page gets a public key and signatures.
import type { PairCode, SigPurpose } from '../../../protocol/link.ts'
import type { Pairing } from './conn/machine.ts'

export type SbotBridge = {
  device: { publicKey(): Promise<string>; sign(handshakeHash: string, challenge: string, purpose: SigPurpose): Promise<string> }
  pair: {
    /** main checks the code and the key store (refuses basic_text), keeps the code in memory, reloads for the CSP */
    accept(link: string): Promise<{ ok: true } | { ok: false; error: string }>
    pending(): Promise<PairCode | null>
    cancel(): Promise<void>
    save(p: Pairing): Promise<void>
    current(): Promise<Pairing | null>
    forget(): Promise<void>
    onLink(cb: (link: string) => void): void
  }
  link: { open(url: string): Promise<boolean> }
}

export const bridge: SbotBridge | undefined =
  typeof window !== 'undefined' ? (window as unknown as { sbot?: SbotBridge }).sbot : undefined
