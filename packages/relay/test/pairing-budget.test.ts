import { describe, expect, it } from 'vitest';

import { RelaySession, type SessionOptions } from '../src/session.js';

/**
 * The pairing budget.
 *
 * The pairing route answers without a credential - the six digit code is the
 * credential - so the attempts against it have to be budgeted. The budget is shared
 * between the owner's phone and whoever is guessing, which is what makes it delicate:
 * a budget that is too tight locks the real user out, and one that is too loose lets
 * the code space be swept.
 */

const SECRET = 'test-secret-value';

function makeSession(overrides: Partial<SessionOptions> = {}) {
  return new RelaySession({ secret: SECRET, ...overrides });
}

describe('the pairing budget', () => {
  it('does not let a flood against one code lock the account', async () => {
    let now = 1_000_000;
    const session = makeSession({ now: () => now });
    const { code } = await session.createPairingCode('bridge-1', 'Desk');

    // The same wrong code, over and over.
    for (let i = 0; i < 50; i += 1) {
      const wrong = await session.pairDevice('000000', `device-${i}`, 'Phone', '1.0.0');
      expect(wrong.ok).toBe(false);
    }

    // The owner's phone still gets in: the flood was charged to the code it aimed at,
    // not to the account.
    now += 1_000;
    const paired = await session.pairDevice(code, 'device-real', 'Phone', '1.0.0');
    expect(paired.ok).toBe(true);
    expect(paired.deviceToken).toBeTruthy();
  });

  it('refuses a code that has been guessed too often, without locking the account', async () => {
    const session = makeSession();

    // One code, guessed over and over.
    for (let i = 0; i < 12; i += 1) {
      await session.pairDevice('000000', `device-${i}`, 'Phone', '1.0.0');
    }

    const again = await session.pairDevice('000000', 'device-again', 'Phone', '1.0.0');
    expect(again.code).toBe('RATE_LIMITED');

    // The account was not locked out by it: a different code is still answered.
    const other = await session.pairDevice('111111', 'device-other', 'Phone', '1.0.0');
    expect(other.code).toBe('PAIRING_CODE_UNKNOWN');
  });

  it('spends the account budget only on codes that are tried for the first time', async () => {
    let now = 1_000_000;
    const session = makeSession({ now: () => now });

    // Ten wrong codes, all different: the account's budget is three, so the room
    // starts refusing after the third one.
    let refused = 0;
    for (let i = 0; i < 10; i += 1) {
      const result = await session.pairDevice(`00000${i}`, `device-${i}`, 'Phone', '1.0.0');
      if (result.code === 'RATE_LIMITED') refused += 1;
    }
    expect(refused).toBe(7);

    // The window is eighteen seconds, not a minute.
    now += 19_000;
    const after = await session.pairDevice('000009', 'device-after', 'Phone', '1.0.0');
    expect(after.code).toBe('PAIRING_CODE_UNKNOWN');
  });

  it('does not remember a guess that could never be a pairing code', async () => {
    const session = makeSession();

    // The key of the per-code budgets is a string the caller chose, so only a code
    // that could be right is remembered: a caller that sends a sixteen kilobyte
    // "code" would otherwise fill the map with sixteen kilobyte keys.
    await session.pairDevice('x'.repeat(16 * 1024), 'device-1', 'Phone', '1.0.0');

    const budgets = (session as unknown as { codeAttempts: Map<string, unknown> }).codeAttempts;
    expect(budgets.size).toBe(0);
  });

  it('refuses the account after a flood of different codes, and lets it go again soon', async () => {
    let now = 1_000_000;
    const session = makeSession({ now: () => now });
    const { code } = await session.createPairingCode('bridge-1', 'Desk');

    // Five different wrong codes use up the account's budget.
    for (let i = 0; i < 5; i += 1) {
      const wrong = await session.pairDevice(`00000${i}`, `device-${i}`, 'Phone', '1.0.0');
      expect(wrong.ok).toBe(false);
    }

    const blocked = await session.pairDevice(code, 'device-real', 'Phone', '1.0.0');
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('RATE_LIMITED');

    // The window is short: the owner's phone is not locked out for a minute.
    now += 19_000;
    const paired = await session.pairDevice(code, 'device-real', 'Phone', '1.0.0');
    expect(paired.ok).toBe(true);
  });
});
