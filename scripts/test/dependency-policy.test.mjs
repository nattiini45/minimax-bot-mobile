import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { assessDependencies, parseAuditResult } from '../check-dependencies.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(repo, 'scripts/check-dependencies.mjs');
const url = 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4';
const severities = ['info', 'low', 'moderate', 'high', 'critical'];
const clone = (value) => structuredClone(value);
const advisory = (overrides = {}) => ({ source: 1243505, name: 'deepmerge', dependency: 'deepmerge', title: 'Prototype poisoning', url, severity: 'low', range: '>=4.2.0 <=4.3.1', ...overrides });
const record = (name, via, nodes = [`node_modules/${name}`]) => ({ name, severity: 'low', isDirect: false, via, effects: [], range: '*', nodes, fixAvailable: false });
function report(vulnerabilities = {}) {
  const counts = Object.fromEntries(severities.map((severity) => [severity, Object.values(vulnerabilities).filter((entry) => entry.severity === severity).length]));
  return { auditReportVersion: 2, vulnerabilities, metadata: { vulnerabilities: { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) } } };
}
function fixture() {
  const full = report({
    deepmerge: record('deepmerge', [advisory()]),
    'jest-config': record('jest-config', ['deepmerge'], ['node_modules/jest/node_modules/jest-config']),
    '@jest/core': record('@jest/core', ['jest-config'], ['node_modules/jest/node_modules/@jest/core']),
    'jest-cli': record('jest-cli', ['@jest/core', 'jest-config'], ['node_modules/jest/node_modules/jest-cli']),
    jest: record('jest', ['@jest/core', 'jest-cli']),
    'jest-watch-typeahead': record('jest-watch-typeahead', ['jest']),
    'jest-expo': record('jest-expo', ['jest', 'jest-watch-typeahead']),
  });
  const packages = {
    '': { workspaces: ['apps/app'] },
    'apps/app': { name: '@minimax-bot/app', version: '0.1.0', devDependencies: { jest: '~30.5.2', 'jest-expo': '~58.0.14' } },
  };
  const declarations = {
    deepmerge: {},
    'jest-config': { dependencies: { deepmerge: '^4.3.1' } },
    '@jest/core': { dependencies: { 'jest-config': '30.5.2' } },
    'jest-cli': { dependencies: { '@jest/core': '30.5.2', 'jest-config': '30.5.2' } },
    jest: { dependencies: { '@jest/core': '30.5.2', 'jest-cli': '30.5.2' } },
    'jest-watch-typeahead': { peerDependencies: { jest: '^30.0.0' } },
    'jest-expo': { dependencies: { 'jest-watch-typeahead': '^3.0.1' }, peerDependencies: { jest: '^29.0.0 || ^30.0.0' } },
  };
  for (const [name, entry] of Object.entries(full.vulnerabilities)) {
    entry.isDirect = name === 'jest' || name === 'jest-expo';
    for (const node of entry.nodes) packages[node] = { version: name === 'deepmerge' ? '4.3.1' : name === 'jest-expo' ? '58.0.14' : name === 'jest-watch-typeahead' ? '3.0.1' : '30.5.2', dev: true, ...declarations[name] };
  }
  const input = { full, production: report(), lock: { lockfileVersion: 3, packages }, deepmergeVersions: ['4.2.0', '4.3.0', '4.3.1'] };
  refreshReport(input);
  return input;
}
function refreshReport(input) {
  for (const entry of Object.values(input.full.vulnerabilities)) entry.effects = [];
  for (const [name, entry] of Object.entries(input.full.vulnerabilities)) {
    for (const via of entry.via) if (typeof via === 'string' && input.full.vulnerabilities[via]) input.full.vulnerabilities[via].effects.push(name);
  }
  input.full = report(input.full.vulnerabilities);
}
const assess = (input) => assessDependencies(input);
const denied = (input) => {
  const result = assess(input);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.reasons.length > 0);
  return result;
};

test('clean full/production audits and clean locks need no exception or registry metadata', () => {
  const result = assess({ full: report(), production: report(), lock: { lockfileVersion: 3, packages: { '': {} } } });
  assert.equal(result.ok, true);
  assert.equal(result.exceptionUsed, false);
  assert.equal(result.advisoryCount, 0);
});

