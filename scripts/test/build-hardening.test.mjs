import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { bash, fixture, linuxPath, npm, put, repo } from './build-hardening-fixtures.mjs';
import './metro-resolution.test.mjs';

const q = (value) => `'${value.replaceAll("'", "'\\''")}'`;
function setup(mode = 'release') {
  const base = fixture('android');
  const source = join(base, 'source');
  const root = join(base, 'build-root');
  const artifacts = join(base, 'artifacts');
  put(join(source, 'package.json'), '{"packageManager":"npm@12.2.1"}\n');
  put(join(source, 'package-lock.json'), '{"lockfileVersion":3}\n');
  put(join(source, '.gitignore'), 'ignored-local/\n');
  put(join(source, '.npmrc'), readFileSync(join(repo, '.npmrc'), 'utf8'));
  put(join(source, '.git/info/exclude'), 'private-ignore/\n');
  put(join(source, 'apps/app/app/removed-route.tsx'), 'route-v1');
  put(join(source, 'apps/app/package.json'), '{}');
  put(join(source, 'scripts/check-network-security-config.mjs'), readFileSync(join(repo, 'scripts/check-network-security-config.mjs'), 'utf8'));
  for (const name of ['ignored-local/secret', 'private-ignore/secret', '.audit-local/private', '.upstream/private', 'public-ready/private', '.env', '.env.production', '.dev.vars', '.dev.vars.local', 'bridge-token', 'bridge-config.json', 'ledger.json', 'release.jks', 'release.keystore', 'private.pem', 'node_modules/stale', 'apps/app/android/app/build/outputs/apk/release/app-release.apk']) {
    put(join(source, name), 'PRIVATE-FIXTURE');
  }
  put(join(root, 'apps/app/android/app/build/outputs/apk/debug/app-debug.apk'), 'stale-debug');
  put(join(root, 'apps/app/android/app/build/outputs/apk/release/app-release.apk'), 'stale-release');
  put(join(root, 'keep-user-file'), 'never delete');
  put(join(base, 'key/release.keystore'), 'not-a-real-signing-key');
  put(join(base, 'jdk/bin/java'), '#!/bin/sh\necho \'openjdk version "17.0.1"\' >&2\n');
  put(join(base, 'bin/npm'), `#!/bin/sh\ncase "$1" in\n--version) echo 12.2.1;;\nci|install) printf '%s\\n' "$*" > fixture-install-command; printf '%s\\n' "$npm_config_cache" "$GRADLE_USER_HOME" > fixture-caches; env | grep -E '^(EXPO_ANDROID_|STORE_PASSWORD=|KEY_PASSWORD=)' > fixture-signing-env || true;;\nrun) exit 0;;\nexec) python3 ${q(linuxPath(join(base, 'generate.py')))} prebuild;;\n*) echo "unexpected npm: $*" >&2; exit 90;;\nesac\n`);
  put(join(base, 'bin/npx'), `#!/bin/sh\npython3 ${q(linuxPath(join(base, 'generate.py')))} prebuild\n`);
  put(join(base, 'sdk/build-tools/99/apksigner'), `#!/bin/sh\npython3 ${q(linuxPath(join(base, 'generate.py')))} "$@"\n`);
  put(join(base, 'generate.py'), `import os, sys, pathlib, zipfile, json, shutil\nbase = pathlib.Path(__file__).parent\nmode = ${JSON.stringify(mode)}\nif sys.argv[1] == 'prebuild':\n    app = pathlib.Path.cwd()\n    if app.name != 'app': app = app / 'apps/app'\n    android = app / 'android'\n    for variant in ['main', 'debug', 'debugOptimized']:\n        p = android / ('app/src/' + variant + '/res/xml/network_security_config.xml')\n        p.parent.mkdir(parents=True, exist_ok=True)\n        release = '<base-config cleartextTrafficPermitted="false" />'\n        local = '<domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">localhost</domain><domain includeSubdomains="false">127.0.0.1</domain></domain-config>'\n        p.write_text('<network-security-config>' + (release.replace('false', 'true') if variant == 'main' and mode == 'cleartext' else release if variant == 'main' else local + release) + '</network-security-config>')\n    (android / 'app/src/main/AndroidManifest.xml').write_text('<manifest><application android:networkSecurityConfig="@xml/network_security_config" /></manifest>')\n    gradle = android / 'gradlew'\n    gradle.write_text('#!/bin/sh\\npython3 ' + ${JSON.stringify(q(linuxPath(join(base, 'generate.py'))))} + ' assemble\\n')\n    gradle.chmod(0o755)\nelif sys.argv[1] == 'assemble':\n    outputs = pathlib.Path.cwd() / 'app/build/outputs/apk'\n    variants = ['debug/app-debug.apk', 'old/old-release.apk']\n    if mode not in ['missing', 'wrong-name']: variants += ['release/app-release.apk']\n    if mode in ['unexpected', 'wrong-name']: variants += ['release/split-release.apk']\n    for variant in variants:\n        p = outputs / variant\n        p.parent.mkdir(parents=True, exist_ok=True)\n        with zipfile.ZipFile(p, 'w') as z: z.writestr('assets/index.android.bundle', ('https://relay.example' if variant == 'release/app-release.apk' and mode != 'wrong-relay' else 'https://old.example').encode())\nelif sys.argv[1] == 'sign':\n    args = sys.argv[2:]\n    (base / 'sign-argv.json').write_text(json.dumps(args))\n    shutil.copyfile(args[-1], args[args.index('--out') + 1])\n    (base / 'signed-input').write_text(args[-1])\nelif sys.argv[1] == 'verify':\n    print('Signer #1 certificate SHA-256 digest: ' + ('b' if mode == 'wrong-cert' else 'a') * 64)\n    if mode == 'verify-failed':\n        print('FAILED-VERIFICATION', file=sys.stderr)\n        sys.exit(1)\n`);
  const launch = join(base, 'launch.sh');
  function run(extra = '') {
    put(launch, `#!/bin/bash\nset -eu\nexport PATH=${q(linuxPath(join(base, 'bin')))}:$PATH\nexport JAVA_HOME=${q(linuxPath(join(base, 'jdk')))}\nexport ANDROID_HOME=${q(linuxPath(join(base, 'sdk')))}\nexport EXPO_ANDROID_KEYSTORE_PATH=${q(linuxPath(join(base, 'key/release.keystore')))}\nexport EXPO_ANDROID_KEYSTORE_PASSWORD=fixture-store-secret\nexport EXPO_ANDROID_KEY_ALIAS=fixture-alias\nexport EXPO_ANDROID_KEY_PASSWORD=fixture-key-secret\nexport EXPECTED_RELEASE_CERT_SHA256=${'a'.repeat(64)}\nexport EXPO_PUBLIC_RELAY_URL=https://relay.example\n${extra}\nbash -x ${q(linuxPath(join(repo, 'scripts/build-android.sh')))} ${q(linuxPath(source))} ${q(linuxPath(root))} ${q(linuxPath(artifacts))}\n`);
    return bash(launch);
  }
  return { base, source, root, artifacts, run };
}

