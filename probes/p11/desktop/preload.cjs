// 沙箱里的 preload 只能是 CommonJS。窄 bridge：就这几个函数（07），私钥不过来。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sbot', {
  device: {
    publicKey: () => ipcRenderer.invoke('device.publicKey'),
    sign: (h, c) => ipcRenderer.invoke('device.sign', String(h), String(c)),
    backend: () => ipcRenderer.invoke('device.backend'),
  },
  pair: {
    accept: link => ipcRenderer.invoke('pair.accept', String(link)),
    onLink: cb => { ipcRenderer.on('pair.link', (_e, link) => cb(String(link))) },
  },
  link: { open: url => ipcRenderer.invoke('link.open', String(url)) },
  html: { open: (sha, html) => ipcRenderer.invoke('html.open', String(sha), String(html)) },
  notify: (title, body, ref) => ipcRenderer.send('notify', String(title), String(body), String(ref)),
  probe: { report: (name, data) => ipcRenderer.send('probe.report', String(name), JSON.stringify(data)) },
})
