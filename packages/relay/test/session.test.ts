import { describe, expect, it } from 'vitest';

import { issueToken, signToken, verifyToken } from '../src/auth.js';
import { RelaySession, type SessionOptions, type SocketLike } from '../src/session.js';

const SECRET = 'test-secret-value';

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
  const { code } = session.createPairingCode('bridge-1', 'Desk');
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
    const { code } = session.createPairingCode('bridge-1', 'Desk');
    expect(code).toMatch(/^\d{6}$/);

    const result = await session.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    expect(result.ok).toBe(true);
    expect(result.deviceToken).toBeTruthy();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('consumes the code so it cannot be reused', async () => {
    const session = makeSession();
    const { code } = session.createPairingCode('bridge-1', 'Desk');
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
    const { code, expiresAt } = session.createPairingCode('bridge-1', 'Desk');
    expect(expiresAt).toBeGreaterThan(now);

    now += 120_000;
    const result = await session.pairDevice(code, 'device-1', 'Phone', '1.0.0');
    expect(result.ok).toBe(false);
    expect(result.code).toBe('PAIRING_CODE_EXPIRED');
  });

  it('lists paired devices and revokes them', async () => {
    const session = makeSession();
    await pair(session, 'device-1');
    expect(session.listDevices()).toHaveLength(1);

    expect(session.revokeDevice('device-1')).toBe(true);
    expect(session.listDevices()[0]?.revoked).toBe(true);
    expect(session.revokeDevice('nope')).toBe(false);
  });
});

describe('socket registration', () => {
  it('rejects a device with a bad token and closes the socket', async () => {
    const session = makeSession();
    const socket = new FakeSocket();

    const result = await session.registerSocket({
      id: 'p1',
      role: 'device',
      subject: 'device-1',
      token: 'garbage',
      socket,
    });

    expect(result).toBeNull();
    expect(socket.closed?.code).toBe(4001);
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

    expect(result).toBeNull();
    expect(socket.closed?.code).toBe(4001);
  });

  it('rejects a revoked device', async () => {
    const session = makeSession();
    const paired = await pair(session, 'device-1');
    session.revokeDevice('device-1');

    const socket = new FakeSocket();
    const result = await session.registerSocket({
      id: 'p1',
      role: 'device',
      subject: 'device-1',
      token: paired.deviceToken!,
      socket,
    });

    expect(result).toBeNull();
    expect(socket.closed?.code).toBe(4003);
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

    expect(result).not.toBeNull();
    expect(session.deviceSocketCount).toBe(1);
  });

  it('replaces an older bridge socket when a new bridge connects', async () => {
    const session = makeSession();
    const { token } = await issueToken('bridge-1', 'bridge', 60_000, SECRET);
    const first = new FakeSocket();
    const second = new FakeSocket();

    await session.registerSocket({ id: 'p1', role: 'bridge', subject: 'bridge-1', token, socket: first });
    await session.registerSocket({ id: 'p2', role: 'bridge', subject: 'bridge-1', token, socket: second });

    expect(first.closed?.code).toBe(4000);
    expect(session.status().bridgeOnline).toBe(true);
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

    const { token } = await issueToken('bridge-1', 'bridge', 60_000, SECRET);
    const bridgeSocket = new FakeSocket();
    await session.registerSocket({
      id: 'b1',
      role: 'bridge',
      subject: 'bridge-1',
      token,
      socket: bridgeSocket,
    });

    return { session, deviceSocket, bridgeSocket };
  }

  it('forwards a device frame to the bridge verbatim', async () => {
    const { session, bridgeSocket } = await connected();
    const raw = JSON.stringify({ v: 1, id: 'f1', ts: 1, type: 'op.list_team', source: 'app', payload: {} });

    session.handleFrame(
      { id: 'd1', role: 'device', subject: 'device-1', socket: new FakeSocket() },
      raw,
    );

    expect(bridgeSocket.sent).toEqual([raw]);
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
    const { token } = await issueToken('bridge-1', 'bridge', 60_000, SECRET);

    const bridgeSocket = new FakeSocket();
    await session.registerSocket({ id: 'b1', role: 'bridge', subject: 'bridge-1', token, socket: bridgeSocket });
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

    expect(result?.replay.truncated).toBe(false);
    expect(result?.replay.entries.map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it('flags truncation when a resuming device fell behind the buffer', async () => {
    const session = makeSession({ ringCapacity: 4 });
    const paired = await pair(session, 'device-1');
    const { token } = await issueToken('bridge-1', 'bridge', 60_000, SECRET);

    const bridgeSocket = new FakeSocket();
    await session.registerSocket({ id: 'b1', role: 'bridge', subject: 'bridge-1', token, socket: bridgeSocket });
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

    expect(result?.replay.truncated).toBe(true);
  });

  it('drops a device socket when it unregisters', async () => {
    const { session } = await connected();
    expect(session.deviceSocketCount).toBe(1);
    session.unregisterSocket('d1');
    expect(session.deviceSocketCount).toBe(0);
    expect(session.status().bridgeOnline).toBe(true);
  });

  it('marks the bridge offline when its socket unregisters', async () => {
    const { session } = await connected();
    session.unregisterSocket('b1');
    expect(session.status().bridgeOnline).toBe(false);
  });

  it('ignores a malformed frame from the bridge', async () => {
    const { session, deviceSocket } = await connected();
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

    session.handleFrame(peer, '{not json');
    expect(deviceSocket.sent).toHaveLength(0);
  });
});