test('only the exact low dev-only advisory is allowed; seven propagated packages are one advisory', () => {
  const result = assess(fixture());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.exceptionUsed, true);
  assert.equal(result.advisoryCount, 1);
  assert.equal(result.affectedPackages, 7);
});

test('a smaller actual Jest chain is allowed, but a root-only deepmerge report is not', () => {
  const input = fixture();
  for (const name of ['jest-cli', 'jest-watch-typeahead', 'jest-expo']) {
    for (const node of input.full.vulnerabilities[name].nodes) delete input.lock.packages[node];
    delete input.full.vulnerabilities[name];
  }
  input.full.vulnerabilities.jest.via = ['@jest/core'];
  delete input.lock.packages['node_modules/jest'].dependencies['jest-cli'];
  delete input.lock.packages['apps/app'].devDependencies['jest-expo'];
  refreshReport(input);
  assert.equal(assess(input).ok, true);
  assert.equal(assess(input).affectedPackages, 4);
  const leaf = fixture();
  leaf.full = report({ deepmerge: leaf.full.vulnerabilities.deepmerge });
  denied(leaf);
});

test('non-Jest consumers cannot inherit the advisory exception, reported or hidden in the lock', () => {
  for (const reported of [true, false]) {
    const input = fixture();
    input.lock.packages[''].devDependencies = { 'new-build-tool': '1.0.0' };
    input.lock.packages['node_modules/new-build-tool'] = { version: '1.0.0', dev: true, dependencies: { deepmerge: '4.3.1' } };
    if (reported) input.full.vulnerabilities['new-build-tool'] = { ...record('new-build-tool', ['deepmerge']), isDirect: true };
    refreshReport(input);
    denied(input);
  }
});

test('only app dev Jest entrypoints may consume the affected chain, not direct leaves or name-only impostors', () => {
  for (const location of ['', 'apps/app']) {
    for (const name of ['deepmerge', 'jest-config', '@jest/core']) {
      const input = fixture();
      input.lock.packages[location].devDependencies = { ...input.lock.packages[location].devDependencies, [name]: name === 'deepmerge' ? '4.3.1' : '30.5.2' };
      denied(input);
    }
  }
  const noRoot = fixture();
  delete noRoot.lock.packages['apps/app'].devDependencies;
  denied(noRoot);
  const noWorkspace = fixture();
  delete noWorkspace.lock.packages[''].workspaces;
  denied(noWorkspace);
  const wrongUsage = fixture();
  wrongUsage.lock.packages['node_modules/jest'].dependencies.deepmerge = '4.3.1';
  wrongUsage.full.vulnerabilities.jest.via.push('deepmerge');
  refreshReport(wrongUsage);
  denied(wrongUsage);
});

test('report and dependency ranges must parse and match the affected installed versions', () => {
  for (const range of ['not-a-semver-range', '>=99.0.0', '<30.0.0', '1.2.3 || definitely-not-a-range']) {
    const input = fixture();
    input.full.vulnerabilities.jest.range = range;
    denied(input);
  }
  for (const range of ['not-a-semver-range', '^31.0.0']) {
    const input = fixture();
    input.lock.packages['node_modules/jest'].dependencies['@jest/core'] = range;
    denied(input);
  }
  for (const rootRange of [false, 'not-a-semver-range']) {
    const input = fixture();
    input.full.vulnerabilities.deepmerge.via[0].range = rootRange;
    assert.throws(() => parseAuditResult({ status: 1, stdout: JSON.stringify(input.full) }));
  }
  const valid = fixture();
  valid.full.vulnerabilities.jest.range = '^30.0.0 || >=31.0.0 <32';
  assert.equal(assess(valid).ok, true);
});

test('the guard resolves hoisted and nested lock nodes instead of trusting package-name edges', () => {
  const hoisted = fixture();
  for (const name of ['@jest/core', 'jest-cli', 'jest-config']) {
    const old = hoisted.full.vulnerabilities[name].nodes[0];
    const node = `node_modules/${name}`;
    hoisted.lock.packages[node] = hoisted.lock.packages[old];
    delete hoisted.lock.packages[old];
    hoisted.full.vulnerabilities[name].nodes = [node];
  }
  assert.equal(assess(hoisted).ok, true);
  const nested = fixture();
  const node = 'node_modules/jest/node_modules/jest-config/node_modules/deepmerge';
  nested.lock.packages[node] = nested.lock.packages['node_modules/deepmerge'];
  delete nested.lock.packages['node_modules/deepmerge'];
  nested.full.vulnerabilities.deepmerge.nodes = [node];
  assert.equal(assess(nested).ok, true);
  const shadow = fixture();
  shadow.lock.packages[node] = { version: '4.3.1', dev: true };
  denied(shadow);
});

