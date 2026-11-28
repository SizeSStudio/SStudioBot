const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const config = getDefaultConfig(__dirname)

// lowlight 的入口顺带 import 了 highlight.js 的全部语言（1.5 MB 源码）；我们只要 createLowlight，自己注册 16 种
const lowlightCore = path.join(path.dirname(require.resolve('lowlight')), 'lib/index.js')
const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (ctx, name, platform) => {
  if (name === 'lowlight') return { type: 'sourceFile', filePath: lowlightCore }
  return (upstream ?? ctx.resolveRequest)(ctx, name, platform)
}

module.exports = withUniwindConfig(config, { cssEntryFile: './global.css', dtsFile: './uniwind-types.d.ts' })
