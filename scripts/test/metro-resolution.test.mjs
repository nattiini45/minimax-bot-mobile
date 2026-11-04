import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fixture, put, repo } from './build-hardening-fixtures.mjs';

const require = createRequire(import.meta.url);
const metroResolve = require('metro-resolver').resolve;
const config = require(join(repo, 'apps/app/metro.config.js'));

// Metro's real resolver needs filesystem/package callbacks normally supplied by
// its file map. These read the fixture or installed graph directly; resolution
// itself is not mocked, and no dependencies are installed by these tests.
function context(originModulePath, nodeModulesPaths = config.resolver.nodeModulesPaths) {
  function getPackage(path) {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }
  function getPackageForModule(path) {
    let directory = dirname(path);
    while (true) {
      const packageJson = getPackage(join(directory, 'package.json'));
      if (packageJson) return { rootPath: directory, packageJson, packageRelativePath: relative(directory, path) };
      if (directory === dirname(directory) || directory.endsWith('/node_modules') || directory.endsWith('\\node_modules')) return null;
      directory = dirname(directory);
    }
  }
  return {
    ...config.resolver,
    allowHaste: false,
    assetExts: new Set(config.resolver.assetExts),
    customResolverOptions: {},
    dev: false,
    doesFileExist: (path) => existsSync(path) && statSync(path).isFile(),
    fileSystemLookup(path) {
      if (!existsSync(path)) return { exists: false };
      return { exists: true, type: statSync(path).isDirectory() ? 'd' : 'f', realPath: realpathSync(path) };
    },
    getPackage,
    getPackageForModule,
    mainFields: config.resolver.resolverMainFields,
    nodeModulesPaths,
    originModulePath,
    preferNativePlatform: true,
    redirectModulePath: (path) => path,
    resolveAsset: () => null,
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    unstable_logWarning: (warning) => { throw new Error(warning); },
  };
}

function nestedVersions() {
  const root = fixture('metro-nested');
  const consumer = join(root, 'node_modules/consumer');
  put(join(root, 'package.json'), JSON.stringify({ private: true, dependencies: { semver: '^6.3.1', consumer: '1.0.0' } }));
  put(join(root, 'node_modules/semver/package.json'), JSON.stringify({ name: 'semver', version: '6.3.1', main: 'index.js' }));
  put(join(root, 'node_modules/semver/index.js'), 'module.exports = "root-semver-6";');
  put(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', dependencies: { semver: '^7.8.0' } }));
  put(join(consumer, 'index.js'), 'require("semver/functions/satisfies");');
  const nested = join(consumer, 'node_modules/semver');
  put(join(nested, 'package.json'), JSON.stringify({ name: 'semver', version: '7.8.0', main: 'index.js' }));
  put(join(nested, 'index.js'), 'module.exports = "nested-semver-7";');
  put(join(nested, 'functions/satisfies.js'), 'module.exports = () => true;');
  return { root, consumer, nested };
}

test('Metro resolves a dependency-owned semver 7 subpath despite root semver 6', () => {
  const { root, consumer, nested } = nestedVersions();
  const paths = [join(root, 'apps/app/node_modules'), join(root, 'node_modules')];
  const result = metroResolve(context(join(consumer, 'index.js'), paths), 'semver/functions/satisfies', 'android');
  assert.equal(result.type, 'sourceFile');
  assert.equal(result.filePath, realpathSync(join(nested, 'functions/satisfies.js')));
});

test('Metro chooses package-owned versions without changing the root version', () => {
  const { root, consumer, nested } = nestedVersions();
  const paths = [join(root, 'apps/app/node_modules'), join(root, 'node_modules')];
  assert.equal(metroResolve(context(join(consumer, 'index.js'), paths), 'semver', 'android').filePath, realpathSync(join(nested, 'index.js')));
  assert.equal(metroResolve(context(join(root, 'apps/app/index.js'), paths), 'semver', 'android').filePath, realpathSync(join(root, 'node_modules/semver/index.js')));
});

test('normal app/workspace imports retain shared React/RN identity and workspace visibility', () => {
  assert.ok(config.watchFolders.includes(repo));
  assert.deepEqual(config.resolver.nodeModulesPaths, [resolve(repo, 'apps/app/node_modules'), resolve(repo, 'node_modules')]);
  const app = context(join(repo, 'apps/app/metro.config.js'));
  const workspace = context(join(repo, 'packages/protocol/src/index.ts'));
  for (const platform of ['android', 'ios', 'web']) {
    for (const name of ['react', 'react/jsx-runtime', 'react-native']) {
      const fromApp = metroResolve(app, name, platform);
      const fromWorkspace = metroResolve(workspace, name, platform);
      assert.equal(fromApp.type, 'sourceFile');
      assert.equal(fromApp.filePath, fromWorkspace.filePath, `${name} (${platform})`);
      assert.equal(fromApp.filePath, realpathSync(require.resolve(name, { paths: [join(repo, 'apps/app')] })), name);
    }
  }
});