test('missing, fabricated, wrong-kind, aliased and mismatched causal edges fail closed', () => {
  const changes = [
    (x) => { delete x.lock.packages['node_modules/jest/node_modules/jest-config'].dependencies.deepmerge; },
    (x) => { x.lock.packages['node_modules/jest/node_modules/jest-config'].optionalDependencies = { deepmerge: '^4.3.1' }; delete x.lock.packages['node_modules/jest/node_modules/jest-config'].dependencies; },
    (x) => { x.lock.packages['node_modules/jest/node_modules/@jest/core'].dependencies['jest-config'] = '31.0.0'; },
    (x) => { x.full.vulnerabilities.jest.effects = []; },
    (x) => { x.full.vulnerabilities.jest.isDirect = false; },
    (x) => { x.lock.packages['apps/app'].devDependencies.merge = 'npm:deepmerge@4.3.1'; x.lock.packages['apps/app/node_modules/merge'] = { name: 'deepmerge', version: '4.3.1', dev: true }; },
    (x) => { x.lock.packages['apps/app'].devDependencies.merge = 'file:../../node_modules/deepmerge'; x.lock.packages['node_modules/merge'] = { link: true, resolved: 'node_modules/deepmerge' }; },
    (x) => { x.lock.packages['node_modules/jest'].dependencies['jest-cli'] = { bad: 'range' }; },
  ];
  for (const change of changes) { const input = fixture(); change(input); denied(input); }
});

test('the exact npm incompatible rollback suggestions require independent no-new-leaf-release evidence', () => {
  const input = fixture();
  for (const [name, entry] of Object.entries(input.full.vulnerabilities)) {
    entry.fixAvailable = name.startsWith('jest-expo') || name === 'jest-watch-typeahead'
      ? { name: 'jest-expo', version: '58.0.6', isSemVerMajor: true }
      : { name: 'jest', version: '25.1.0', isSemVerMajor: true };
  }
  assert.equal(assess(input).ok, true);
  for (const fix of [true, { name: 'deepmerge', version: '4.3.2', isSemVerMajor: false }, { name: 'jest', version: '30.6.0', isSemVerMajor: false }]) {
    const changed = clone(input);
    changed.full.vulnerabilities.deepmerge.fixAvailable = fix;
    denied(changed);
  }
  const patched = clone(input);
  patched.deepmergeVersions.push('4.3.2');
  denied(patched);
});

test('any unknown low/moderate advisory, additional root, or worsened known severity fails', () => {
  for (const severity of ['low', 'moderate']) {
    const input = fixture();
    input.full.vulnerabilities.newcomer = { ...record('newcomer', [advisory({ name: 'newcomer', dependency: 'newcomer', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity })]), severity };
    input.lock.packages['node_modules/newcomer'] = { version: '1.0.0', dev: true };
    input.full = report(input.full.vulnerabilities);
    denied(input);
  }
  for (const severity of ['moderate', 'high', 'critical']) {
    const input = fixture();
    input.full.vulnerabilities.deepmerge.severity = severity;
    input.full.vulnerabilities.deepmerge.via[0].severity = severity;
    input.full = report(input.full.vulnerabilities);
    denied(input);
  }
  const second = fixture();
  second.full.vulnerabilities.deepmerge.via.push(advisory({ source: 999, url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }));
  denied(second);
});

test('runtime or incompletely classified nodes cannot use the exception, including hidden duplicate lock nodes', () => {
  for (const name of ['deepmerge', 'jest', 'jest-config']) {
    for (const classification of [{ dev: false }, {}, { dev: true, devOptional: true }]) {
      const input = fixture();
      input.lock.packages[input.full.vulnerabilities[name].nodes[0]] = { version: name === 'deepmerge' ? '4.3.1' : '30.5.2', ...classification };
      denied(input);
    }
  }
  const duplicate = fixture();
  duplicate.lock.packages['apps/app/node_modules/deepmerge'] = { version: '4.3.1' };
  denied(duplicate);
  for (const version of ['4.2.0', '4.3.0', '4.3.1']) {
    const hidden = fixture();
    hidden.lock.packages['apps/app/node_modules/deepmerge'] = { version, dev: version !== '4.3.1' };
    denied(hidden);
  }
  const wrongVersion = fixture();
  wrongVersion.lock.packages['node_modules/deepmerge'].version = '4.2.0';
  denied(wrongVersion);
});