test('each invocation uses fresh sources, ignores private/ignored files, and selects only the current release APK', () => {
  const f = setup();
  const result = f.run();
  assert.equal(result.status, 0, result.output);
  assert.match(readFileSync(join(f.base, 'signed-input'), 'utf8'), /\/run-[^/]+\/source\/apps\/app\/android\/app\/build\/outputs\/apk\/release\/app-release\.apk$/);
  const runs = () => readdirSync(f.root).filter((name) => name.startsWith('run-'));
  assert.equal(runs().length, 1);
  const staged = join(f.root, runs()[0], 'source');
  assert.equal(readFileSync(join(staged, 'fixture-install-command'), 'utf8').trim(), 'ci');
  assert.equal(readFileSync(join(staged, 'fixture-signing-env'), 'utf8'), '');
  for (const cache of readFileSync(join(staged, 'fixture-caches'), 'utf8').trim().split('\n')) {
    assert.ok(cache.startsWith(`${linuxPath(f.root)}/cache/`), cache);
    assert.ok(!cache.includes('/source/'), cache);
  }
  assert.ok(existsSync(join(f.artifacts, 'minimax-bot-mobile-release.apk')));
  for (const name of ['ignored-local', 'private-ignore', '.git', '.audit-local', '.upstream', 'public-ready', '.env', '.env.production', '.dev.vars', '.dev.vars.local', 'bridge-token', 'bridge-config.json', 'ledger.json', 'release.jks', 'release.keystore', 'private.pem', 'node_modules']) {
    assert.equal(existsSync(join(staged, name)), false, `copied ${name}`);
  }
  renameSync(join(f.source, 'apps/app/app/removed-route.tsx'), join(f.base, 'removed-route.tsx'));
  const second = f.run();
  assert.equal(second.status, 0, second.output);
  assert.equal(runs().length, 2);
  const newest = readFileSync(join(f.base, 'signed-input'), 'utf8').split('/source/')[0];
  assert.equal(existsSync(join(newest, 'source/apps/app/app/removed-route.tsx')), false);
  assert.equal(readFileSync(join(f.root, 'keep-user-file'), 'utf8'), 'never delete');
  assert.equal(readFileSync(join(f.source, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}\n');
  const args = readFileSync(join(f.base, 'sign-argv.json'), 'utf8');
  assert.ok(!args.includes('fixture-store-secret') && !args.includes('fixture-key-secret'), args);
  assert.ok(!result.output.includes('fixture-store-secret') && !result.output.includes('fixture-key-secret'), result.output);
});

for (const mode of ['missing', 'unexpected', 'wrong-name']) {
  test(`rejects ${mode} release outputs instead of signing a stale/debug/old bundled APK`, () => {
    const f = setup(mode);
    const result = f.run();
    assert.notEqual(result.status, 0, result.output);
    assert.equal(existsSync(join(f.base, 'signed-input')), false, result.output);
  });
}
for (const previousArtifact of [false, true]) {
  test(`rejects failed APK verification despite matching certificate text (${previousArtifact ? 'preserves prior artifact' : 'publishes no artifact'})`, () => {
    const f = setup('verify-failed');
    const verifier = bash(join(f.base, 'sdk/build-tools/99/apksigner'), ['verify', '--print-certs', 'fixture.apk']);
    assert.equal(verifier.status, 1);
    assert.match(verifier.stdout, new RegExp(`certificate SHA-256 digest: ${'a'.repeat(64)}`));
    assert.match(verifier.stderr, /FAILED-VERIFICATION/);
    const output = join(f.artifacts, 'minimax-bot-mobile-release.apk');
    if (previousArtifact) put(output, 'previous-verified-artifact');
    const result = f.run();
    assert.notEqual(result.status, 0, result.output);
    assert.ok(existsSync(join(f.base, 'signed-input')), 'fixture must reach signing and verification');
    assert.match(result.output, /APK signature verification failed/);
    assert.match(result.output, /FAILED-VERIFICATION/);
    assert.doesNotMatch(result.output, /=== verified release APK:/);
    if (previousArtifact) assert.equal(readFileSync(output, 'utf8'), 'previous-verified-artifact');
    else assert.equal(existsSync(output), false);
  });
}

for (const mode of ['cleartext', 'wrong-cert', 'wrong-relay']) {
  test(`keeps the ${mode} artifact gate`, () => {
    const f = setup(mode);
    const result = f.run();
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, mode === 'cleartext' ? /cleartext/i : mode === 'wrong-cert' ? /expected release certificate/ : /does not name its configured relay/);
    assert.equal(existsSync(join(f.artifacts, 'minimax-bot-mobile-release.apk')), false);
  });
}
test('rejects a signing key inside the source tree before dependency restore', () => {
  const f = setup();
  const result = f.run(`export EXPO_ANDROID_KEYSTORE_PATH=${q(linuxPath(join(f.source, 'release.keystore')))}`);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(existsSync(join(f.base, 'signed-input')), false);
  assert.match(result.output, /outside.*(source|build)/i);
});

for (const [setting, value, message] of [
  ['EXPO_PUBLIC_RELAY_URL', 'http://relay.example', /HTTPS URL/],
  ['EXPECTED_RELEASE_CERT_SHA256', 'invalid', /SHA-256/],
  ['EXPO_ANDROID_KEYSTORE_PASSWORD', '', /EXPO_ANDROID_KEYSTORE_PASSWORD/],
]) {
  test(`rejects invalid ${setting} before creating a build or restoring dependencies`, () => {
    const f = setup();
    const result = f.run(`export ${setting}=${q(value)}`);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, message);
    assert.ok(readdirSync(f.root).every((name) => !name.startsWith('run-')));
  });
}
test('rejects an unexpected npm before staging', () => {
  const f = setup();
  const shim = join(f.base, 'bin/npm');
  put(shim, readFileSync(shim, 'utf8').replace('echo 12.2.1', 'echo 11.19.1'));
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /package manager npm 12\.2\.1/);
  assert.ok(readdirSync(f.root).every((name) => !name.startsWith('run-')));
});
test('rejects a misconfigured JDK before staging or dependency restore', () => {
  const f = setup();
  put(join(f.base, 'jdk/bin/java'), '#!/bin/sh\necho \'openjdk version "21.0.1"\' >&2\n');
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /JDK 17/);
  assert.ok(readdirSync(f.root).every((name) => !name.startsWith('run-')));
});

