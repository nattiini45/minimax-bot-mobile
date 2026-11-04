import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const readme = await readFile(new URL('README.md', root), 'utf8');

test('onboarding documents the package manager required by the install gate', () => {
  assert.ok(readme.includes(pkg.packageManager), `README must name ${pkg.packageManager}`);
  assert.equal(pkg.engines.npm, pkg.devEngines.packageManager.version);
});

test('onboarding bootstraps npm outside the gated checkout before its first ci command', () => {
  const command = `npm install --global ${pkg.packageManager}`;
  const install = readme.indexOf(command);
  const ci = readme.indexOf('npm ci');
  assert.ok(install >= 0, 'README needs an explicit npm bootstrap command');
  assert.ok(install < ci, 'Bootstrap must precede the first in-checkout npm ci');
  assert.match(readme.slice(0, install), /outside (?:the )?(?:repository|checkout)/i);
});
