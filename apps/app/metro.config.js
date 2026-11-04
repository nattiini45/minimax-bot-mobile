const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// The app lives in a monorepo, so Metro has to watch the workspace and resolve
// hoisted dependencies from the repository root.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
// Dependencies may legally own a nested version that differs from the root.
// Keep normal package lookup before the workspace's hoisted fallback paths.
config.resolver.disableHierarchicalLookup = false;

module.exports = config;
