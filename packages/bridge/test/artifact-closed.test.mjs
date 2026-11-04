import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('../../../artifacts/test/bridge-artifact/', import.meta.url));
const BRIDGE = fileURLToPath(new URL('../', import.meta.url));
const PROTOCOL_DIST = fileURLToPath(new URL('../../protocol/dist/', import.meta.url));
// Defaults to the declared dev dependency. An absolute override lets a dependency
// migration verify its isolated compiler before replacing workspace node_modules.
const COMPILER = resolve(process.env.BRIDGE_ARTIFACT_TSC ?? join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'));
const TYPE_ROOTS = dirname(dirname(require.resolve('@types/node/package.json')));

function runNode(args) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_OPTIONS: '' },
  });
}

test('the synced standalone Mini App typechecks without sibling protocol source or workspace tsconfig', async t => {
  await mkdir(ROOT, { recursive: true });
  const fixture = await mkdtemp(join(ROOT, 'closed-'));
  const buildBridge = join(fixture, 'build', 'bridge');
  await mkdir(join(buildBridge, 'scripts'), { recursive: true });
  await cp(join(BRIDGE, 'scripts', 'sync-protocol.mjs'), join(buildBridge, 'scripts', 'sync-protocol.mjs'));
  await cp(join(BRIDGE, 'miniapp'), join(buildBridge, 'miniapp'), { recursive: true });
  await cp(PROTOCOL_DIST, join(fixture, 'build', 'protocol', 'dist'), { recursive: true });
  const sync = runNode([join(buildBridge, 'scripts', 'sync-protocol.mjs')]);
  assert.equal(sync.status, 0, sync.error?.message ?? `${sync.stdout}\n${sync.stderr}`);

  // Only the resulting Mini App enters the standalone package. In particular,
  // neither packages/protocol/src nor the root TypeScript config is copied here.
  const artifact = join(fixture, 'standalone');
  await cp(join(buildBridge, 'miniapp'), join(artifact, 'miniapp'), { recursive: true });
  const config = join(artifact, 'tsconfig.json');
  await writeFile(config, JSON.stringify({
    compilerOptions: {
      allowJs: true, checkJs: true, noEmit: true, module: 'ESNext', moduleResolution: 'Bundler',
      target: 'ES2022', lib: ['ES2022'], types: ['node'], typeRoots: [TYPE_ROOTS],
      strict: false, noImplicitAny: false, noUncheckedIndexedAccess: false,
      noImplicitOverride: false, verbatimModuleSyntax: false, isolatedModules: false,
      declaration: false, declarationMap: false, sourceMap: false, skipLibCheck: false,
    },
    include: ['miniapp/node/**/*.mjs', 'miniapp/node/**/*.d.ts'],
  }, null, 2), 'utf8');
  await assert.rejects(access(join(fixture, 'protocol', 'src')), { code: 'ENOENT' });
  await assert.rejects(access(join(artifact, 'tsconfig.base.json')), { code: 'ENOENT' });
  const version = runNode([COMPILER, '--version']);
  assert.equal(version.status, 0, version.error?.message ?? version.stderr);
  t.diagnostic(`Standalone artifact compiler: ${version.stdout.trim()}`);
  const checked = runNode([COMPILER, '-p', config, '--noEmit']);
  assert.equal(checked.status, 0, checked.error?.message ?? `${checked.stdout}\n${checked.stderr}`);
  await access(join(artifact, 'miniapp', 'node', 'protocol', 'types.d.ts'));
  await access(join(artifact, 'miniapp', 'node', 'protocol', 'index.d.ts'));
});
