// Web and the desktop: no FCM (07: phone notifications are Android's). The desktop's own notify() comes later.
import type { PushPref, TokenSource } from './push.ts'

export const tokenSource: TokenSource = {
  available: false,
  permission: async () => false,
  token: () => Promise.reject(new Error('no FCM here')),
  onToken: () => () => {},
}
export const pushPref: PushPref = { get: async () => null, set: async () => {} }
export function setupNotifications(_open: (route: string) => void): () => void { return () => {} }
