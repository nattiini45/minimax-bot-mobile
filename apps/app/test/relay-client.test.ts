import type { Frame } from '@minimax-bot/protocol';

import { RelayClient } from '../src/net/relay-client';

/**
 * The phone's credential travels in the WebSocket URL, because the browser
 * WebSocket API cannot set a header.
 *
 * A ticket stands in for it: the phone asks for one over an ordinary request -
 * which can carry a header - and puts the ticket in the URL instead. The ticket
 * is good for one connection and for half a minute.
 */

/**
 * A socket the test drives by hand.
 *
 * The client only ever talks to a socket through these four handlers, so a
 * stand-in that records them is enough to play the part of the relay.
 */
class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  readyState = 1;

  constructor(readonly url: string) {}

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  /** Hands a frame to the client, the way the relay would. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

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

/**
 * The relay stamps every event with a number, and the phone keeps the last one
 * it saw so it can resume from there. If the relay's counter ever goes
 * backwards - because the relay lost its state and started again - the phone's
 * cursor sits above it, and every frame the relay sends next carries a number
 * below that cursor. The phone would drop all of them without a word, and the
 * conversation would simply stop arriving.
 */
describe('a relay whose counter was rewound', () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let sockets: FakeSocket[] = [];

  beforeEach(() => {
    sockets = [];
    // The relay offers no ticket, so the client opens the socket with the token.
    globalThis.fetch = jest.fn(async () => ({ ok: false })) as unknown as typeof fetch;
    globalThis.WebSocket = class extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    } as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  it('rewinds the phone and asks for a fresh view', async () => {
    const frames: Frame[] = [];
    const phone = new RelayClient({
      url: 'https://relay.example.workers.dev',
      accountId: 'default',
      deviceId: 'device-1',
      token: 'the-device-token',
      clientVersion: '0.1.0',
      onFrame: (frame) => frames.push(frame),
    });

    phone.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0];
    expect(socket).toBeTruthy();

    // The phone has seen events up to number 42.
    socket!.deliver({
      v: 1,
      id: 'f1',
      ts: 1,
      type: 'evt.message_chunk',
      source: 'relay',
      payload: {},
      seq: 42,
    });
    expect(phone.resumePoint).toBe(42);

    // The relay comes back with a counter behind the phone's cursor.
    socket!.deliver({
      v: 1,
      id: 'h1',
      ts: 2,
      type: 'hello.ok',
      source: 'relay',
      payload: { seq: 0, bridgeOnline: true, truncated: false },
    });

    // The phone rewinds with the relay...
    expect(phone.resumePoint).toBe(0);
    // ...is told its view has a hole, so the app rebuilds it...
    const hello = frames.find((frame) => frame.type === 'hello.ok');
    expect((hello?.payload as { truncated?: boolean }).truncated).toBe(true);
    // ...and the next frame is applied again instead of being dropped.
    socket!.deliver({
      v: 1,
      id: 'f2',
      ts: 3,
      type: 'evt.message_chunk',
      source: 'relay',
      payload: {},
      seq: 1,
    });
    expect(phone.resumePoint).toBe(1);
    expect(frames.filter((frame) => frame.type === 'evt.message_chunk')).toHaveLength(2);
  });

  it('leaves the cursor alone when the relay is where the phone left it', async () => {
    const frames: Frame[] = [];
    const phone = new RelayClient({
      url: 'https://relay.example.workers.dev',
      accountId: 'default',
      deviceId: 'device-1',
      token: 'the-device-token',
      clientVersion: '0.1.0',
      onFrame: (frame) => frames.push(frame),
    });

    phone.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const socket = sockets[0]!;

    socket.deliver({
      v: 1,
      id: 'f1',
      ts: 1,
      type: 'evt.message_chunk',
      source: 'relay',
      payload: {},
      seq: 42,
    });

    // The relay is exactly where the phone left it: nothing is missing, so the
    // phone must not be told to rebuild a view that is complete.
    socket.deliver({
      v: 1,
      id: 'h1',
      ts: 2,
      type: 'hello.ok',
      source: 'relay',
      payload: { seq: 42, bridgeOnline: true, truncated: false },
    });

    expect(phone.resumePoint).toBe(42);
    const hello = frames.find((frame) => frame.type === 'hello.ok');
    expect((hello?.payload as { truncated?: boolean }).truncated).toBe(false);
  });
});
