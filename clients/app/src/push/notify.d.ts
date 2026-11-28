// Metro picks notify.native.ts or notify.web.ts; this is what tsc sees.
import type { PushPref, TokenSource } from './push.ts'
export declare const tokenSource: TokenSource
export declare const pushPref: PushPref
/** channels, the foreground rule and taps; `open` gets an app route. Returns the unsubscribe. */
export declare function setupNotifications(open: (route: string) => void): () => void
