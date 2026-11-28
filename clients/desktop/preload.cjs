// A sandboxed preload has to be CommonJS. The whole bridge (07): the page can ask for the public key and a signature,
// hand over a pairing code, keep its pairing, open a link. The private key never comes across.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sbot', {
  device: {
    publicKey: () => ipcRenderer.invoke('device.publicKey'),
    sign: (handshakeHash, challenge, purpose) => ipcRenderer.invoke('device.sign', String(handshakeHash), String(challenge), String(purpose)),
  },
  pair: {
    accept: (link) => ipcRenderer.invoke('pair.accept', String(link)),
    pending: () => ipcRenderer.invoke('pair.pending'),
    cancel: () => ipcRenderer.invoke('pair.cancel'),
    save: (p) => ipcRenderer.invoke('pair.save', { hub_pk: String(p.hub_pk), relay: String(p.relay), device_id: String(p.device_id), role: String(p.role) }),
    current: () => ipcRenderer.invoke('pair.current'),
    forget: () => ipcRenderer.invoke('pair.forget'),
    // a sstudiobot://pair link from the OS: main keeps it until the page takes it
    onLink: (cb) => {
      const take = () => ipcRenderer.invoke('pair.takeLink').then((l) => { if (l) cb(String(l)) })
      ipcRenderer.on('pair.link', take)
      void take()
    },
  },
  link: { open: (url) => ipcRenderer.invoke('link.open', String(url)) },
})
