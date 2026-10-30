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

    const outcome = await (
      client() as unknown as { fetchTicket(): Promise<{ kind: string; ticket?: string }> }
    ).fetchTicket();

    expect(outcome).toEqual({ kind: 'ticket', ticket: 'the-ticket' });
    expect(seen[0]?.url).toBe('https://relay.example.workers.dev/r/default/ws-ticket');
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer the-device-token',
    );
  });

  it('is not fatal when the relay does not offer one', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('offline');
    });

    const outcome = await (
      client() as unknown as { fetchTicket(): Promise<{ kind: string }> }
    ).fetchTicket();

    expect(outcome).toEqual({ kind: 'none' });
  });

  it('is a refusal when the relay says so with a status', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;

    const outcome = await (
      client() as unknown as { fetchTicket(): Promise<{ kind: string }> }
    ).fetchTicket();

    expect(outcome).toEqual({ kind: 'refused', code: 'UNAUTHORIZED' });
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

  it('rebuilds its view when the relay skips a number', async () => {
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

    // The relay says it could replay everything, so the phone's cursor and the
    // relay's counter agree - and it replays the frames the phone missed.
    socket.deliver({
      v: 1,
      id: 'h1',
      ts: 1,
      type: 'hello.ok',
      source: 'relay',
      payload: { seq: 2, bridgeOnline: true, truncated: false },
    });
    for (const seq of [1, 2]) {
      socket.deliver({
        v: 1,
        id: `f${seq}`,
        ts: seq + 1,
        type: 'evt.message_chunk',
        source: 'relay',
        payload: {},
        seq,
      });
    }

    // Then the relay's numbers jump: frame 4 never arrives. The phone cannot
    // get it back - the relay's replay buffer only covers the frames around its
    // own counter - so it rebuilds its view rather than carry on with a hole.
    socket.deliver({
      v: 1,
      id: 'f5',
      ts: 9,
      type: 'evt.message_chunk',
      source: 'relay',
      payload: {},
      seq: 5,
    });

    const hellos = frames.filter((frame) => frame.type === 'hello.ok');
    expect(hellos.map((f) => JSON.stringify(f.payload))).toEqual([
      '{"seq":2,"bridgeOnline":true,"truncated":false}',
      '{"seq":5,"bridgeOnline":true,"truncated":true}',
    ]);
    expect(phone.resumePoint).toBe(5);
  });

  it('does not rebuild its view when the relay said it could not replay', async () => {
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

    // The relay could not replay everything the phone missed, so the first
    // frame after the hello jumps - and that jump is the one the relay already
    // told the phone about.
    socket.deliver({
      v: 1,
      id: 'h1',
      ts: 1,
      type: 'hello.ok',
      source: 'relay',
      payload: { seq: 40, bridgeOnline: true, truncated: true },
    });
    socket.deliver({
      v: 1,
      id: 'f1',
      ts: 2,
      type: 'evt.message_chunk',
      source: 'relay',
      payload: {},
      seq: 41,
    });

    const hellos = frames.filter((frame) => frame.type === 'hello.ok');
    expect(hellos.length).toBe(1);
    expect(phone.resumePoint).toBe(41);
  });
});
