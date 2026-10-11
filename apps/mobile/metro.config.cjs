const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');
const config = getDefaultConfig(__dirname);
// The only imported file outside the package is the pure shared DTO contract (type-only).
config.watchFolders = [path.resolve(__dirname, '../../src/mobile')];
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;
module.exports = config;
