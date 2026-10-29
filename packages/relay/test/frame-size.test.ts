import { describe, expect, it } from 'vitest';

import { issueToken } from '@minimax-bot/protocol';

import { RelaySession, type SocketLike } from '../src/session.js';

/**
 * The size of a frame.
 *
 * The relay buffers the frames a bridge sends so that a phone can resume where it
 * stopped. The buffer's entry count is bounded, but a frame is whatever the sender
 * produced, so a single frame that is kept stays resident until enough later frames
 * push it out. The size is therefore checked on the way in.
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

describe('a frame that is too large', () => {
  it('is dropped rather than buffered', async () => {
    const { session, deviceSocket } = await connected();
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

    // A frame that is larger than the relay accepts.
    const raw = JSON.stringify({
      v: 1,
      id: 'f1',
      ts: 1,
      type: 'evt.team_snapshot',
      source: 'bridge',
      payload: { filler: 'x'.repeat(300 * 1024) },
    });

    session.handleFrame(peer, raw);

    // Nothing was buffered, nothing was sent, and the sequence counter did not move.
    expect(deviceSocket.sent).toHaveLength(0);
    expect(session.lastSeq).toBe(0);
  });

  it('is dropped when it is large in bytes but not in characters', async () => {
    const { session, deviceSocket } = await connected();
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

    // These characters are three bytes each on the wire, so the frame is over the cap
    // even though it has fewer characters than the cap.
    const raw = JSON.stringify({
      v: 1,
      id: 'f1',
      ts: 1,
      type: 'evt.team_snapshot',
      source: 'bridge',
      payload: { filler: '\u4f60'.repeat(100 * 1024) },
    });

    session.handleFrame(peer, raw);

    expect(deviceSocket.sent).toHaveLength(0);
    expect(session.lastSeq).toBe(0);
  });

  it('is accepted when it is within the cap', async () => {
    const { session, deviceSocket } = await connected();
    const peer = { id: 'b1', role: 'bridge' as const, subject: 'bridge-1', socket: new FakeSocket() };

    const raw = JSON.stringify({
      v: 1,
      id: 'f1',
      ts: 1,
      type: 'evt.team_snapshot',
      source: 'bridge',
      payload: { filler: 'x'.repeat(1024) },
    });

    session.handleFrame(peer, raw);

    expect(deviceSocket.sent).toHaveLength(1);
    expect(session.lastSeq).toBe(1);
  });
});
