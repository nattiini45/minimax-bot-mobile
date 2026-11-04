import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from '@minimax-bot/protocol';
import { isBridgeTokenForAccount } from '../src/authorize.js';
import { RelaySession, type SocketLike } from '../src/session.js';

const SECRET = 'local-auth-boundary-test-secret';
class Socket implements SocketLike {
  sent: string[] = [];
  closed = false;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
}
async function pair(session: RelaySession, deviceId = 'phone-1') {
  const { code } = await session.createPairingCode('desktop-1', 'Desktop');
  const paired = await session.pairDevice(code, deviceId, 'Phone', 'test');
  expect(paired.ok).toBe(true);
  return paired.deviceToken!;
}
async function attachBridge(session: RelaySession, accountId = 'account-a') {
  const socket = new Socket();
  const { token } = await issueToken('desktop-1', 'bridge', 60_000, SECRET, { accountId });
  const peer = { id: 'bridge-socket', role: 'bridge' as const, subject: 'desktop-1', socket };
  expect((await session.registerSocket({ ...peer, accountId, token })).ok).toBe(true);
  return { peer, socket, token };
}

describe('local credential and connection boundaries', () => {
  it('a device connection ticket for one account is refused by another account', async () => {
    const a = new RelaySession({ secret: SECRET });
    const b = new RelaySession({ secret: SECRET });
    const tokenA = await pair(a);
    await pair(b);
    const issued = await a.issueTicket('phone-1', 'device', tokenA, 'account-a');
    expect(issued).not.toBeNull();
    const result = await b.registerSocket({
      id: 'phone-socket', role: 'device', subject: 'phone-1', socket: new Socket(),
      token: issued!.ticket, accountId: 'account-b',
    });
    expect(result.ok).toBe(false);
  });

  it('a connection-only bridge ticket is not a bridge-management credential', async () => {
    const { token } = await issueToken('desktop-1', 'bridge', 30_000, SECRET, {
      accountId: 'account-a', ticket: true,
    });
    expect(isBridgeTokenForAccount(await verifyToken(token, SECRET), 'account-a')).toBe(false);
  });

  it('a connection-only ticket cannot mint another connection ticket', async () => {
    const session = new RelaySession({ secret: SECRET });
    const { token } = await issueToken('desktop-1', 'bridge', 60_000, SECRET, { accountId: 'account-a' });
    const ticket = await session.issueTicket('desktop-1', 'bridge', token, 'account-a');
    expect(ticket).not.toBeNull();
    expect(await session.issueTicket('desktop-1', 'bridge', ticket!.ticket, 'account-a')).toBeNull();
  });

  it('revoking an active bridge credential closes it and stops further delivery', async () => {
    const session = new RelaySession({ secret: SECRET });
    const { socket, peer } = await attachBridge(session);
    const deviceToken = await pair(session);
    const phone = new Socket();
    expect((await session.registerSocket({ id: 'phone-socket', role: 'device', subject: 'phone-1', token: deviceToken, socket: phone })).ok).toBe(true);
    await session.revokeBridgeTokensBefore(Date.now() + 1);
    session.handleFrame(peer, JSON.stringify({
      v: 1, id: 'after-revocation', ts: Date.now(), source: 'bridge',
      type: 'evt.team_snapshot', payload: { bots: [], groups: [] },
    }));
    expect(socket.closed).toBe(true);
    expect(session.bridgeOnline).toBe(false);
    expect(phone.sent).toEqual([]);
  });

  it('relay-stamped sender text preserves every character of an accepted device ID', async () => {
    const session = new RelaySession({ secret: SECRET });
    const { socket } = await attachBridge(session);
    const deviceId = 'phone-$1';
    const token = await pair(session, deviceId);
    const peer = { id: 'phone-socket', role: 'device' as const, subject: deviceId, socket: new Socket() };
    expect((await session.registerSocket({ ...peer, token })).ok).toBe(true);
    session.handleFrame(peer, JSON.stringify({
      v: 1, id: 'operation-1', ts: Date.now(), source: 'app', type: 'op.list_team', payload: {},
    }));
    expect(JSON.parse(socket.sent.at(-1)!).from).toBe(deviceId);
  });
});
