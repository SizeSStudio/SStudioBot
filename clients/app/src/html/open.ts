// HTML an agent made (D14, 07 「agent 做的 HTML」): never rendered in the app. The desktop pulls the blob over the
// connection and hands the bytes to main (bridge html.open), which checks them against the sha, writes a local file
// and gives it to the system browser. Android's FileProvider route comes with the Android build ※; until then it
// says so.
import { bridge } from '../bridge.ts'
import { conn } from '../conn/client.ts'
import { pullAndOpenHtml, type HtmlRef } from './pull.ts'

export { HTML_MAX, htmlRefOf, type HtmlRef } from './pull.ts'
export const canOpenHtml = () => !!bridge?.html

export function openHtml(h: HtmlRef): Promise<{ ok: true } | { ok: false; error: string }> {
  const html = bridge?.html
  return pullAndOpenHtml(h, {
    request: (m, p, o) => conn.request(m, p, o),
    open: html ? (sha, bytes) => html.open(sha, bytes) : undefined,
  })
}