test('rejects a credential-bearing project npmrc without logging its contents', () => {
  const f = setup();
  put(join(f.source, '.npmrc'), '//registry.npmjs.org/:_authToken=fixture-auth-value\n');
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /credential-free project policy/);
  assert.doesNotMatch(result.output, /fixture-auth-value/);
  assert.equal(existsSync(join(f.base, 'signed-input')), false);
});

function aliasFixture() {
  const base = fixture('aliases');
  const metadata = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const app = JSON.parse(readFileSync(join(repo, 'apps/app/package.json'), 'utf8'));
  put(join(base, 'package.json'), JSON.stringify({ private: true, scripts: metadata.scripts, workspaces: ['apps/app', 'packages/bridge', 'packages/protocol'] }));
  put(join(base, 'apps/app/package.json'), JSON.stringify({ name: '@minimax-bot/app', scripts: { 'build:android': app.scripts['build:android'], test: `node "${join(repo, 'node_modules/jest/bin/jest.js').replaceAll('\\', '/')}"` } }));
  put(join(base, 'apps/app/jest.config.cjs'), 'module.exports = { testEnvironment: "node", cacheDirectory: "<rootDir>/.cache" };');
  put(join(base, 'apps/app/selected.test.js'), 'test("selected", () => {});');
  put(join(base, 'apps/app/other.test.js'), 'test("other", () => {});');
  put(join(base, 'packages/protocol/package.json'), '{"name":"@minimax-bot/protocol","scripts":{"build":"node -e \\\"process.exit(0)\\\""}}');
  const bridge = JSON.parse(readFileSync(join(repo, 'packages/bridge/package.json'), 'utf8'));
  put(join(base, 'packages/bridge/package.json'), JSON.stringify({ name: '@minimax-bot/bridge', scripts: { test: bridge.scripts.test } }));
  put(join(base, 'packages/bridge/scripts/sync-protocol.mjs'), '// Fixture sync: deliberately no side effects.\n');
  put(join(base, 'packages/bridge/test/selection.test.mjs'), 'import { test } from "node:test"; test("fixture", () => {});');
  put(join(base, 'scripts/build-android.sh'), readFileSync(join(repo, 'scripts/build-android.sh'), 'utf8'));
  return base;
}

