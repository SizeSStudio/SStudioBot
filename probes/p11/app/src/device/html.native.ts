// 写进 App 私有缓存，FileProvider 给 content:// 只读地址，ACTION_VIEW 交给浏览器（07）
import * as FS from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'

export async function openHtmlNative(sha: string, html: string): Promise<string> {
  const dir = `${FS.cacheDirectory}sbot-html/`
  await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {})
  const file = `${dir}${sha}.html`
  await FS.writeAsStringAsync(file, html)
  const uri = await FS.getContentUriAsync(file)
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', { data: uri, type: 'text/html', flags: 1 /* GRANT_READ_URI_PERMISSION */ })
  return uri
}
