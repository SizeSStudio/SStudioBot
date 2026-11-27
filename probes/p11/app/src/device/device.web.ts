import { bridge } from '../bridge.ts'
// 私钥只在 Electron 主进程；这里只转调 bridge
export const device = {
  publicKey: () => (bridge ? bridge.device.publicKey() : Promise.reject(new Error('no bridge'))),
  sign: (h: string, c: string) => (bridge ? bridge.device.sign(h, c) : Promise.reject(new Error('no bridge'))),
  backend: () => (bridge ? bridge.device.backend() : Promise.resolve('none')),
}
