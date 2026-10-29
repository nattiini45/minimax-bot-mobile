import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The relay secret is the master key.
 *
 * It is worth more than every token this script can mint, so it is not read from
 * the command line: an argument lands in the shell history and in the process
 * table, where anything running on the machine can read it. The environment and
 * a file are the ways in.
 */

const SCRIPT = fileURLToPath(new URL('../scripts/mint-bridge-token.mjs', import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RELAY_SECRET: '', ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('minting a bridge token', () => {
  it('refuses the secret on the command line', () => {
    const result = run(['--secret', 'the-secret', '--bridge-id', 'bridge-1']);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown option --secret');
    // The secret that was offered on the command line is not used, and it is not
    // echoed back either.
    expect(result.stdout).not.toContain('the-secret');
    expect(result.stderr).not.toContain('the-secret');
  });

  it('does not echo the secret when it is refused in the equals form', () => {
    const result = run(['--secret=the-secret', '--bridge-id', 'bridge-1']);

    expect(result.status).toBe(2);
    // The name of the option is reported, never its value: an unknown option
    // may well have been a secret.
    expect(result.stderr).toContain('Unknown option --secret');
    expect(result.stderr).not.toContain('the-secret');
  });

  it('takes the secret from the environment', () => {
    const result = run(['--bridge-id', 'bridge-1'], { RELAY_SECRET: 'the-secret' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bridgeToken');
  });

  it('does not print the secret', () => {
    const result = run(['--bridge-id', 'bridge-1'], { RELAY_SECRET: 'the-secret' });

    expect(result.stdout).not.toContain('the-secret');
    expect(result.stderr).not.toContain('the-secret');
  });
});
