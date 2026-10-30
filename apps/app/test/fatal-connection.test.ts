import { RelayClient } from '../src/net/relay-client';

/**
 * When the phone gives up.
 *
 * A revoked or replaced phone must stop trying, or it retries a credential the relay
 * has already refused, forever. But the decision to give up has to be the relay's: the
 * relay says "not this one" with a close code or with a status, and the phone has to
 * read that rather than guess it out of a message.
 */

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  readyState = 1;

  constructor(readonly url: string) {}

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

describe('a relay that refuses the phone', () => {
  it('is fatal when the relay says so with its own code', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, code: 'UNAUTHORIZED', message: 'The token is not valid.' }),
    })) as unknown as typeof fetch;
    const sockets: FakeSocket[] = [];
    globalThis.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;

    const fatal: number[] = [];
    const phone = new RelayClient({
      url: 'https://relay.example.workers.dev',
      accountId: 'default',
      deviceId: 'device-1',
      token: 'the-device-token',
      clientVersion: '0.1.0',
      onFatal: (code) => fatal.push(code),
    });

    phone.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fatal).toHaveLength(1);
    // No socket was opened: there was nothing to open it with.
    expect(sockets).toHaveLength(0);
  });

  it('is fatal when the relay closes the socket with the code for it', async () => {
    globalThis.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const sockets: FakeSocket[] = [];
    globalThis.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;

    const fatal: number[] = [];
    const phone = new RelayClient({
      url: 'https://relay.example.workers.dev',
      accountId: 'default',
      deviceId: 'device-1',
      token: 'the-device-token',
      clientVersion: '0.1.0',
      onFatal: (code) => fatal.push(code),
    });

    phone.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0]?.onclose?.({ code: 4001 });

    expect(fatal).toHaveLength(1);
  });
});

describe('a socket error', () => {
  it('is not a refusal, whatever the message says', async () => {
    // A relay that is unreachable, or a proxy that answers with an error of its own,
    // says things in its message that have nothing to do with the credential.
    globalThis.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    const sockets: FakeSocket[] = [];
    globalThis.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;

    const fatal: number[] = [];
    const phone = new RelayClient({
      url: 'https://relay.example.workers.dev',
      accountId: 'default',
      deviceId: 'device-1',
      token: 'the-device-token',
      clientVersion: '0.1.0',
      onFatal: (code) => fatal.push(code),
    });

    phone.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    sockets[0]?.onerror?.({ message: 'Unexpected response code: 401' });
    sockets[0]?.onclose?.({ code: 1006 });

    // The phone did not throw away its pairing because a message mentioned 401.
    expect(fatal).toHaveLength(0);
    expect(phone.connectionStatus).toBe('offline');

    // The phone is still trying, on a timer of its own.
    phone.disconnect();
  });
});
