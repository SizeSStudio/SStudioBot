// Before `expo prebuild`: copy this instance's google-services.json from ~/.config/sbot/ (07: instance config lives
// there, never in the repo) next to app.config.ts, or remove a stale copy. No file = a build without FCM.
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const src = path.join(os.homedir(), '.config', 'sbot', 'google-services.json')
const dst = path.join(import.meta.dirname, '..', 'google-services.json')
if (existsSync(src)) { copyFileSync(src, dst); console.log('FCM: google-services.json copied in') }
else { rmSync(dst, { force: true }); console.log('FCM: no google-services.json in ~/.config/sbot, building without push') }
