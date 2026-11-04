import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { bash, fixture, linuxPath, put, repo } from './build-hardening-fixtures.mjs';

// Both packages are already locked by the existing test toolchain; no install is needed.
const require = createRequire(import.meta.url);
const { load } = require('js-yaml');
const semver = require('semver');
const workflow = () => load(readFileSync(join(repo, '.github/workflows/build.yml'), 'utf8'));

test('Node support is the npm/Expo intersection, including floors and excluding Node 25', () => {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const locked = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8'));
  assert.equal(locked.packages[''].engines.node, pkg.engines.node);
  for (const version of ['22.22.2', '24.15.0', '24.22.1', '26.0.0', '27.0.0']) assert.ok(semver.satisfies(version, pkg.engines.node), version);
  for (const version of ['22.22.1', '23.9.0', '24.14.9', '25.0.0', '25.9.0']) assert.ok(!semver.satisfies(version, pkg.engines.node), version);
});

test('workflow parses, pins every action, and limits token permissions and automatic work to product checks', () => {
  const w = workflow();
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.ok(w.on.push && w.on.pull_request && w.on.workflow_dispatch);
  assert.equal(w.on.workflow_dispatch.inputs.signed_android.type, 'boolean');
  assert.equal(w.on.workflow_dispatch.inputs.signed_android.default, false);
  for (const job of Object.values(w.jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    }
  }
  const verify = JSON.stringify(w.jobs.test);
  assert.doesNotMatch(verify, /secrets\.|check-submission|docs\/|marketing|probe|nattiini45/);
  for (const command of ['npm ci', 'npm run typecheck', 'npm run test:policy', 'npm run export:web']) assert.ok(verify.includes(command), command);
  for (const job of Object.values(w.jobs)) {
    const scripts = job.steps.map((step) => step.run || '').join('\n');
    assert.match(scripts, /npm@12\.2\.1/);
    assert.match(scripts, /npm --version/);
    assert.doesNotMatch(scripts, /npm install -g|npm publish|gh release|wrangler deploy/);
  }
  const dependabot = load(readFileSync(join(repo, '.github/dependabot.yml'), 'utf8'));
  assert.ok(dependabot.updates.some((update) => update['package-ecosystem'] === 'github-actions' && update.directory === '/' && update.schedule.interval === 'weekly'));
});

test('pre-bootstrap setup-node skips both explicit and automatic npm caching before pinned tooling reaches PATH', () => {
  const q = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const tempRoot = join(repo, '.audit-local/fix-security-gates');
  mkdirSync(tempRoot, { recursive: true });
  for (const [name, job] of Object.entries(workflow().jobs)) {
    const bootstrapIndex = job.steps.findIndex((step) => step.name === 'install the declared npm');
    const setupIndex = job.steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    assert.ok(setupIndex >= 0 && bootstrapIndex > setupIndex);
    const bootstrap = job.steps[bootstrapIndex];
    const verify = job.steps[bootstrapIndex + 1];
    assert.equal(bootstrap['working-directory'], '${{ runner.temp }}');
    assert.match(bootstrap.run, /npm install --prefix "\$RUNNER_TEMP\/project-npm".*npm@12\.2\.1/);
    assert.match(bootstrap.run, /echo "\$RUNNER_TEMP\/project-npm\/node_modules\/\.bin" >> "\$GITHUB_PATH"/);
    assert.match(verify.run, /test "\$\(npm --version\)" = 12\.2\.1/);
    assert.doesNotMatch(job.steps.slice(0, bootstrapIndex).map((step) => step.run || '').join('\n'), /\bnpm\b/);
    const base = mkdtempSync(join(tempRoot, `cache-bootstrap-${name}-`));
    const checkout = join(base, 'checkout');
    const runner = join(base, 'runner-temp');
    mkdirSync(runner);
    put(join(checkout, 'package.json'), readFileSync(join(repo, 'package.json'), 'utf8'));
    const pinned = join(base, 'pinned-npm');
    put(pinned, `#!/bin/bash\nset -eu\nprintf 'pinned|%s|%s\\n' "$PWD" "$*" >> "$FIXTURE_NPM_LOG"\ncase "$*" in\n  --version) echo 12.2.1;;\n  'config get cache') echo "$RUNNER_TEMP/cache";;\n  ci) echo fixture-locked-ci;;\n  *) exit 92;;\nesac\n`);
    put(join(base, 'old-bin/npm'), `#!/bin/bash\nset -eu\nprintf 'old|%s|%s\\n' "$PWD" "$*" >> "$FIXTURE_NPM_LOG"\ncase "$*" in\n  'config get cache') echo 'EBADDEVENGINES: npm 11 cannot query this npm 12 checkout' >&2; exit 1;;\n  install*)\n    test "$PWD" = "$RUNNER_TEMP"\n    mkdir -p "$RUNNER_TEMP/project-npm/node_modules/.bin"\n    cp ${q(linuxPath(pinned))} "$RUNNER_TEMP/project-npm/node_modules/.bin/npm";;\n  *) exit 93;;\nesac\n`);
    function exercise(label, settings) {
      const log = join(base, `${label}.log`);
      const launch = join(base, `${label}.sh`);
      // Model the pinned action's main.ts decision and cache-utils.ts command.
      // Explicit cache wins even when auto-cache is false; omitted auto-cache
      // defaults true and discovers npm from this checkout's packageManager.
      const cache = settings.cache || (settings['package-manager-cache'] !== false ? 'npm' : '');
      put(launch, `#!/bin/bash\nset -eu\nexport RUNNER_TEMP=${q(linuxPath(runner))}\nexport GITHUB_PATH=${q(linuxPath(join(base, `${label}.path`)))}\nexport FIXTURE_NPM_LOG=${q(linuxPath(log))}\nexport PATH=${q(linuxPath(join(base, 'old-bin')))}:$PATH\ncd ${q(linuxPath(checkout))}\n${cache ? 'npm config get cache\n' : ''}cd "$RUNNER_TEMP"\n${bootstrap.run}\nwhile IFS= read -r entry; do export PATH="$entry:$PATH"; done < "$GITHUB_PATH"\ncd ${q(linuxPath(checkout))}\n${verify.run}\nnpm config get cache\n`);
      const result = bash(launch);
      return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n') };
    }
    for (const [label, settings] of [['explicit-cache', { cache: 'npm', 'package-manager-cache': false }], ['implicit-cache', {}]]) {
      const control = exercise(label, settings);
      assert.notEqual(control.status, 0, control.output);
      assert.match(control.output, /EBADDEVENGINES/);
      assert.equal(control.calls.length, 1);
      assert.equal(control.calls[0], `old|${linuxPath(checkout)}|config get cache`);
    }
    const fixed = exercise('workflow', job.steps[setupIndex].with);
    assert.equal(fixed.status, 0, fixed.output);
    assert.equal(fixed.calls.filter((call) => call.startsWith('old|')).length, 1);
    assert.match(fixed.calls[0], /\|install --prefix .*npm@12\.2\.1$/);
    assert.ok(fixed.calls[0].startsWith(`old|${linuxPath(runner)}|`));
    assert.equal(fixed.calls[1], `pinned|${linuxPath(checkout)}|--version`);
    assert.equal(fixed.calls.at(-1), `pinned|${linuxPath(checkout)}|config get cache`);
    if (name === 'test') assert.ok(fixed.calls.includes(`pinned|${linuxPath(checkout)}|ci`));
    for (const step of job.steps.slice(0, bootstrapIndex)) {
      if (!step.uses?.startsWith('actions/setup-node@')) continue;
      assert.equal(step.with['package-manager-cache'], false);
      assert.equal(step.with.cache, undefined);
    }
  }
});

