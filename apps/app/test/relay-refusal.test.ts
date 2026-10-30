import { RelayClient } from '../src/net/relay-client';

/**
 * What the relay says, and what the phone does about it.
 *
 * The relay refuses a credential with a close code, or with its own code in the body
 * of the ticket request. A room that predates the ticket refuses a ticket the same way
 * it refuses a credential it does not accept, so the phone tries the token once before
 * it gives the pairing up.
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

/**
 * Installs a fake WebSocket and a fetch that answers the ticket request.
 *
 * @param answer what the ticket request answers
 */
function withRelay(answer: { status: number; body?: unknown }) {
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const sockets: FakeSocket[] = [];

  globalThis.WebSocket = (
    class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
  ) as unknown as typeof WebSocket;

  globalThis.fetch = (async () => {
    if (answer.body === undefined) return new Response('', { status: answer.status });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    sockets,
    restore() {
      globalThis.WebSocket = originalWebSocket;
      globalThis.fetch = originalFetch;
    },
  };
}

function client(fatal: number[] = []) {
  return new RelayClient({
    url: 'https://relay.example.workers.dev',
    accountId: 'default',
    deviceId: 'device-1',
    token: 'the-device-token',
    clientVersion: '0.1.0',
    onFatal: (code) => fatal.push(code),
  });
}

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('a relay that refuses the credential', () => {
  it('is fatal when it says so with its own code', async () => {
    const { sockets, restore } = withRelay({
      status: 401,
      body: { ok: false, code: 'UNAUTHORIZED', message: 'The token is not valid.' },
    });
    try {
      const fatal: number[] = [];
      const phone = client(fatal);
      phone.connect();
      await settle();

      expect(fatal).toHaveLength(1);
      expect(sockets).toHaveLength(0);
      phone.disconnect();
    } finally {
      restore();
    }
  });

  it('is not fatal when the status comes from something in front of it', async () => {
    // A proxy in front of the relay answers 401 as well, and it says nothing about
    // the credential: the phone tries the token instead of throwing the pairing away.
    const { sockets, restore } = withRelay({ status: 401 });
    try {
      const fatal: number[] = [];
      const phone = client(fatal);
      phone.connect();
      await settle();

      expect(fatal).toHaveLength(0);
      // The connection was tried with the token instead.
      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.url).toContain('token=');
      phone.disconnect();
    } finally {
      restore();
    }
  });
});

describe('a room that does not know what a ticket is', () => {
  it('is tried once more with the token', async () => {
    const { sockets, restore } = withRelay({ status: 200, body: { ticket: 'the-ticket' } });
    try {
      const fatal: number[] = [];
      const phone = client(fatal);
      phone.connect();
      await settle();

      expect(sockets).toHaveLength(1);
      expect(sockets[0]?.url).toContain('ticket=');

      // The room refuses the ticket with the code it refuses a credential with.
      sockets[0]?.onclose?.({ code: 4001 });
      await settle();

      // The token is tried, because a room that predates the ticket does not know
      // what one is.
      expect(sockets).toHaveLength(2);
      expect(sockets[1]?.url).toContain('token=');
      expect(fatal).toHaveLength(0);

      // And when the token is refused too, the pairing is over.
      sockets[1]?.onclose?.({ code: 4001 });
      await settle();
      expect(fatal).toHaveLength(1);

      phone.disconnect();
    } finally {
      restore();
    }
  });

  it('gives the pairing up when the token is refused as well', async () => {
    const { sockets, restore } = withRelay({ status: 200, body: { ticket: 'the-ticket' } });
    try {
      const fatal: number[] = [];
      const phone = client(fatal);
      phone.connect();
      await settle();

      sockets[0]?.onclose?.({ code: 4003 });
      await settle();
      sockets[1]?.onclose?.({ code: 4003 });
      await settle();

      expect(fatal).toHaveLength(1);
      phone.disconnect();
    } finally {
      restore();
    }
  });
});
