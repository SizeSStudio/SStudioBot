// app.json plus what depends on this machine. google-services.json is instance data and never enters the repo (07
// 「安卓」): `npm run prebuild` copies it from ~/.config/sbot/ next to this file (gitignored). Without it the build has
// no FCM at all: extra.fcm is false and src/push/ never asks for a token or a permission. Paths stay relative, so no
// home directory ends up in the embedded config. Expo runs this with the app directory as cwd.
import { existsSync } from 'node:fs'
import type { ConfigContext, ExpoConfig } from 'expo/config'

export default ({ config }: ConfigContext): ExpoConfig => {
  const fcm = existsSync('./google-services.json')
  return {
    ...(config as ExpoConfig),
    android: { ...config.android, ...(fcm ? { googleServicesFile: './google-services.json' } : {}) },
    extra: { ...config.extra, fcm },
  }
}
