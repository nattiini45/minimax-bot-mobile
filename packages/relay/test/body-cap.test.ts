import { describe, expect, it, vi } from 'vitest';

import worker from '../src/index.js';

/**
 * The pairing route.
 *
 * It is the one route that answers without a credential: the six digit code is the
 * credential. Two things have to hold there. The body has to be bounded, because a
 * caller that is not the owner can send one; and the attempts have to be budgeted,
 * because the code space is small.
 */

const SECRET = 'test-secret-value';
const ACCOUNT = 'acct-1';

function fakeStub(overrides: Record<string, unknown> = {}) {
  return {
    createPairingCode: vi.fn(async () => ({ code: '123456', expiresAt: 0 })),
    pairDevice: vi.fn(async () => ({ ok: true, deviceToken: 'device-token', expiresAt: 0 })),
    listDevices: vi.fn(async () => []),
    revokeDevice: vi.fn(async () => true),
    releaseDevice: vi.fn(async () => true),
    status: vi.fn(async () => ({ bridgeOnline: true, deviceCount: 0, activeDevices: 0, lastSeq: 0 })),
    authorizesDevice: vi.fn(async () => true),
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

/** A pairing request whose body is `size` bytes of text. */
function pairingRequest(size: number) {
  return new Request(`https://relay.example/r/${ACCOUNT}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '123456', deviceId: 'device-1', filler: 'x'.repeat(size) }),
  });
}

describe('the pairing body', () => {
  it('is refused with 413 when it is larger than the relay reads', async () => {
    const stub = fakeStub();
    const response = await worker.fetch(pairingRequest(64 * 1024), envWith(stub));

    expect(response.status).toBe(413);
    // The body was refused before it was read, so the room never saw the attempt.
    expect(stub.pairDevice).not.toHaveBeenCalled();
  });

  it('is refused with 413 when it does not declare its length', async () => {
    const stub = fakeStub();
    // A body that understates or omits its length is refused by the bounded read.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)));
        controller.close();
      },
    });
    const request = new Request(`https://relay.example/r/${ACCOUNT}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error - the fetch standard asks for this on a streaming body.
      duplex: 'half',
    });
    request.headers.delete('content-length');

    const response = await worker.fetch(request, envWith(stub));

    expect(response.status).toBe(413);
    expect(stub.pairDevice).not.toHaveBeenCalled();
  });

  it('is read when it is small enough', async () => {
    const stub = fakeStub();
    const response = await worker.fetch(pairingRequest(64), envWith(stub));

    expect(response.status).toBe(200);
    expect(stub.pairDevice).toHaveBeenCalledTimes(1);
  });
});
