import { describe, expect, it } from 'vitest';

import { issueToken } from '@minimax-bot/protocol';

import { RelaySession, type SessionStorage, type SocketLike } from '../src/session.js';

/**
 * The room has to survive a restart.
 *
 * The Durable Object that holds a room is evicted whenever the platform decides
 * to, and a deploy replaces it outright. Everything the room needs to keep
 * serving its peers - the device registry, the pairing codes, the account's
 * owner and the sequence counter - therefore has to be written down, or the
 * next request finds an empty room: every phone is unpaired and every phone's
 * cursor sits above a counter that has started again.
 *
 * These tests use two sessions over one storage. The second session is a relay
 * that was redeployed or evicted, and it is the only way to show that the state
 * is durable rather than merely held in memory.
 */

const SECRET = 'test-secret-value';
const ACCOUNT = 'acct-1';

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

/** A storage that keeps what a Durable Object's storage would keep. */
function makeStorage() {
  const data = new Map<string, unknown>();
  const storage: SessionStorage & { data: Map<string, unknown> } = {
    data,
    async get<T>(key: string): Promise<T | undefined> {
      return data.get(key) as T | undefined;
    },
    async put<T>(key: string, value: T): Promise<void> {
      data.set(key, value);
    },
  };
  return storage;
}

/**
 * Waits for the durable writes to land.
 *
 * A session that keeps no durable state has nothing to wait for, so this is
 * written to work against one too - which is what lets the same test run
 * against the code as it was before the fix.
 */
