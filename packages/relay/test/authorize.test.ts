import { describe, expect, it } from 'vitest';

import { issueToken, verifyToken, type TokenPayload } from '@minimax-bot/protocol';

import { isBridgeTokenForAccount } from '../src/authorize.js';

const SECRET = 'authorize-test-secret';

async function bridgeToken(options: { accountId?: string; bridgeId?: string } = {}) {
  const { token } = await issueToken(options.bridgeId ?? 'bridge-1', 'bridge', 60_000, SECRET, {
    accountId: options.accountId,
  });
  return verifyToken(token, SECRET);
}

describe('a bridge token and the account it may act on', () => {
  it('accepts a bridge token bound to the account', async () => {
    const payload = await bridgeToken({ accountId: 'acct-1' });

    expect(isBridgeTokenForAccount(payload, 'acct-1')).toBe(true);
  });

  it('refuses a bridge token bound to another account', async () => {
    // The socket path already refuses this. The HTTP routes have to refuse it
    // too: a token for one account must not list or revoke another account's
    // devices, and must not claim another account's room.
    const payload = await bridgeToken({ accountId: 'acct-other' });

    expect(isBridgeTokenForAccount(payload, 'acct-1')).toBe(false);
  });

  it('refuses a bridge token with no account at all', async () => {
    const payload = await bridgeToken();

    expect(payload?.acc).toBeUndefined();
    expect(isBridgeTokenForAccount(payload, 'acct-1')).toBe(false);
  });

  it('refuses a device token', async () => {
    const { token } = await issueToken('device-1', 'device', 60_000, SECRET);
    const payload = (await verifyToken(token, SECRET)) as TokenPayload;

    expect(isBridgeTokenForAccount(payload, 'acct-1')).toBe(false);
  });

  it('refuses a missing payload', () => {
    expect(isBridgeTokenForAccount(null, 'acct-1')).toBe(false);
  });
});
