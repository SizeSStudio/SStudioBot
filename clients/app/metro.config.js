const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')

const config = getDefaultConfig(__dirname)
const clients = path.resolve(__dirname, '..')
const repo = path.resolve(clients, '..')

// protocol/ lives at the repo root (07 目录): watch it, and resolve what it imports (zod, @noble/*) from
// clients/node_modules only, never the root's (CI checks both lockfiles pin the same versions)
config.watchFolders = [...(config.watchFolders ?? []), path.join(repo, 'protocol')]
config.resolver.nodeModulesPaths = [path.join(clients, 'node_modules')]
config.resolver.disableHierarchicalLookup = true

// lowlight's entry also imports every highlight.js language (1.5 MB of source); we only want createLowlight and
// register 16 ourselves
const lowlightCore = path.join(path.dirname(require.resolve('lowlight')), 'lib/index.js')
const upstream = config.resolver.resolveRequest
config.resolver.resolveRequest = (ctx, name, platform) => {
  if (name === 'lowlight') return { type: 'sourceFile', filePath: lowlightCore }
  return (upstream ?? ctx.resolveRequest)(ctx, name, platform)
}

module.exports = withUniwindConfig(config, { cssEntryFile: './global.css', dtsFile: './uniwind-types.d.ts' })