async function settle(session: RelaySession): Promise<void> {
  const flush = (session as unknown as { flush?: () => Promise<void> }).flush;
  if (typeof flush === 'function') {
    await flush.call(session);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function session(storage: SessionStorage): RelaySession {
  return new RelaySession({ secret: SECRET, storage });
}

/** A bridge token bound to an account, the way the mint script issues one. */
async function bridgeToken(bridgeId = 'bridge-1', accountId = ACCOUNT) {
  return issueToken(bridgeId, 'bridge', 60_000, SECRET, { accountId });
}

/**
 * Puts one event through the relay, so the session has a sequence number to
 * keep.
 */
async function emitEvent(target: RelaySession, id: string): Promise<void> {
  const { token } = await bridgeToken();
  const socket = new FakeSocket();
  await target.registerSocket({
    id: 'b1',
    role: 'bridge',
    subject: 'bridge-1',
    accountId: ACCOUNT,
    token,
    socket,
  });
  target.handleFrame(
    { id: 'b1', role: 'bridge', subject: 'bridge-1', socket },
    JSON.stringify({ v: 1, id, ts: 1, type: 'evt.team_snapshot', source: 'bridge', payload: {} }),
  );
  await settle(target);
}

describe('the room across a restart', () => {
  it('keeps the phone paired', async () => {
    const storage = makeStorage();
    const before = session(storage);

    const { code } = await before.createPairingCode('bridge-1', 'Desk');
    const paired = await before.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    expect(paired.ok).toBe(true);

    // A new session over the same storage is a relay that was redeployed, or a
    // Durable Object that was evicted.
    const after = session(storage);
    const registered = await after.registerSocket({
      id: 'd1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: new FakeSocket(),
    });

    expect(registered.ok).toBe(true);
  });

  it('keeps the pairing code the desktop showed', async () => {
    const storage = makeStorage();
    const before = session(storage);
    const { code } = await before.createPairingCode('bridge-1', 'Desk');

    // The code is on the desktop's screen and in the user's hands. A restart
    // must not make it a code that no longer works.
    const after = session(storage);
    const paired = await after.pairDevice(code, 'device-1', 'Phone', '1.0.0');

    expect(paired.ok).toBe(true);
  });

  it('keeps the account with the desktop that claimed it', async () => {
    const storage = makeStorage();
    const before = session(storage);
    await before.createPairingCode('bridge-1', 'Desk');

    // An account belongs to one bridge. A room that forgets its owner would let
    // the next desktop to ask for a code take the account over.
    const after = session(storage);
    await expect(
      Promise.resolve().then(() => after.createPairingCode('bridge-2', 'Other')),
    ).rejects.toThrow('ACCOUNT_OWNED');
  });

  it('keeps a revoked phone revoked', async () => {
    const storage = makeStorage();
    const before = session(storage);
    const { code } = await before.createPairingCode('bridge-1', 'Desk');
    const paired = await before.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    await before.revokeDevice('device-1');

    const after = session(storage);

    // The desktop's list still shows the phone, and still shows it as revoked: a
    // restart must not hand a phone back that the desktop deliberately cut off.
    const devices = await after.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.revoked).toBe(true);

    const registered = await after.registerSocket({
      id: 'd1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: new FakeSocket(),
    });
    expect(registered.ok).toBe(false);
  });

  it('keeps the sequence counter, so a phone stays in step with the relay', async () => {
    const storage = makeStorage();
    const before = session(storage);
    await emitEvent(before, 'f1');
    await emitEvent(before, 'f2');
    expect(before.lastSeq).toBe(2);

    const after = session(storage);

    // The counter is durable. A relay that starts again at zero hands a phone a
    // stream of numbers it has already seen, and the phone drops every one of
    // them without a word.
    expect((await after.status()).lastSeq).toBe(2);

    await emitEvent(after, 'f3');
    expect(after.lastSeq).toBe(3);
  });
});

describe('what the registry keeps', () => {
  it('keeps a digest of the token rather than the token', async () => {
    const storage = makeStorage();
    const target = session(storage);

    const { code } = await target.createPairingCode('bridge-1', 'Desk');
    const paired = await target.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    const token = paired.deviceToken!;

    const stored = JSON.stringify(storage.data.get('devices') ?? null);

    // The registry is written down...
    expect(stored).toContain('device-1');
    // ...but what is written down is not a set of live phone credentials. The
    // registry only ever asks whether a token is the one it issued, so a digest
    // answers that question just as well.
    expect(stored).not.toContain(token);
  });
});

describe('a phone that is ahead of the relay', () => {
  it('is told to resynchronise instead of being left with a hole', async () => {
    const target = new RelaySession({ secret: SECRET });
    const { code } = await target.createPairingCode('bridge-1', 'Desk');
    const paired = await target.pairDevice(code, 'device-1', 'Phone', '1.0.0');

    // The relay has no frames at all, and the phone says it has seen five. That
    // is a relay whose state was lost, or a phone talking to the wrong room.
    const registered = await target.registerSocket({
      id: 'd1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: new FakeSocket(),
      lastSeq: 5,
    });

    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    // The phone is told its view has a hole, so it rebuilds it. Without this the
    // phone would believe it was up to date and would then silently drop every
    // frame the relay sends, because their numbers are below its cursor.
    expect(registered.replay.truncated).toBe(true);
  });
});

describe('the durable state when it misbehaves', () => {
  it('reads the revocation cutoff once, so a concurrent caller cannot miss it', async () => {
    const storage = makeStorage();
    const before = session(storage);
    await before.revokeBridgeTokensBefore(Date.now() + 1_000);

    // A new session over the same storage is a relay that was redeployed.
    const after = session(storage);

    // Two callers arrive together, the way two requests to one Durable Object
    // do. The second one must not be told that no token has been revoked while
    // the first read is still in flight: that is how a revoked bridge token
    // walks back into the room.
    const [first, second] = await Promise.all([
      after.bridgeTokenCutoff(),
      after.bridgeTokenCutoff(),
    ]);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it('tries again after a failed read', async () => {
    let reads = 0;
    let broken = true;
    const data = new Map<string, unknown>();
    const storage = {
      async get<T>(key: string): Promise<T | undefined> {
        reads += 1;
        if (broken) throw new Error('the storage is not reachable');
        return data.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        data.set(key, value);
      },
    };
    const target = session(storage);

    // The read fails, so the caller is told the state could not be read rather
    // than being given an empty room that looks like the truth.
    await expect(target.bridgeTokenCutoff()).rejects.toThrow('the storage is not reachable');

    // The room is not bricked by that: the next caller reads again.
    broken = false;
    const readsBefore = reads;
    await expect(target.bridgeTokenCutoff()).resolves.toBeNull();
    expect(reads).toBeGreaterThan(readsBefore);
  });

  it('writes the counter again after a failed write', async () => {
    const data = new Map<string, unknown>();
    let broken = true;
    const storage = {
      async get<T>(key: string): Promise<T | undefined> {
        return data.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        if (broken && key === 'seq') throw new Error('the storage is not reachable');
        data.set(key, value);
      },
    };
    const target = session(storage);

    await emitEvent(target, 'f1');
    await settle(target);

    // The write failed, so the counter is not on disk yet.
    expect(data.get('seq')).toBeUndefined();

    // The next flush tries again, and the counter lands.
    broken = false;
    await settle(target);
    expect(data.get('seq')).toBe(1);
  });
});
