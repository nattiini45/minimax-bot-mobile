import { describe, expect, it, vi } from 'vitest';

import { issueToken } from '@minimax-bot/protocol';

import worker from '../src/index.js';

/**
 * The Worker's routes.
 *
 * The Worker is a front door: it decides what a request may do before the room
 * sees it. The routes that hand out or take away credentials are the ones worth
 * pinning down here.
 */

const SECRET = 'test-secret-value';
const ACCOUNT = 'acct-1';

/**
 * The Durable Object the Worker forwards to.
 *
 * Only the calls the routes make are here; anything else is a mistake in the
 * route and shows up as a test failure.
 */
function fakeStub(overrides: Record<string, unknown> = {}) {
  return {
    createPairingCode: vi.fn(async () => ({ code: '123456', expiresAt: 0 })),
    pairDevice: vi.fn(async () => ({ ok: true, deviceToken: 'device-token', expiresAt: 0 })),
    listDevices: vi.fn(async () => [{ deviceId: 'device-1', deviceName: 'Phone', token: 'secret' }]),
    revokeDevice: vi.fn(async () => true),
    releaseDevice: vi.fn(async () => true),
    issueTicket: vi.fn(async () => ({ ticket: 'the-ticket', expiresAt: 0 })),
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    isBridgeTokenRevoked: vi.fn(async () => false),
    ownerBridgeId: vi.fn(async () => 'bridge-1'),
    rotateBridgeToken: vi.fn(async () => ({ token: 'rotated', expiresAt: 0 })),
    revokeBridgeTokensBefore: vi.fn(async () => undefined),
    ...overrides,
  };
}

function envWith(stub: ReturnType<typeof fakeStub>) {
  return {
    RELAY_SECRET: SECRET,
    RELAY: { getByName: () => stub },
  } as never;
}

async function deviceToken(deviceId = 'device-1') {
  const { token } = await issueToken(deviceId, 'device', 60_000, SECRET);
  return token;
}

async function bridgeToken(bridgeId = 'bridge-1') {
  const { token } = await issueToken(bridgeId, 'bridge', 60_000, SECRET, { accountId: ACCOUNT });
  return token;
}

describe('a phone releasing its own token', () => {
  it('releases the device the token names', async () => {
    const stub = fakeStub();
    const token = await deviceToken('device-1');

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices/me`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(200);
    expect(stub.releaseDevice).toHaveBeenCalledWith('device-1', token);
  });

  it('refuses a bridge token', async () => {
    // A bridge may revoke a device, but it does that through the bridge route.
    // The `me` route is for a device releasing itself, and a bridge token is not
    // a device token.
    const stub = fakeStub();
    const token = await bridgeToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices/me`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(401);
    expect(stub.releaseDevice).not.toHaveBeenCalled();
  });

  it('refuses a token the room does not know', async () => {
    const stub = fakeStub({ releaseDevice: vi.fn(async () => false) });
    const token = await deviceToken('device-1');

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices/me`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(401);
  });

  it('refuses a request without a token', async () => {
    const stub = fakeStub();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices/me`, { method: 'DELETE' }),
      envWith(stub),
    );

    expect(response.status).toBe(401);
    expect(stub.releaseDevice).not.toHaveBeenCalled();
  });
});

describe('the device list', () => {
  it('is answered without a device id in the path', async () => {
    // The desktop asks for the list of the account's devices, and the list is
    // the account's - the path names no device.
    const stub = fakeStub();
    const token = await bridgeToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(200);
    expect(stub.listDevices).toHaveBeenCalled();
  });

  it('never hands the device tokens back', async () => {
    const stub = fakeStub();
    const token = await bridgeToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    const body = await response.text();
    expect(body).not.toContain('secret');
  });

  it('is bridge-only', async () => {
    const stub = fakeStub();
    const token = await deviceToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices`, {
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(401);
    expect(stub.listDevices).not.toHaveBeenCalled();
  });
});

describe('a peer asking for a ticket', () => {
  it('gets one for its device', async () => {
    const stub = fakeStub();
    const token = await deviceToken('device-1');

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ticket?: string };
    expect(body.ticket).toBe('the-ticket');
    // The room decides, and it is told which credential the ticket stands for.
    expect(stub.issueTicket).toHaveBeenCalledWith('device-1', 'device', token, ACCOUNT);
  });

  it('gets one for its bridge', async () => {
    const stub = fakeStub();
    const token = await bridgeToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(200);
    expect(stub.issueTicket).toHaveBeenCalledWith('bridge-1', 'bridge', token, ACCOUNT);
  });

  it('is refused without a token', async () => {
    const stub = fakeStub();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/ws-ticket`, { method: 'POST' }),
      envWith(stub),
    );

    expect(response.status).toBe(401);
    expect(stub.issueTicket).not.toHaveBeenCalled();
  });

  it('is refused when the room does not know the credential', async () => {
    const stub = fakeStub({ issueTicket: vi.fn(async () => null) });
    const token = await deviceToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(401);
  });
});

describe('the WebSocket upgrade', () => {
  it('accepts a ticket in place of the token', async () => {
    const stub = fakeStub();
    const { token } = await issueToken('device-1', 'device', 60_000, SECRET, { ticket: true });

    const response = await worker.fetch(
      new Request(
        `https://relay.example/r/${ACCOUNT}/ws?role=device&subject=device-1&ticket=${encodeURIComponent(token)}`,
      ),
      envWith(stub),
    );

    expect(response.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalled();
  });

  it('refuses a ticket that is not one', async () => {
    const stub = fakeStub();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/ws?role=device&subject=device-1&ticket=nonsense`),
      envWith(stub),
    );

    expect(response.status).toBe(401);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe('the bridge revoking a device', () => {
  it('revokes the device the path names', async () => {
    const stub = fakeStub();
    const token = await bridgeToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices/device-1`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(200);
    expect(stub.revokeDevice).toHaveBeenCalledWith('device-1');
  });

  it('is not a route a device can use', async () => {
    const stub = fakeStub();
    const token = await deviceToken();

    const response = await worker.fetch(
      new Request(`https://relay.example/r/${ACCOUNT}/devices/device-1`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
      envWith(stub),
    );

    expect(response.status).toBe(401);
    expect(stub.revokeDevice).not.toHaveBeenCalled();
  });
});
