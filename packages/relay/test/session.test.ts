import { describe, expect, it } from 'vitest';

import { CLOSE_CODE, issueToken, signToken, verifyToken } from '@minimax-bot/protocol';

import { RelaySession, type SessionOptions, type SocketLike } from '../src/session.js';

const SECRET = 'test-secret-value';

/** The account the room belongs to. */
const ACCOUNT = 'acct-1';

/**
 * A bridge token bound to an account, the way the mint script issues one.
 *
 * A bridge token without an account is not a usable credential: the relay
 * rejects it, because it would be valid against every account.
 */
async function bridgeToken(bridgeId = 'bridge-1', accountId = ACCOUNT) {
  return issueToken(bridgeId, 'bridge', 60_000, SECRET, { accountId });
}

class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  frames(): { type: string; seq?: number }[] {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; seq?: number });
  }
}

function makeSession(overrides: Partial<SessionOptions> = {}) {
  return new RelaySession({ secret: SECRET, ...overrides });
}

async function pair(session: RelaySession, deviceId = 'device-1') {
  const { code } = await session.createPairingCode('bridge-1', 'Desk');
  return session.pairDevice(code, deviceId, 'Phone', '1.0.0');
}

describe('relay tokens', () => {
  it('round-trips a signed token', async () => {
    const { token, expiresAt } = await issueToken('device-1', 'device', 60_000, SECRET);
    const payload = await verifyToken(token, SECRET);

    expect(payload?.sub).toBe('device-1');
    expect(payload?.role).toBe('device');
    expect(payload?.exp).toBe(expiresAt);
  });

  it('rejects a token signed with a different secret', async () => {
    const { token } = await issueToken('device-1', 'device', 60_000, 'other-secret');
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const { token } = await issueToken('device-1', 'device', 60_000, SECRET);
    const [body, signature] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ v: 1, sub: 'attacker', role: 'device', exp: Date.now() + 1000 })).toString('base64url')}.${signature}`;

    expect(await verifyToken(forged, SECRET)).toBeNull();
    expect(body).toBeTruthy();
  });

  it('rejects an expired token', async () => {
    const { token } = await issueToken('device-1', 'device', -1, SECRET);
    expect(await verifyToken(token, SECRET)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifyToken('', SECRET)).toBeNull();
    expect(await verifyToken('no-dot', SECRET)).toBeNull();
    expect(await verifyToken('.sig', SECRET)).toBeNull();
    expect(await verifyToken('body.', SECRET)).toBeNull();
  });

  it('rejects a token with an unknown role', async () => {
    const token = await signToken(
      { v: 1, sub: 'x', role: 'admin' as never, exp: Date.now() + 60_000, jti: 'j' },
      SECRET,
    );
    expect(await verifyToken(token, SECRET)).toBeNull();
  });
});

describe('pairing', () => {
  it('issues a code and exchanges it for a device token', async () => {
    const session = makeSession();
    const { code } = await session.createPairingCode('bridge-1', 'Desk');
    expect(code).toMatch(/^\d{6}$/);

    const result = await session.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    expect(result.ok).toBe(true);
    expect(result.deviceToken).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('consumes the code so it cannot be reused', async () => {
    const session = makeSession();
    const { code } = await session.createPairingCode('bridge-1', 'Desk');
    await session.pairDevice(code, 'device-1', 'Phone', '1.0.0');

    const second = await session.pairDevice(code, 'device-2', 'Other', '1.0.0');
    expect(second.ok).toBe(false);
    expect(second.code).toBe('PAIRING_CODE_UNKNOWN');
  });

  it('rejects an unknown code', async () => {
    const session = makeSession();
    const result = await session.pairDevice('000000', 'device-1', 'Phone', '1.0.0');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAIRING_CODE_UNKNOWN');
  });

  it('rejects an expired code', async () => {
    let now = 1_000_000;
    const session = makeSession({ now: () => now });
    const { code, expiresAt } = await session.createPairingCode('bridge-1', 'Desk');
    expect(expiresAt).toBeGreaterThan(now);

    now += 120_000;
    const result = await session.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAIRING_CODE_EXPIRED');
  });

  it('lists paired devices and revokes them', async () => {
    const session = makeSession();
    await pair(session, 'device-1');
    expect(await session.listDevices()).toHaveLength(1);

    expect(await session.revokeDevice('device-1')).toBe(true);
    expect((await session.listDevices())[0]?.revoked).toBe(true);
    expect(await session.revokeDevice('nope')).toBe(false);
  });
});

describe('a device releasing its own token', () => {
  it('revokes the device the token was issued to', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const token = paired.deviceToken!;

    expect(await session.releaseDevice('device-1', token)).toBe(true);
    expect((await session.listDevices())[0]?.revoked).toBe(true);
  });

  it('makes the token stop working', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const token = paired.deviceToken!;
    await session.releaseDevice('device-1', token);

    const registered = await session.registerSocket({
      id: 'peer-1',
      role: 'device',
      subject: 'device-1',
      token,
      socket: new FakeSocket(),
    });

    expect(registered.ok).toBe(false);
  });

  it('does not release a device whose token was not presented', async () => {
    const session = makeSession();
    await pair(session, 'device-1');

    // A token that is not the one the registry issued must not revoke anything.
    expect(await session.releaseDevice('device-1', 'some-other-token')).toBe(false);
    expect((await session.listDevices())[0]?.revoked).toBe(false);
  });

  it('does not release a device that has the same id in another account', async () => {
    // The id is not enough: the token has to be the one this account's registry
    // issued, or a device from one account could unpair a device of another.
    const session = makeSession();
    await pair(session, 'device-1');

    expect(await session.releaseDevice('device-1', 'a-token-from-another-account')).toBe(false);
    expect((await session.listDevices())[0]?.revoked).toBe(false);
  });

  it('does not release a device that was never paired here', async () => {
    const session = makeSession();

    expect(await session.releaseDevice('device-9', 'a-token')).toBe(false);
  });
});

describe('socket registration', () => {
  it('rejects a device with a bad token and says why', async () => {
    const session = makeSession();
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'p1',
      role: 'device',
      subject: 'device-1',
      token: 'garbage',
      socket,
    });

    // The socket is closed by the transport, not here: the peer has to be told the
    // reason, and a close code is the only way it can hear it.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(CLOSE_CODE.unauthorized);
      expect(result.reason).toBe('UNAUTHORIZED');
    }
    expect(socket.closed).toBeNull();
  });

  it('rejects a token whose subject does not match', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'p1',
      role: 'device',
      subject: 'device-2',
      token: paired.deviceToken!,
      socket,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CLOSE_CODE.unauthorized);
  });

  it('rejects a revoked device', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    await session.revokeDevice('device-1');

    const socket = new FakeSocket();
    const result = await session.registerSocket({
      id: 'p1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CLOSE_CODE.deviceRevoked);
  });

  it('accepts a paired device', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'p1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket,
    });

    expect(result.ok).toBe(true);
    expect(session.deviceSocketCount).toBe(1);
  });

  it('replaces an older bridge socket when a new bridge connects', async () => {
    const session = makeSession();
    const { token } = await bridgeToken();
    const first = new FakeSocket();
    const second = new FakeSocket();

    await session.registerSocket({ id: 'p1', role: 'bridge', subject: 'bridge-1', accountId: ACCOUNT, token, socket: first });
    await session.registerSocket({ id: 'p2', role: 'bridge', subject: 'bridge-1', accountId: ACCOUNT, token, socket: second });

    expect(first.closed?.code).toBe(CLOSE_CODE.replaced);
    expect((await session.status()).bridgeOnline).toBe(true);
  });
});

describe('frame routing', () => {
  async function connected() {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const deviceSocket = new FakeSocket();
    await session.registerSocket({
      id: 'd1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: deviceSocket,
    });

    const { token } = await bridgeToken();
    const bridgeSocket = new FakeSocket();
    await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token,
      socket: bridgeSocket,
    });

    return { session, deviceSocket, bridgeSocket };
  }

  it('forwards a device frame to the bridge with the sender named', async () => {
    const { session, bridgeSocket } = await connected();
    const raw = JSON.stringify({ v: 1, id: 'f1', ts: 1, type: 'op.list_team', source: 'app', payload: {} });

    session.handleFrame(
      { id: 'd1', role: 'device', subject: 'device-1', socket: new FakeSocket() },
      raw,
    );

    // The frame is not re-serialised - the relay routes frames, it does not
    // interpret them - but the sender is named on it, because the desktop has
    // to know which phone sent it.
    const forwarded = JSON.parse(bridgeSocket.sent[0]!);
    expect(forwarded.type).toBe('op.list_team');
    expect(forwarded.id).toBe('f1');
    expect(forwarded.from).toBe('device-1');
  });

  it('stamps events with a monotonic seq and fans them out', async () => {
    const { session, deviceSocket } = await connected();
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f1', ts: 1, type: 'evt.team_snapshot', source: 'bridge', payload: {} }));
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f2', ts: 2, type: 'evt.message_chunk', source: 'bridge', payload: {} }));

    const frames = deviceSocket.frames();
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2]);
    expect(session.lastSeq).toBe(2);
  });

  it('does not sequence control frames', async () => {
    const { session, deviceSocket } = await connected();
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f1', ts: 1, type: 'ack', source: 'bridge', payload: {} }));

    expect(deviceSocket.frames()[0]?.seq).toBeUndefined();
    expect(session.lastSeq).toBe(0);
  });

  it('replays missed events to a resuming device', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const { token } = await bridgeToken();

    const bridgeSocket = new FakeSocket();
    await session.registerSocket({ id: 'b1', role: 'bridge', subject: 'bridge-1', accountId: ACCOUNT, token, socket: bridgeSocket });
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: bridgeSocket };

    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f1', ts: 1, type: 'evt.team_snapshot', source: 'bridge', payload: {} }));
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f2', ts: 2, type: 'evt.message_chunk', source: 'bridge', payload: {} }));
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f3', ts: 3, type: 'evt.turn_finished', source: 'bridge', payload: {} }));

    const resumed = new FakeSocket();
    const result = await session.registerSocket({
      id: 'd2',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: resumed,
      lastSeq: 1,
    });

    if (!result.ok) throw new Error(`expected the device to be accepted: ${result.reason}`);
    expect(result.replay.truncated).toBe(false);
    expect(result.replay.entries.map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it('does not replay control frames to a device that never sent them', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const { token } = await bridgeToken();

    const bridgeSocket = new FakeSocket();
    await session.registerSocket({ id: 'b1', role: 'bridge', subject: 'bridge-1', accountId: ACCOUNT, token, socket: bridgeSocket });
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: bridgeSocket };

    // The event comes FIRST on purpose. A control frame that arrives before any event
    // would sit in the ring at sequence 0, and a resuming device filters sequence 0 out
    // anyway — so the old code would pass this test. It is the control frame that
    // arrives *after* an event that used to be replayed to a device that never asked.
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f1', ts: 1, type: 'evt.team_snapshot', source: 'bridge', payload: {} }));
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f2', ts: 2, type: 'ack', source: 'bridge', payload: { opId: 'op-old' } }));
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f3', ts: 3, type: 'err', source: 'bridge', payload: { opId: 'op-old', code: 'X' } }));

    const resumed = new FakeSocket();
    const result = await session.registerSocket({
      id: 'd2',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: resumed,
      lastSeq: 0,
    });

    if (!result.ok) throw new Error(`expected the device to be accepted: ${result.reason}`);
    // Only the event is replayed. The `ack` and the `err` answered requests this device
    // never made, so they are not in the buffer it resumes from.
    expect(result.replay.entries.map((entry) => entry.seq)).toEqual([1]);
    expect(result.replay.entries.map((entry) => JSON.parse(entry.data).type)).toEqual([
      'evt.team_snapshot',
    ]);
  });

  it('still delivers a control frame to the devices that are connected', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const { token } = await bridgeToken();

    const bridgeSocket = new FakeSocket();
    await session.registerSocket({ id: 'b1', role: 'bridge', subject: 'bridge-1', accountId: ACCOUNT, token, socket: bridgeSocket });
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: bridgeSocket };

    const deviceSocket = new FakeSocket();
    await session.registerSocket({
      id: 'd1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: deviceSocket,
    });

    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f1', ts: 1, type: 'ack', source: 'bridge', payload: { opId: 'op-1' } }));

    const delivered = deviceSocket.frames().map((frame) => frame.type);
    expect(delivered).toEqual(['ack']);
  });

  it('drops a frame it cannot read instead of passing it on', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const { token } = await bridgeToken();

    const bridgeSocket = new FakeSocket();
    await session.registerSocket({ id: 'b1', role: 'bridge', subject: 'bridge-1', accountId: ACCOUNT, token, socket: bridgeSocket });
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: bridgeSocket };

    const deviceSocket = new FakeSocket();
    await session.registerSocket({
      id: 'd1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: deviceSocket,
    });

    // A frame with no type, or a type that is not a string, would make the client throw
    // when it reads `frame.type`. It is dropped instead of being passed on.
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f1', ts: 1, source: 'bridge', payload: {} }));
    session.handleFrame(peer, JSON.stringify({ v: 1, id: 'f2', ts: 2, type: 42, source: 'bridge', payload: {} }));

    expect(deviceSocket.frames()).toEqual([]);
  });

  it('flags truncation when a resuming device fell behind the buffer', async () => {
    const session = makeSession({ ringCapacity: 4 });
    const paired = await pair(session, 'device-1');
    const { token } = await bridgeToken();

    const bridgeSocket = new FakeSocket();
    await session.registerSocket({ id: 'b1', role: 'bridge', subject: 'bridge-1', accountId: ACCOUNT, token, socket: bridgeSocket });
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: bridgeSocket };

    for (let i = 0; i < 10; i += 1) {
      session.handleFrame(peer, JSON.stringify({ v: 1, id: `f${i}`, ts: i, type: 'evt.message_chunk', source: 'bridge', payload: {} }));
    }

    const resumed = new FakeSocket();
    const result = await session.registerSocket({
      id: 'd2',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket: resumed,
      lastSeq: 0,
    });

    if (!result.ok) throw new Error(`expected the device to be accepted: ${result.reason}`);
    expect(result.replay.truncated).toBe(true);
  });

  it('drops a device socket when it unregisters', async () => {
    const { session } = await connected();
    expect(session.deviceSocketCount).toBe(1);
    session.unregisterSocket('d1');
    expect(session.deviceSocketCount).toBe(0);
    expect((await session.status()).bridgeOnline).toBe(true);
  });

  it('marks the bridge offline when its socket unregisters', async () => {
    const { session } = await connected();
    session.unregisterSocket('b1');
    expect((await session.status()).bridgeOnline).toBe(false);
  });

  it('ignores a malformed frame from the bridge', async () => {
    const { session, deviceSocket } = await connected();
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

    session.handleFrame(peer, '{not json');
    expect(deviceSocket.sent).toHaveLength(0);
  });
});

describe('bridge token revocation', () => {
  /** A storage that keeps what a Durable Object's storage would keep. */
  function makeStorage() {
    const data = new Map<string, unknown>();
    return {
      data,
      async get<T>(key: string): Promise<T | undefined> {
        return data.get(key) as T | undefined;
      },
      async put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
        if (typeof key === 'string') {
          data.set(key, value);
          return;
        }
        // A multi-key write is one transaction, the way the Durable Object's
        // storage applies it.
        for (const [entryKey, entryValue] of Object.entries(key)) {
          data.set(entryKey, entryValue);
        }
      },
    };
  }

  async function attach(token: string, accountId = ACCOUNT) {
    const session = makeSession();
    const result = await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId,
      token,
      socket: new FakeSocket(),
    });
    return result;
  }

  it('refuses a bridge token that was revoked', async () => {
    const session = makeSession();
    const { token } = await bridgeToken();
    await session.revokeBridgeTokensBefore(Date.now() + 1_000);

    const result = await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token,
      socket: new FakeSocket(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CLOSE_CODE.unauthorized);
  });

  it('rotating issues a new token and kills the old one', async () => {
    const session = makeSession();
    const original = await bridgeToken();

    const rotated = await session.rotateBridgeToken('bridge-1', ACCOUNT);
    expect(rotated.token).not.toBe(original.token);

    // The old token is dead even though it is signed and unexpired.
    const old = await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token: original.token,
      socket: new FakeSocket(),
    });
    expect(old.ok).toBe(false);

    // The new one works.
    const fresh = await session.registerSocket({
      id: 'b2',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token: rotated.token,
      socket: new FakeSocket(),
    });
    expect(fresh.ok).toBe(true);
  });

  it('keeps a revocation across a restart', async () => {
    const storage = makeStorage();
    const before = makeSession({ storage });
    const { token } = await bridgeToken();
    await before.revokeBridgeTokensBefore(Date.now() + 1_000);

    // A new session over the same storage is a relay that was redeployed.
    const after = makeSession({ storage });
    const result = await after.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token,
      socket: new FakeSocket(),
    });

    expect(result.ok).toBe(false);
  });

  it('never revokes a device token', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    await session.revokeBridgeTokensBefore(Date.now() + 1_000);

    const result = await session.registerSocket({
      id: 'd1',
      role: 'device',
      subject: 'device-1',
      accountId: ACCOUNT,
      token: paired.deviceToken!,
      socket: new FakeSocket(),
    });

    expect(result.ok).toBe(true);
  });
});

describe('bridge ownership', () => {
  it('refuses a bridge token that was minted for another account', async () => {
    const session = makeSession();
    const { token } = await bridgeToken('bridge-1', 'acct-other');
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token,
      socket,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CLOSE_CODE.unauthorized);
    expect((await session.status()).bridgeOnline).toBe(false);
  });

  it('accepts a bridge token that was minted for this account', async () => {
    const session = makeSession();
    const { token } = await bridgeToken();
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token,
      socket,
    });

    expect(result.ok).toBe(true);
    expect((await session.status()).bridgeOnline).toBe(true);
  });

  it('refuses a foreign bridge on a room that already has an owner', async () => {
    const session = makeSession();
    await session.createPairingCode('bridge-1', 'Desk');
    const { token } = await bridgeToken('bridge-2');
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'b2',
      role: 'bridge',
      subject: 'bridge-2',
      accountId: ACCOUNT,
      token,
      socket,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(CLOSE_CODE.unauthorized);
    expect((await session.status()).bridgeOnline).toBe(false);
  });

  it('lets the owner back into the room it owns', async () => {
    const session = makeSession();
    await session.createPairingCode('bridge-1', 'Desk');
    const { token } = await bridgeToken();
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token,
      socket,
    });

    expect(result.ok).toBe(true);
    expect((await session.status()).bridgeOnline).toBe(true);
  });

  it('does not let a foreign bridge displace the owner', async () => {
    const session = makeSession();
    await session.createPairingCode('bridge-1', 'Desk');
    const { token: ownerToken } = await bridgeToken();
    const owner = new FakeSocket();
    await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token: ownerToken,
      socket: owner,
    });

    const { token: foreignToken } = await bridgeToken('bridge-2');
    const foreign = new FakeSocket();
    const result = await session.registerSocket({
      id: 'b2',
      role: 'bridge',
      subject: 'bridge-2',
      accountId: ACCOUNT,
      token: foreignToken,
      socket: foreign,
    });

    expect(result.ok).toBe(false);
    // The owner is still connected: the refusal happens before the eviction.
    expect(owner.closed).toBeNull();
    expect((await session.status()).bridgeOnline).toBe(true);
  });
});

describe('a ticket for a single connection', () => {
  it('lets a device in without the token in the URL', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const token = paired.deviceToken!;

    const ticket = await session.issueTicket('device-1', 'device', token, ACCOUNT);
    expect(ticket).toBeTruthy();

    const registered = await session.registerSocket({
      id: 'peer-1',
      role: 'device',
      subject: 'device-1',
      token: ticket!.ticket,
      socket: new FakeSocket(),
    });

    expect(registered.ok).toBe(true);
  });

  it('is good for one connection only', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const ticket = await session.issueTicket('device-1', 'device', paired.deviceToken!, ACCOUNT);

    const first = await session.registerSocket({
      id: 'peer-1',
      role: 'device',
      subject: 'device-1',
      token: ticket!.ticket,
      socket: new FakeSocket(),
    });
    const second = await session.registerSocket({
      id: 'peer-2',
      role: 'device',
      subject: 'device-1',
      token: ticket!.ticket,
      socket: new FakeSocket(),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('runs out', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const ticket = await session.issueTicket('device-1', 'device', paired.deviceToken!, ACCOUNT);

    // A ticket is good for half a minute, not for the life of the token.
    expect(ticket!.expiresAt - Date.now()).toBeLessThanOrEqual(30_000);
  });

  it('is not issued for a credential the room does not know', async () => {
    const session = makeSession();

    expect(await session.issueTicket('device-1', 'device', 'a-token', ACCOUNT)).toBeNull();
  });

  it('is not issued for a token that belongs to another device', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');

    expect(await session.issueTicket('device-2', 'device', paired.deviceToken!, ACCOUNT)).toBeNull();
  });

  it('does not let a device in that has been revoked', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    const ticket = await session.issueTicket('device-1', 'device', paired.deviceToken!, ACCOUNT);
    await session.revokeDevice('device-1');

    const registered = await session.registerSocket({
      id: 'peer-1',
      role: 'device',
      subject: 'device-1',
      token: ticket!.ticket,
      socket: new FakeSocket(),
    });

    expect(registered.ok).toBe(false);
  });

  it('lets the bridge in', async () => {
    const session = makeSession();
    const { code } = await session.createPairingCode('bridge-1', 'Desk');
    await session.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    const { token } = await bridgeToken();

    const ticket = await session.issueTicket('bridge-1', 'bridge', token, ACCOUNT);
    expect(ticket).toBeTruthy();

    const registered = await session.registerSocket({
      id: 'peer-b',
      role: 'bridge',
      subject: 'bridge-1',
      accountId: ACCOUNT,
      token: ticket!.ticket,
      socket: new FakeSocket(),
    });

    expect(registered.ok).toBe(true);
  });

  it('is not issued for a bridge token of another account', async () => {
    const session = makeSession();
    const { token } = await bridgeToken('bridge-1', 'another-account');

    expect(await session.issueTicket('bridge-1', 'bridge', token, ACCOUNT)).toBeNull();
  });
});
