import { describe, expect, it } from 'vitest';

import { issueToken } from '@minimax-bot/protocol';

import { RelaySession, type SocketLike } from '../src/session.js';

/**
 * What the relay accepts from a peer.
 *
 * The protocol package ships one validator, and it is the contract the three
 * runtimes share. The relay is a router: it does not read payloads, but it
 * routes by type, it owns the order, and the bridge identifies an operation by
 * its id - so the envelope is exactly the part of a frame the relay has to be
 * able to trust.
 *
 * A peer that is not trusted with that is a peer that can say where its frame
 * belongs in the order. The phone takes the relay's number as the order, so a
 * peer-set number moves the phone's cursor, and every frame that follows is
 * discarded as one the phone has already seen.
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

/** A room with a desktop and a phone attached. */
async function connected() {
  const session = new RelaySession({ secret: SECRET });
  const { code } = await session.createPairingCode('bridge-1', 'Desk');
  const paired = await session.pairDevice(code, 'device-1', 'Phone', '1.0.0');

  const deviceSocket = new FakeSocket();
  await session.registerSocket({
    id: 'd1',
    role: 'device',
    subject: 'device-1',
    token: paired.deviceToken!,
    socket: deviceSocket,
  });

  const { token } = await issueToken('bridge-1', 'bridge', 60_000, SECRET, { accountId: ACCOUNT });
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

const DEVICE_PEER = { id: 'd1', role: 'device' as const, subject: 'device-1', socket: new FakeSocket() };
const BRIDGE_PEER = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

/** A frame that satisfies the contract. */
function frame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    id: 'f1',
    ts: 1,
    type: 'op.list_team',
    source: 'app',
    payload: {},
    ...overrides,
  });
}

describe('a frame the relay accepts', () => {
  it('forwards a well-formed frame from a phone to the desktop', async () => {
    const { session, bridgeSocket } = await connected();

    session.handleFrame(DEVICE_PEER, frame());

    expect(bridgeSocket.sent).toHaveLength(1);
    const forwarded = JSON.parse(bridgeSocket.sent[0]!);
    expect(forwarded.type).toBe('op.list_team');
    expect(forwarded.from).toBe('device-1');
  });

  it('stamps an event from the desktop with its own number', async () => {
    const { session, deviceSocket } = await connected();

    session.handleFrame(
      BRIDGE_PEER,
      frame({ type: 'evt.team_snapshot', source: 'bridge' }),
    );

    expect(JSON.parse(deviceSocket.sent[0]!).seq).toBe(1);
  });
});

describe('a frame the contract does not allow', () => {
  it('is not forwarded from a phone to the desktop', async () => {
    const { session, bridgeSocket } = await connected();

    // No id: the bridge identifies an operation by it.
    session.handleFrame(DEVICE_PEER, frame({ id: undefined }));

    expect(bridgeSocket.sent).toEqual([]);
  });

  it('is not forwarded from a phone when it has no payload', async () => {
    const { session, bridgeSocket } = await connected();

    session.handleFrame(DEVICE_PEER, frame({ payload: undefined }));

    expect(bridgeSocket.sent).toEqual([]);
  });

  it('is not forwarded from a phone when its source is not a role', async () => {
    const { session, bridgeSocket } = await connected();

    session.handleFrame(DEVICE_PEER, frame({ source: 'nobody' }));

    expect(bridgeSocket.sent).toEqual([]);
  });

  it('is not forwarded from a phone when it speaks another protocol version', async () => {
    const { session, bridgeSocket } = await connected();

    session.handleFrame(DEVICE_PEER, frame({ v: 2 }));

    expect(bridgeSocket.sent).toEqual([]);
  });

  it('is not forwarded from a phone when its idempotency key is not a string', async () => {
    const { session, bridgeSocket } = await connected();

    session.handleFrame(DEVICE_PEER, frame({ opId: 7 }));

    expect(bridgeSocket.sent).toEqual([]);
  });

  it('is not delivered to a phone when the desktop sends one', async () => {
    const { session, deviceSocket } = await connected();

    session.handleFrame(BRIDGE_PEER, frame({ type: 'evt.team_snapshot', source: 'bridge', id: '' }));

    expect(deviceSocket.sent).toEqual([]);
  });
});

describe('the sender belongs to the relay', () => {
  it('is named on a frame on its way to the desktop', async () => {
    const { session, bridgeSocket } = await connected();

    session.handleFrame(DEVICE_PEER, frame());

    // The desktop has to know which phone sent the frame: a permission decision
    // is only worth recording if the record says who made it, and the relay is
    // the only thing that knows which socket the frame came from.
    const forwarded = JSON.parse(bridgeSocket.sent[0]!);
    expect(forwarded.from).toBe('device-1');
    // The rest of the frame is untouched.
    expect(forwarded.type).toBe('op.list_team');
    expect(forwarded.payload).toEqual({});
  });

  it('is not taken from a phone', async () => {
    const { session, bridgeSocket } = await connected();

    // A phone that names the sender is a phone claiming to be another phone.
    session.handleFrame(DEVICE_PEER, frame({ from: 'someone-else' }));

    expect(bridgeSocket.sent).toEqual([]);
  });
});

describe('the sequence belongs to the relay', () => {
  it('is not taken from a phone', async () => {
    const { session, bridgeSocket } = await connected();

    session.handleFrame(DEVICE_PEER, frame({ seq: 999_999 }));

    expect(bridgeSocket.sent).toEqual([]);
  });

  it('is not taken from the desktop through a control frame', async () => {
    const { session, deviceSocket } = await connected();

    // A control frame is forwarded exactly as it arrived. A number on it would
    // reach the phone, and the phone takes a number as its place in the order -
    // so every frame after it would be discarded as one it had already seen.
    session.handleFrame(
      BRIDGE_PEER,
      frame({ type: 'ack', source: 'bridge', seq: 999_999 }),
    );

    expect(deviceSocket.sent).toEqual([]);
    expect(session.lastSeq).toBe(0);
  });

  it('does not move the counter when the desktop sends one', async () => {
    const { session, deviceSocket } = await connected();

    session.handleFrame(
      BRIDGE_PEER,
      frame({ type: 'evt.team_snapshot', source: 'bridge', seq: 999_999 }),
    );

    expect(deviceSocket.sent).toEqual([]);
    expect(session.lastSeq).toBe(0);
  });
});
