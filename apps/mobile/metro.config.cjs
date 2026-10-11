const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const { mkdirSync } = require('node:fs');
const config = getDefaultConfig(__dirname);
const { FileStore } = require(require.resolve('metro-cache', { paths: [require.resolve('expo/metro-config')] }));
config.cacheStores = [new FileStore({ root: path.join(__dirname, '.expo', 'metro-cache') })];
config.fileMapCacheDirectory = path.join(__dirname, '.expo', 'file-map');
mkdirSync(config.fileMapCacheDirectory, { recursive: true });
// The only imported file outside the package is the pure shared DTO contract (type-only).
config.watchFolders = [path.resolve(__dirname, '../../src/mobile')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
// Expo intentionally nests some SDK dependencies; their own package resolution must work.
config.resolver.disableHierarchicalLookup = false;
module.exports = config;
