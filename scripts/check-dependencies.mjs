import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const levels = ['info', 'low', 'moderate', 'high', 'critical'];
const advisoryURL = 'https://github.com/advisories/GHSA-gcqx-w48m-w2h4';
const registry = 'https://registry.npmjs.org/';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const packageName = (value) => typeof value === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(value);
const own = (value, key) => Object.hasOwn(value, key);
const validRange = (value) => text(value) && value.trim().length > 0 && semver.validRange(value) !== null;
// Only these causal dependency kinds belong to the current Jest-config chain.
const jestChain = {
  deepmerge: {},
  'jest-config': { dependencies: ['deepmerge'] },
  '@jest/core': { dependencies: ['jest-config'] },
  'jest-cli': { dependencies: ['@jest/core', 'jest-config'] },
  jest: { dependencies: ['@jest/core', 'jest-cli'] },
  'jest-watch-typeahead': { peerDependencies: ['jest'] },
  'jest-expo': { dependencies: ['jest-watch-typeahead'], peerDependencies: ['jest'] },
};
class PolicyError extends Error {}
function need(condition, message) { if (!condition) throw new PolicyError(message); }

function validateReport(report) {
  need(object(report) && !own(report, 'error') && !own(report, 'err'), 'Audit returned an error or invalid report.');
  need(report.auditReportVersion === 2 && object(report.vulnerabilities), 'Expected npm audit v2 vulnerabilities.');
  const counts = report.metadata?.vulnerabilities;
  need(object(counts), 'Audit vulnerability metadata is missing.');
  for (const level of [...levels, 'total']) need(Number.isSafeInteger(counts[level]) && counts[level] >= 0, 'Audit vulnerability counts are invalid.');
  const actual = Object.fromEntries(levels.map((level) => [level, 0]));
  const entries = Object.entries(report.vulnerabilities);
  for (const [name, entry] of entries) {
    need(packageName(name) && object(entry) && entry.name === name && levels.includes(entry.severity), 'Audit vulnerability record is invalid.');
    need(typeof entry.isDirect === 'boolean' && validRange(entry.range) && Array.isArray(entry.effects) && entry.effects.every(packageName), 'Audit vulnerability record is incomplete.');
    need(Array.isArray(entry.nodes) && entry.nodes.length > 0 && entry.nodes.every(text), 'Audit affected nodes are missing.');
    need(Array.isArray(entry.via) && entry.via.length > 0, 'Audit advisory chain is missing.');
    const fix = entry.fixAvailable;
    need(typeof fix === 'boolean' || (object(fix) && packageName(fix.name) && text(fix.version) && semver.valid(fix.version) !== null && typeof fix.isSemVerMajor === 'boolean'), 'Audit fix metadata is missing or invalid.');
    for (const via of entry.via) {
      if (typeof via === 'string') {
        need(packageName(via) && own(report.vulnerabilities, via), 'Audit references a missing advisory-chain record.');
      } else {
        need(object(via) && Number.isSafeInteger(via.source) && via.source > 0 && via.name === name && via.dependency === name
          && text(via.url) && text(via.title) && validRange(via.range) && levels.includes(via.severity), 'Audit advisory root is invalid.');
      }
    }
    actual[entry.severity]++;
  }
  need(counts.total === entries.length && levels.every((level) => counts[level] === actual[level]), 'Audit metadata and affected records disagree.');
  return report;
}

/** Exit 1 carries findings, not a successful policy verdict. Never echo npm output/errors. */
export function parseAuditResult(result) {
  need(object(result) && !result.error && !result.signal && (result.status === 0 || result.status === 1), 'npm audit process failed (execution, network, or registry error).');
  let report;
  try { report = JSON.parse(result.stdout); } catch { throw new PolicyError('npm audit did not return valid JSON.'); }
  validateReport(report);
  need((result.status === 1) === (report.metadata.vulnerabilities.total > 0), 'npm audit exit status and findings disagree.');
  return report;
}

function matchesNode(node, name) {
  return text(node) && !node.includes('\\') && node.split('/').every((part) => part && part !== '.' && part !== '..')
    && (node === `node_modules/${name}` || node.endsWith(`/node_modules/${name}`));
}
function devNode(node) {
  return object(node) && node.dev === true && node.devOptional !== true && node.link !== true && text(node.version) && semver.valid(node.version) !== null;
}