test('any production finding fails even for the known advisory; metadata cannot conceal missing records', () => {
  const input = fixture();
  input.production = clone(input.full);
  denied(input);
  const missing = fixture();
  missing.production.metadata.vulnerabilities.low = 1;
  missing.production.metadata.vulnerabilities.total = 1;
  denied(missing);
});

test('missing nodes, via entries, schema fields, registry metadata, and error reports fail closed', () => {
  const mutations = [
    (x) => { delete x.lock.packages['node_modules/deepmerge']; },
    (x) => { delete x.lock.packages; },
    (x) => { x.lock.lockfileVersion = 1; },
    (x) => { delete x.full.vulnerabilities.deepmerge.via; },
    (x) => { x.full.vulnerabilities.deepmerge.via = []; },
    (x) => { x.full.vulnerabilities.jest.via.push('missing-record'); },
    (x) => { x.full.vulnerabilities.deepmerge.nodes = []; },
    (x) => { x.full.vulnerabilities.deepmerge.nodes = ['../node_modules/deepmerge']; },
    (x) => { delete x.full.vulnerabilities.deepmerge.fixAvailable; },
    (x) => { delete x.full.vulnerabilities.deepmerge.via[0].url; },
    (x) => { x.full.vulnerabilities.deepmerge.via[0].dependency = 'other'; },
    (x) => { x.full.auditReportVersion = 1; },
    (x) => { x.full.error = { code: 'ENETWORK', summary: 'sensitive-error' }; },
    (x) => { x.full.metadata.vulnerabilities.total = 0; },
    (x) => { x.full.metadata.vulnerabilities.low = 0; },
    (x) => { delete x.full.metadata.vulnerabilities.critical; },
    (x) => { x.full.vulnerabilities = []; },
    (x) => { x.full = null; },
    (x) => { x.production = {}; },
    (x) => { delete x.deepmergeVersions; },
    (x) => { x.deepmergeVersions = []; },
    (x) => { x.deepmergeVersions = ['not-a-version']; },
    (x) => { x.deepmergeVersions.push('4.3.1-..'); },
    (x) => { x.deepmergeVersions.push('4.3.1-00'); },
    (x) => { x.deepmergeVersions.push('5.0.0'); },
  ];
  for (const mutate of mutations) { const input = fixture(); mutate(input); denied(input); }
});

test('advisory cycles cannot invent or hide resolved Jest-chain edges', () => {
  const rootedCycle = fixture();
  rootedCycle.full.vulnerabilities['@jest/core'].via.push('jest');
  rootedCycle.full.vulnerabilities['jest-config'].via.push('jest-cli');
  // Even an advisory-rooted cycle fails if its claimed edges are not real policy-chain dependencies.
  denied(rootedCycle);
  const unrooted = fixture();
  unrooted.full.vulnerabilities['jest-config'].via = ['jest-cli'];
  denied(unrooted);
  const cycleOnly = fixture();
  cycleOnly.full = report({ jest: record('jest', ['jest-cli']), 'jest-cli': record('jest-cli', ['jest']) });
  denied(cycleOnly);
  const unknown = fixture();
  unknown.full.vulnerabilities['@jest/core'].via.push('jest');
  unknown.full.vulnerabilities['jest-cli'].via.push(advisory({ name: 'jest-cli', dependency: 'jest-cli', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }));
  denied(unknown);
});

