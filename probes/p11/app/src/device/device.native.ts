// 安卓：modules/device-key（Keystore）在 W2 写，P4 安卓真机待测；spike 里不做软件替身
const todo = () => Promise.reject(new Error('P4 安卓：Keystore 本地模块真机待测'))
export const device = { publicKey: todo, sign: (_h: string, _c: string) => todo(), backend: () => Promise.resolve('android-keystore (待测)') }
