import { describe, expect, it } from 'vitest';

import { accountIdFromPath } from '../src/account-path.js';

describe('account path parsing', () => {
  it('reads the account out of a relay path', () => {
    expect(accountIdFromPath('/r/acct-1/ws')).toBe('acct-1');
    expect(accountIdFromPath('/r/acct-1/status')).toBe('acct-1');
    expect(accountIdFromPath('/r/acct-1')).toBe('acct-1');
  });

  it('ignores a trailing slash and repeated separators', () => {
    expect(accountIdFromPath('/r/acct-1/ws/')).toBe('acct-1');
    expect(accountIdFromPath('//r//acct-1//ws')).toBe('acct-1');
  });

  it('keeps an account that contains a slash-free path segment intact', () => {
    expect(accountIdFromPath('/r/default/ws')).toBe('default');
    expect(accountIdFromPath('/r/team.bot/ws')).toBe('team.bot');
  });

  it('returns nothing for a path that names no account', () => {
    expect(accountIdFromPath('/ws')).toBe('');
    expect(accountIdFromPath('/')).toBe('');
    expect(accountIdFromPath('/r')).toBe('');
    expect(accountIdFromPath('/r/')).toBe('');
  });

  it('does not read an account out of a path that does not start with /r', () => {
    expect(accountIdFromPath('/api/session')).toBe('');
    expect(accountIdFromPath('/accounts/acct-1')).toBe('');
  });
});
