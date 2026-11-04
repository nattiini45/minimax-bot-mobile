import { describe, expect, it } from 'vitest';

import { Relay } from '../src/relay.js';
import type { SessionStorage } from '../src/session.js';

/**
 * The Durable Object is an adapter over the session, and an adapter is a
 * place where an argument can die.
 *
 * The Worker reaches the room through Workers RPC, so every value the Worker
 * computed has to survive the hop into the object. A method that takes two
 * arguments and is called with three does not complain: the third one is
 * dropped, the call succeeds, and the caller gets the default instead of what
 * it asked for.
 *
 * These tests drive the object itself, not the session under it, so they cover
 * the hop.
 */

const SECRET = 'test-secret-value';
const ACCOUNT = 'acct-1';

/** A storage that keeps what a Durable Object's storage would keep. */
function makeStorage(): SessionStorage {
  const data = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
      if (typeof key === 'string') {
        data.set(key, value);
        return;
      }
      for (const [entryKey, entryValue] of Object.entries(key)) {
        data.set(entryKey, entryValue);
      }
    },
  };
}

function makeRelay() {
  return new Relay(
    { storage: makeStorage() } as never,
    { RELAY_SECRET: SECRET, RELAY_ACCOUNT: ACCOUNT } as never,
  );
}

describe('the object behind the worker', () => {
  it('carries the window the worker asked for', async () => {
    const relay = makeRelay();
    const before = Date.now();

    const { expiresAt } = await relay.createPairingCode('bridge-1', 'Desk', 15 * 60_000);
    const after = Date.now();

    expect(expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 15 * 60_000);
  });

  it('gives the default window when the worker asks for none', async () => {
    const relay = makeRelay();
    const before = Date.now();

    const { expiresAt } = await relay.createPairingCode('bridge-1', 'Desk');
    const after = Date.now();

    // Five minutes: long enough for a code that arrived in a message to still
    // be alive when it is typed.
    expect(expiresAt).toBeGreaterThanOrEqual(before + 4 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 5 * 60_000);
  });
});
