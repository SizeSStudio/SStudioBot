// Android: expo-notifications for the FCM token (getDevicePushTokenAsync only; Expo's push service is never used), the
// four channels, and taps (07 「安卓」). Inert unless the build had google-services.json (app.config.ts sets
// extra.fcm): without a Firebase project nothing here asks for a token or a permission.
// 待测（手机）：token on a real device once a Firebase project exists; channel importance; tap from a killed app.
import Constants from 'expo-constants'
import * as N from 'expo-notifications'
import DeviceKey from '../../modules/device-key/index.ts'
import { CHANNELS, presentation, tapRoute, type PushPref, type TokenSource } from './push.ts'

const built = (Constants.expoConfig?.extra as { fcm?: unknown } | undefined)?.fcm === true
const IMPORTANCE = { high: N.AndroidImportance.HIGH, default: N.AndroidImportance.DEFAULT, low: N.AndroidImportance.LOW } as const

export const tokenSource: TokenSource = {
  available: built,
  async permission() {
    const p = await N.getPermissionsAsync()
    return p.granted || (p.canAskAgain && (await N.requestPermissionsAsync()).granted)
  },
  async token() {
    const t = await N.getDevicePushTokenAsync()
    if (typeof t.data !== 'string' || !t.data) throw new Error('no FCM token')
    return t.data
  },
  onToken(cb) {
    const s = N.addPushTokenListener((t) => { if (typeof t.data === 'string' && t.data) cb(t.data) })
    return () => s.remove()
  },
}

export const pushPref: PushPref = {
  async get() { const v = await DeviceKey.getPref('phone_push'); return v === null ? null : v === '1' },
  async set(on) { await DeviceKey.setPref('phone_push', on ? '1' : '0') },
}

export function setupNotifications(open: (route: string) => void): () => void {
  if (!built) return () => {}
  for (const c of CHANNELS) void N.setNotificationChannelAsync(c.id, { name: c.name, importance: IMPORTANCE[c.importance] })
  // In front: show only what the rules allow. A personal push, or one whose data doesn't parse, is swapped for a local
  // one that says no more than presentation() does (in the background the hub's own text already says only that).
  N.setNotificationHandler({
    async handleNotification(n) {
      const c = n.request.content
      const p = presentation(c.data, c.title, c.body)
      const same = (c.title ?? '') === p.title && (c.body ?? '') === p.body
      if (!same) {
        void N.scheduleNotificationAsync({ content: { title: p.title, body: p.body || undefined, data: c.data ?? {} }, trigger: { channelId: p.channel } })
        return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false }
      }
      return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: p.channel !== 'fyi', shouldSetBadge: false }
    },
  })
  // a tap opens the item by its ref; what's shown there is the hub's state, not this payload
  const take = (r: N.NotificationResponse | null) => { if (r) open(tapRoute(r.notification.request.content.data)) }
  void N.getLastNotificationResponseAsync().then(take)
  const sub = N.addNotificationResponseReceivedListener(take)
  return () => sub.remove()
}