function resolveLockNode(packages, source, name) {
  const parts = source ? source.split('/') : [];
  for (let end = parts.length; end >= 0; end--) {
    if (parts[end - 1] === 'node_modules') continue;
    const prefix = parts.slice(0, end).join('/');
    const candidate = `${prefix ? `${prefix}/` : ''}node_modules/${name}`;
    if (own(packages, candidate)) return candidate;
  }
  return null;
}
function sameNames(actual, expected) {
  return actual.length === new Set(actual).size && actual.length === expected.size && actual.every((name) => expected.has(name));
}

/** Resolve every consumer of an affected installation, including non-audited consumers. */
function validateJestChain(full, packages) {
  need(Array.isArray(packages[''].workspaces) && packages[''].workspaces.includes('apps/app')
    && object(packages['apps/app']) && packages['apps/app'].name === '@minimax-bot/app', 'The exception requires the declared app workspace Jest development entrypoints.');
  const nodes = new Map();
  for (const [name, entry] of Object.entries(full.vulnerabilities)) {
    need(own(jestChain, name), 'An affected package is outside the current Jest-config chain.');
    for (const node of entry.nodes) {
      need(!nodes.has(node), 'Audit lists a duplicate affected lock node.');
      nodes.set(node, name);
    }
    for (const [node, data] of Object.entries(packages)) {
      if (!matchesNode(node, name)) continue;
      need(object(data) && text(data.version) && semver.valid(data.version) !== null, 'A chain lock node has invalid version metadata.');
      if (semver.satisfies(data.version, entry.range)) need(entry.nodes.includes(node), 'Audit omits an affected installation from the lock.');
    }
  }
  const graph = new Map([...nodes.keys()].map((node) => [node, new Set()]));
  const roots = new Set();
  const via = new Map(Object.keys(full.vulnerabilities).map((name) => [name, new Set()]));
  const effects = new Map(Object.keys(full.vulnerabilities).map((name) => [name, new Set()]));
  for (const [source, data] of Object.entries(packages)) {
    need(object(data), 'A package lock record is malformed.');
    if (data.link === true) {
      const target = text(data.resolved) && posix.normalize(data.resolved.replaceAll('\\', '/'));
      need(target && own(packages, target) && !nodes.has(target), 'A linked lock target is missing or aliases an affected chain installation.');
    }
    if (own(jestChain, data.name)) need(matchesNode(source, data.name), 'Aliased chain installations are outside this exception.');
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (!own(data, field)) continue;
      need(object(data[field]), 'Lock dependency declarations are malformed.');
      for (const [name, spec] of Object.entries(data[field])) {
        const alias = typeof spec === 'string' && /^npm:((?:@[^/]+\/)?[^@]+)(?:@|$)/.exec(spec);
        need(!alias || !own(jestChain, alias[1]), 'Aliased chain dependencies are outside this exception.');
        if (!own(jestChain, name)) continue;
        need(validRange(spec), 'A Jest-chain lock dependency range is invalid.');
        const target = resolveLockNode(packages, source, name);
        need(target && object(packages[target]) && text(packages[target].version) && semver.valid(packages[target].version) !== null
          && semver.satisfies(packages[target].version, spec), 'A Jest-chain dependency does not resolve to a matching locked installation.');
        if (!nodes.has(target)) continue;
        if (source === 'apps/app' && field === 'devDependencies' && (name === 'jest' || name === 'jest-expo')) {
          roots.add(target);
          continue;
        }
        const consumer = nodes.get(source);
        need(consumer && jestChain[consumer][field]?.includes(name), 'An affected installation has a consumer outside the exact app-dev Jest-config chain.');
        graph.get(source).add(target);
        via.get(consumer).add(name);
        effects.get(name).add(consumer);
      }
    }
  }
  for (const [name, entry] of Object.entries(full.vulnerabilities)) {
    need(sameNames(entry.via.filter((item) => typeof item === 'string'), via.get(name)) && sameNames(entry.effects, effects.get(name)), 'Audit causal edges do not match the resolved lock graph.');
    need(entry.isDirect === entry.nodes.some((node) => roots.has(node)), 'Audit direct-dependency metadata disagrees with app development entrypoints.');
  }
  const reachable = (starts) => {
    const visited = new Set();
    const pending = [...starts];
    while (pending.length) {
      const node = pending.pop();
      if (visited.has(node)) continue;
      visited.add(node);
      pending.push(...graph.get(node));
    }
    return visited;
  };
  const fromApp = reachable(roots);
  for (const [node] of nodes) {
    need(fromApp.has(node), 'An affected lock node is detached from the app development Jest entrypoints.');
    need([...reachable([node])].some((target) => nodes.get(target) === 'deepmerge'), 'A resolved chain or cycle has no actual deepmerge leaf.');
  }
}