test('both Android aliases reach the guarded portable help interface and forward arguments', () => {
  const workspace = aliasFixture();
  for (const args of [['run', 'build:android', '--', '--help'], ['run', 'build:android', '-w', '@minimax-bot/app', '--', '--help']]) {
    // Use Linux npm so the documented Linux/WSL build entry point is exercised.
    const base = fixture('alias');
    const launch = join(base, 'alias.sh');
    const cli = process.env.POLICY_NPM_CLI || process.env.npm_execpath;
    put(launch, `#!/bin/bash\ncd ${q(linuxPath(workspace))}\nexport npm_config_cache=${q(linuxPath(join(base, 'cache')))}\nnode ${q(linuxPath(cli))} ${args.map(q).join(' ')}\n`);
    // Loading Windows-hosted npm through /mnt is slow on a cold WSL cache.
    // Keep this cross-platform fixture bounded without imposing a native-run SLA.
    const result = bash(launch, [], { timeout: process.platform === 'win32' ? 180_000 : 60_000 });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /build-root/);
  }
});

test('nested runner aliases forward real help/selection flags', () => {
  const workspace = aliasFixture();
  const bridge = npm(['run', 'test:bridge', '--', '--help'], { cwd: workspace });
  assert.equal(bridge.status, 0, bridge.output);
  assert.match(bridge.output, /Usage: node/);
  assert.doesNotMatch(bridge.output, /# tests \d+/);
  const app = npm(['run', 'test:app', '--', '--listTests', '--runInBand', '--testPathPatterns=selected'], { cwd: workspace });
  assert.equal(app.status, 0, app.output);
  assert.match(app.output, /selected\.test\.js/);
  assert.doesNotMatch(app.output, /other\.test\.js/);
  assert.doesNotMatch(app.output, /Test Suites:/);
});
