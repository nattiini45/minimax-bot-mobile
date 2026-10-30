import { connectRelay, disconnectRelay, useAppStore } from '../src/state/store';

/**
 * What a phone keeps when the relay stops serving it.
 *
 * A revoked or replaced phone has to stop trying, and it has to give up its session:
 * the credential cannot work any more. The conversation the user has not had yet is a
 * different thing, and it is not thrown away with the session.
 */

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

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

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
  disconnectRelay();
});

describe('a phone the relay stops serving', () => {
  it('gives up its session but keeps the queued messages', async () => {
    // The relay offers a ticket, so the socket is opened.
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ticket: 'the-ticket' }),
    })) as unknown as typeof fetch;
    const sockets: FakeSocket[] = [];
    globalThis.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;

    const session = {
      relayUrl: 'https://relay.example.workers.dev',
      accountId: 'default',
      deviceId: 'device-1',
      deviceToken: 'the-device-token',
      deviceName: 'Phone',
    };
    useAppStore.setState({
      session,
      outbox: [
        {
          opId: 'op_1',
          type: 'op.send_message',
          payload: { chatId: 'bot:b1', text: 'hello' },
          queuedAt: Date.now(),
          accountId: 'default',
        },
      ],
    });

    connectRelay(session);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The relay says this phone was revoked, in its own close code. The connection
    // carried a ticket, so the phone tries the token once before it gives up - a room
    // that predates the ticket refuses a ticket the same way it refuses a credential
    // it does not accept.
    sockets[0]?.onclose?.({ code: 4003 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[1]?.onclose?.({ code: 4003 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = useAppStore.getState();
    // The session is gone: the credential cannot work.
    expect(state.session).toBeNull();
    // The reason is recorded.
    expect(state.lastError).toContain('Pair it again');
    // The queued message is not.
    expect(state.outbox).toHaveLength(1);
    expect(state.outbox[0]?.payload).toEqual({ chatId: 'bot:b1', text: 'hello' });
  });
});