/*
 * The only exception is deepmerge@4.3.1's LOW prototype-poisoning advisory above,
 * used by development-only Jest configuration. No patched leaf release exists.
 * This is not a severity-only or blanket Jest exception: resolved lock edges
 * must stay within the exact app-dev Jest-config chain and agree with audit.
 * Every affected installation must reach this advisory's leaf, remain strictly
 * dev-only, and be reachable from the app's dev Jest entrypoints; production
 * must be empty. A new leaf release requires updating dependencies/reviewing
 * this exception, even if npm's cached advisory has not caught up yet.
 *
 * npm currently labels rollbacks to Jest 25.1.0 / jest-expo 58.0.6 as fixes.
 * They are not compatible fixes for the current Jest 30 / Expo 58 toolchain.
 * Only these exact rollback suggestions are recognized, with live leaf-release
 * evidence and installed newer dev-only targets. Boolean true, a changed fix,
 * severity increase, or any other advisory fails closed.
 */
function noCompatibleFix(fix, packages) {
  if (fix === false) return true;
  if (!object(fix) || fix.isSemVerMajor !== true) return false;
  const rollback = { jest: '25.1.0', 'jest-expo': '58.0.6' };
  if (!own(rollback, fix.name) || rollback[fix.name] !== fix.version) return false;
  const targets = Object.entries(packages).filter(([node]) => matchesNode(node, fix.name));
  return targets.length > 0 && targets.every(([, node]) => devNode(node) && semver.gt(node.version, fix.version));
}

/** Pure assessment of decoded npm reports + authoritative v3 lock, with no IO. */
export function assessDependencies({ full, production, lock, deepmergeVersions } = {}) {
  try {
    validateReport(full);
    validateReport(production);
    need(object(lock) && lock.lockfileVersion === 3 && object(lock.packages) && object(lock.packages['']), 'Expected the authoritative npm v3 package lock.');
    need(Object.keys(production.vulnerabilities).length === 0, 'Production dependencies have vulnerabilities; no exception is permitted.');
    const entries = Object.entries(full.vulnerabilities);
    if (entries.length === 0) return { ok: true, exceptionUsed: false, affectedPackages: 0, advisoryCount: 0, reasons: [] };
    const packages = lock.packages;
    const roots = new Set();
    for (const [name, entry] of entries) {
      need(entry.severity === 'low', 'An affected package exceeds the sole LOW advisory exception.');
      need(noCompatibleFix(entry.fixAvailable, packages), 'A fix is available or the suggested fix is outside the exact known incompatible rollbacks.');
      const versions = new Set();
      for (const node of entry.nodes) {
        need(matchesNode(node, name) && own(packages, node) && devNode(packages[node]), 'An affected lock node is missing or not strictly development-only.');
        need((!own(packages[node], 'name') || packages[node].name === name) && semver.satisfies(packages[node].version, entry.range), 'An affected lock node does not match its reported package and range.');
        if (name === 'deepmerge') need(packages[node].version === '4.3.1', 'The exception is restricted to deepmerge 4.3.1.');
        versions.add(packages[node].version);
      }
      // Also check duplicate reachable installations, not just paths listed by audit.
      for (const [node, data] of Object.entries(packages)) {
        if (!matchesNode(node, name)) continue;
        if (name === 'deepmerge') need(data?.version === '4.3.1' && devNode(data), 'Every deepmerge installation must remain the exact development-only 4.3.1 leaf.');
        else if (versions.has(data?.version)) need(devNode(data), 'Another affected lock installation is not strictly development-only.');
      }
      for (const via of entry.via) {
        if (typeof via === 'string') continue;
        roots.add(via.url);
        need(name === 'deepmerge' && via.name === 'deepmerge' && via.dependency === 'deepmerge'
          && via.url === advisoryURL && via.severity === 'low' && via.range === '>=4.2.0 <=4.3.1', 'An advisory is outside the single exact deepmerge exception.');
      }
    }
    validateJestChain(full, packages);
    need(roots.size === 1 && roots.has(advisoryURL), 'No sole allowed advisory root was established.');
    need(Array.isArray(deepmergeVersions) && deepmergeVersions.length > 0 && deepmergeVersions.includes('4.3.1'), 'Live deepmerge release metadata is missing or invalid.');
    for (const version of deepmergeVersions) {
      need(typeof version === 'string' && semver.valid(version) !== null && !semver.gt(version, '4.3.1'), 'A newer deepmerge release exists or release metadata is invalid; update dependencies/review the exception.');
    }
    return { ok: true, exceptionUsed: true, affectedPackages: entries.length, advisoryCount: roots.size, reasons: [] };
  } catch (error) {
    return { ok: false, exceptionUsed: false, reasons: [error instanceof PolicyError ? error.message : 'Dependency assessment failed on malformed input.'] };
  }
}

