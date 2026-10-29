import { RelayClient } from '../src/net/relay-client';

/**
 * The phone's credential travels in the WebSocket URL, because the browser
 * WebSocket API cannot set a header.
 *
 * A ticket stands in for it: the phone asks for one over an ordinary request -
 * which can carry a header - and puts the ticket in the URL instead. The ticket
 * is good for one connection and for half a minute.
 */

function client() {
  return new RelayClient({
    url: 'https://relay.example.workers.dev',
    accountId: 'default',
    deviceId: 'device-1',
    token: 'the-device-token',
    clientVersion: '0.1.0',
  });
}

describe('the connection address', () => {
  it('carries a ticket instead of the token when there is one', () => {
    const url = new URL(client().endpoint('the-ticket'));

    expect(url.searchParams.get('ticket')).toBe('the-ticket');
    // The token itself does not travel in the URL.
    expect(url.searchParams.get('token')).toBeNull();
    expect(url.searchParams.get('role')).toBe('device');
    expect(url.searchParams.get('subject')).toBe('device-1');
  });

  it('carries the token when there is no ticket', () => {
    const url = new URL(client().endpoint(null));

    expect(url.searchParams.get('token')).toBe('the-device-token');
    expect(url.searchParams.get('ticket')).toBeNull();
  });
});

describe('asking for a ticket', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('goes to the relay with the token in a header', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    global.fetch = jest.fn(async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return {
        ok: true,
        json: async () => ({ ticket: 'the-ticket' }),
      } as Response;
    }) as unknown as typeof fetch;

    const ticket = await (client() as unknown as { fetchTicket(): Promise<string | null> }).fetchTicket();

    expect(ticket).toBe('the-ticket');
    expect(seen[0]?.url).toBe('https://relay.example.workers.dev/r/default/ws-ticket');
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer the-device-token',
    );
  });

  it('is not fatal when the relay does not offer one', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('offline');
    });

    const ticket = await (client() as unknown as { fetchTicket(): Promise<string | null> }).fetchTicket();

    expect(ticket).toBeNull();
  });
});