test('CI covers shared protocol and relay units and gates both dependency audits after the locked install', () => {
  const steps = workflow().jobs.test.steps;
  const unit = steps.find((step) => step.name === 'unit tests');
  assert.equal(unit.run, 'npm run test:unit -- packages/protocol packages/relay scripts/test/network-security-config.test.ts');
  assert.doesNotMatch(unit.run, /submission-counts/);
  const install = steps.findIndex((step) => /npm ci/.test(step.run || ''));
  const audit = steps.findIndex((step) => step.run === 'npm run audit:dependencies');
  assert.ok(install >= 0 && audit === install + 1, 'dependency policy must immediately follow the locked install');
  assert.equal(steps[audit]['continue-on-error'], undefined);
  assert.equal(steps[audit].if, undefined);
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['audit:dependencies'], 'node scripts/check-dependencies.mjs');
  assert.ok(pkg.scripts['test:policy'].includes('scripts/test/dependency-policy.test.mjs'));
  assert.ok(pkg.scripts['test:policy'].includes('scripts/test/onboarding.test.mjs'));
});

test('ordinary push/PR and default dispatch never schedule signing; explicit dispatch fails closed without settings', () => {
  const w = workflow();
  const expression = w.jobs.android.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
  // Evaluate only this deliberately small, whitelisted condition grammar, not arbitrary workflow code.
  assert.equal(expression, "github.event_name == 'workflow_dispatch' && inputs.signed_android == true");
  const eligible = (event, requested) => expression
    .replace('github.event_name', JSON.stringify(event))
    .replace('inputs.signed_android', JSON.stringify(requested));
  for (const [event, requested, expected] of [['push', true, false], ['pull_request', true, false], ['workflow_dispatch', false, false], ['workflow_dispatch', true, true]]) {
    assert.equal(Function(`return (${eligible(event, requested)})`)(), expected);
  }
  const step = w.jobs.android.steps.find((candidate) => candidate.name === 'validate signing settings');
  assert.ok(step);
  const base = fixture('ci-settings');
  const script = join(base, 'validate.sh');
  put(script, step.run);
  const names = Object.keys(step.env);
  const missing = bash(script, [], { env: { ...process.env, ...Object.fromEntries(names.map((name) => [name, ''])) } });
  assert.notEqual(missing.status, 0, missing.output);
  const complete = bash(script, [], { env: { ...process.env, ...Object.fromEntries(names.map((name) => [name, 'fixture-value'])) } });
  assert.equal(complete.status, 0, complete.output);
  assert.doesNotMatch(complete.output, /fixture-value/);
});