function declaredNpm(root, env) {
  let metadata;
  try { metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); } catch { throw new PolicyError('Cannot read the declared package manager.'); }
  const match = /^npm@(\d+\.\d+\.\d+)$/.exec(metadata.packageManager);
  need(match, 'Declare an exact npm packageManager version.');
  const expected = match[1];
  const candidates = env.npm_execpath ? [env.npm_execpath] : (env.PATH || env.Path || '').split(delimiter).flatMap((directory) => directory ? [
    join(directory, 'npm'), join(directory, 'node_modules/npm/bin/npm-cli.js'), join(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ] : []);
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) continue;
      const cli = realpathSync(candidate);
      if (basename(cli) !== 'npm-cli.js') continue;
      const npm = JSON.parse(readFileSync(resolve(dirname(cli), '../package.json'), 'utf8'));
      if (npm.name !== 'npm' || npm.version !== expected) continue;
      const result = spawnSync(process.execPath, [cli, '--version'], { cwd: root, env, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, shell: false, windowsHide: true });
      if (!result.error && !result.signal && result.status === 0 && result.stdout.trim() === expected) return cli;
    } catch { /* Do not print paths, environment, npm stderr, or registry credentials. */ }
  }
  throw new PolicyError('Declared npm is unavailable or mismatched; run npm run audit:dependencies using the pinned project npm.');
}

/** Production runner has no report/exception overrides or test-only environment flags. */
export function runDependencyAudit({ root = projectRoot, env = process.env } = {}) {
  try {
    const cli = declaredNpm(root, env);
    const run = (args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: root, env, encoding: 'utf8', shell: false, windowsHide: true,
      timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    const common = ['--json', '--package-lock-only', '--include=optional', '--include=peer', '--audit-level=info', `--registry=${registry}`, '--offline=false', '--prefer-online=true', '--fetch-retries=1', '--fetch-timeout=30000', '--loglevel=error'];
    const fullResult = run(['audit', ...common, '--include=dev']);
    const productionResult = run(['audit', ...common, '--omit=dev']);
    const full = parseAuditResult(fullResult);
    const production = parseAuditResult(productionResult);
    let lock;
    try { lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')); } catch { throw new PolicyError('Cannot parse the authoritative package lock.'); }
    let deepmergeVersions;
    if (Object.keys(full.vulnerabilities).length > 0) {
      const releases = run(['view', 'deepmerge', 'versions', '--json', `--registry=${registry}`, '--offline=false', '--prefer-online=true', '--fetch-retries=1', '--fetch-timeout=30000', '--loglevel=error']);
      need(!releases.error && !releases.signal && releases.status === 0, 'Cannot verify live deepmerge release metadata.');
      try { deepmergeVersions = JSON.parse(releases.stdout); } catch { throw new PolicyError('Invalid deepmerge release metadata JSON.'); }
    }
    return assessDependencies({ full, production, lock, deepmergeVersions });
  } catch (error) {
    return { ok: false, exceptionUsed: false, reasons: [error instanceof PolicyError ? error.message : 'Dependency audit execution failed.'] };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('Usage: npm run audit:dependencies\nAudits the full locked graph and production separately with the declared npm. Network/registry access is required.');
  } else if (process.argv.length !== 2) {
    console.error('Dependency audit failed: unsupported arguments. Use --help.');
    process.exitCode = 1;
  } else {
    const result = runDependencyAudit();
    if (!result.ok) {
      console.error(`Dependency audit failed: ${result.reasons.join(' ')}`);
      process.exitCode = 1;
    } else if (result.exceptionUsed) {
      console.log(`Dependency audit passed: ${result.advisoryCount} advisory, ${result.affectedPackages} affected packages, strictly dev-only; production clean.\nException used: ${advisoryURL} (LOW, no compatible leaf fix).`);
    } else {
      console.log('Dependency audit passed: full and production clean; no exception used.');
    }
  }
}