test('audit process status 1 means parse findings, not success; failures never echo raw process data', () => {
  assert.deepEqual(parseAuditResult({ status: 0, stdout: JSON.stringify(report()) }), report());
  assert.deepEqual(parseAuditResult({ status: 1, stdout: JSON.stringify(fixture().full) }), fixture().full);
  for (const result of [
    { status: 2, stdout: JSON.stringify(report()) },
    { status: 0, stdout: 'sensitive-not-json' },
    { status: 0, stdout: JSON.stringify({ error: { code: 'E401', summary: 'sensitive-token' } }) },
    { status: 0, stdout: JSON.stringify(fixture().full) },
    { status: 1, stdout: JSON.stringify(report()) },
    { status: null, signal: 'SIGTERM', stdout: '{}' },
    { status: 0, error: new Error('sensitive-network-error'), stdout: JSON.stringify(report()) },
  ]) {
    assert.throws(() => parseAuditResult(result), (error) => !/sensitive/.test(error.message));
  }
});

function cliFixture(mode) {
  const base = join(repo, '.audit-local/fix-security-gates');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'cli-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  const input = fixture();
  writeFileSync(join(root, 'scripts/check-dependencies.mjs'), readFileSync(script));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'dependency-policy-fixture', packageManager: 'npm@12.2.1' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(input.lock));
  mkdirSync(join(root, 'fake-npm/bin'), { recursive: true });
  writeFileSync(join(root, 'fake-npm/package.json'), JSON.stringify({ name: 'npm', version: '12.2.1' }));
  const cli = join(root, 'fake-npm/bin/npm-cli.js');
  // A local process fixture at the real npm_execpath boundary, not a production bypass flag.
  writeFileSync(cli, `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log(${JSON.stringify(mode === 'wrong-version' ? '11.19.1' : '12.2.1')}); process.exit(0); }
console.error('sensitive-raw-stderr');
if (${JSON.stringify(mode)} === 'process2') { console.log(${JSON.stringify(JSON.stringify(report()))}); process.exit(2); }
if (${JSON.stringify(mode)} === 'non-json') { console.log('sensitive-raw-json'); process.exit(0); }
if (${JSON.stringify(mode)} === 'network') { console.log(JSON.stringify({ error: { code: 'ENETWORK', summary: 'sensitive-network' } })); process.exit(1); }
if (args[0] === 'view') {
  if (${JSON.stringify(mode)} === 'release-process2') { console.log('[]'); process.exit(2); }
  if (${JSON.stringify(mode)} === 'release-non-json') { console.log('sensitive-release-error'); process.exit(0); }
  console.log(${JSON.stringify(JSON.stringify(mode === 'patched' ? [...input.deepmergeVersions, '4.3.2'] : input.deepmergeVersions))}); process.exit(0);
}
const production = args.includes('--omit=dev');
const clean = production || ${JSON.stringify(mode)} === 'clean';
console.log(clean ? ${JSON.stringify(JSON.stringify(report()))} : ${JSON.stringify(JSON.stringify(input.full))});
process.exit(clean ? 0 : 1);
`);
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-dependencies.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, npm_execpath: cli, npm_config_include: 'dev', npm_config_omit: 'dev', npm_config_audit_level: 'critical' },
  });
  return { root, ...result, output: `${result.stdout}${result.stderr}` };
}

test('CLI runs separate full/production audits through pinned npm and uses bounded output', () => {
  for (const mode of ['clean', 'allowed']) {
    const result = cliFixture(mode);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /sensitive/);
    const calls = readFileSync(join(result.root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const audits = calls.filter((args) => args[0] === 'audit');
    assert.equal(audits.length, 2);
    assert.ok(audits.some((args) => args.includes('--include=dev') && !args.includes('--omit=dev')));
    assert.ok(audits.some((args) => args.includes('--omit=dev') && !args.includes('--include=dev')));
    assert.ok(audits.every((args) => args.includes('--package-lock-only') && args.includes('--audit-level=info')));
    assert.match(result.output, mode === 'clean' ? /no exception used/i : /1 advisory.*7 affected packages/i);
  }
});

test('CLI fails closed on bad process, malformed JSON, network errors, new releases and wrong npm version', () => {
  for (const mode of ['process2', 'non-json', 'network', 'patched', 'wrong-version', 'release-process2', 'release-non-json']) {
    const result = cliFixture(mode);
    assert.equal(result.status, 1, `${mode}: ${result.output}`);
    assert.doesNotMatch(result.output, /sensitive/);
    assert.ok(result.output.length < 3000);
  }
});

test('CLI help is offline and unknown options cannot bypass policy', () => {
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { ...process.env, npm_execpath: '' } });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /npm run audit:dependencies/);
  const unknown = spawnSync(process.execPath, [script, '--allow-production'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
});
