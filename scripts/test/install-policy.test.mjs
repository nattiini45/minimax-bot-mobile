import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixture, npm, put, repo } from './build-hardening-fixtures.mjs';

const metadata = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const config = () => existsSync(join(repo, '.npmrc')) ? readFileSync(join(repo, '.npmrc'), 'utf8') : '';

test('project npm configuration is strict and contains no credentials or registry overrides', () => {
  const lines = config().split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#'));
  assert.ok(lines.includes('strict-allow-scripts=true'));
  assert.ok(lines.includes('engine-strict=true'));
  assert.ok(lines.every((line) => /^(strict-allow-scripts|engine-strict)=true$/.test(line)));
  assert.equal(metadata.packageManager, 'npm@12.2.1');
  assert.equal(metadata.devEngines.packageManager.version, '12.2.1');
});

test('the current workspace lock passes an offline strict npm ci dry-run without being rewritten', () => {
  const base = fixture('locked-install');
  put(join(base, 'package.json'), readFileSync(join(repo, 'package.json'), 'utf8'));
  put(join(base, 'package-lock.json'), readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  put(join(base, '.npmrc'), config());
  for (const workspace of metadata.workspaces) {
    put(join(base, workspace, 'package.json'), readFileSync(join(repo, workspace, 'package.json'), 'utf8'));
  }
  const before = readFileSync(join(base, 'package-lock.json'), 'utf8');
  const result = npm(['ci', '--dry-run', '--offline', '--no-audit', '--no-fund', '--cache', join(base, 'cache')], { cwd: base });
  assert.equal(result.status, 0, result.output);
  assert.equal(readFileSync(join(base, 'package-lock.json'), 'utf8'), before);
  assert.equal(existsSync(join(base, 'node_modules')), false);
});

test('an unlisted harmless postinstall fails closed; an explicitly allowed hook executes under npm ci', () => {
  assert.equal(npm(['--version']).stdout.trim(), '12.2.1');
  const base = fixture('install');
  const dep = join(base, 'dependency');
  put(join(dep, 'package.json'), JSON.stringify({
    name: 'policy-fixture-hook', version: '1.0.0',
    scripts: { postinstall: 'node hook.cjs' },
  }));
  put(join(dep, 'hook.cjs'), "require('node:fs').writeFileSync('hook-ran', 'harmless');\n");
  const pack = npm(['pack', '--ignore-scripts', '--offline', '--cache', join(base, 'cache')], { cwd: dep });
  assert.equal(pack.status, 0, pack.output);
  for (const allowed of [false, true]) {
    const consumer = join(base, allowed ? 'allowed' : 'unlisted');
    put(join(consumer, '.npmrc'), config());
    put(join(consumer, 'package.json'), JSON.stringify({
      name: 'policy-fixture', private: true, version: '1.0.0',
      dependencies: { 'policy-fixture-hook': 'file:../dependency/policy-fixture-hook-1.0.0.tgz' },
      // npm 12 matches local tarballs by exact source, not their self-reported name/version.
      allowScripts: { ...metadata.allowScripts, ...(allowed ? { 'file:../dependency/policy-fixture-hook-1.0.0.tgz': true } : {}) },
    }));
    const lock = npm(['install', '--package-lock-only', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--cache', join(base, 'cache')], { cwd: consumer });
    assert.equal(lock.status, 0, lock.output);
    const before = readFileSync(join(consumer, 'package-lock.json'), 'utf8');
    const install = npm(['ci', '--offline', '--no-audit', '--no-fund', '--cache', join(base, 'cache')], { cwd: consumer });
    assert.equal(install.status === 0, allowed, install.output);
    assert.equal(existsSync(join(consumer, 'node_modules/policy-fixture-hook/hook-ran')), allowed, install.output);
    assert.equal(readFileSync(join(consumer, 'package-lock.json'), 'utf8'), before);
    if (!allowed) assert.match(install.output, /script/i);
  }
});
