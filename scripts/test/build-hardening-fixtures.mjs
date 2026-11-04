import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const linuxPath = (path) => process.platform === 'win32'
  ? path.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`).replaceAll('\\', '/')
  : path;
export const fixtureRoot = resolve(repo, process.env.BUILD_POLICY_FIXTURE_ROOT || '.audit-local/fix-build');
export function fixture(prefix) {
  const base = fixtureRoot;
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}
export function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode: 0o755 });
}
export function bash(script, args = [], options = {}) {
  const command = process.platform === 'win32' ? 'wsl.exe' : 'bash';
  const argv = process.platform === 'win32' ? ['--exec', 'bash', linuxPath(script), ...args] : [script, ...args];
  if (process.platform === 'win32' && options.env) {
    const forwarded = Object.keys(options.env).filter((key) => options.env[key] !== process.env[key]);
    options = { ...options, env: { ...options.env, WSLENV: [process.env.WSLENV, ...forwarded].filter(Boolean).join(':') } };
  }
  const result = spawnSync(command, argv, { cwd: repo, encoding: 'utf8', timeout: 60_000, ...options });
  if (result.error) throw result.error;
  return { ...result, output: `${result.stdout}${result.stderr}` };
}
export function npm(args, options = {}) {
  const cli = process.env.POLICY_NPM_CLI || process.env.npm_execpath;
  if (!cli) throw new Error('Run with npm 12.2.1 (npm run test:policy), or set POLICY_NPM_CLI to its npm-cli.js.');
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: 'utf8', timeout: 60_000, ...options,
    env: { ...process.env, ...options.env, npm_config_cache: join(fixtureRoot, 'npm-cache') },
  });
  if (result.error) throw result.error;
  return { ...result, output: `${result.stdout}${result.stderr}` };
}
