import { createFrame } from '@minimax-bot/protocol';
import { RelayClient } from '../src/net/relay-client';

const originalFetch = global.fetch;
const originalSocket = global.WebSocket;
let sockets: Socket[];
class Socket {
  readyState = 0;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number }) => void;
  constructor(readonly url: string) { sockets.push(this); }
  send() {}
  close() { this.readyState = 3; }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}
function phone(onFrame = jest.fn(), onStatus = jest.fn()) {
  return new RelayClient({ url: 'https://relay.example', accountId: 'a', deviceId: 'd', token: 't', clientVersion: '1', onFrame, onStatus });
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  global.WebSocket = Socket as unknown as typeof WebSocket;
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ ticket: 'ticket' }) })) as unknown as typeof fetch;
});
afterEach(() => { jest.useRealTimers(); global.fetch = originalFetch; global.WebSocket = originalSocket; });

test('disconnected sockets cannot emit open/message/close effects', async () => {
  const frames = jest.fn(); const statuses = jest.fn();
  const client = phone(frames, statuses); client.connect(); await tick();
  const old = sockets[0]!;
  client.disconnect(); statuses.mockClear();
  old.onopen?.();
  old.deliver(createFrame({ type: 'evt.bridge_status', source: 'bridge', payload: {} }));
  old.onclose?.({ code: 1006 });
  expect(statuses).not.toHaveBeenCalled();
  expect(frames).not.toHaveBeenCalled();
  expect(client.connectionStatus).toBe('idle');
});

test.each(['fetch', 'body'])('ticket %s hangs are deadline bounded and aborted', async kind => {
  let signal: AbortSignal | undefined;
  global.fetch = jest.fn((_url, init) => {
    signal = init?.signal ?? undefined;
    return kind === 'fetch' ? new Promise(() => {}) : Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
  }) as unknown as typeof fetch;
  const client = phone(); client.connect();
  await jest.advanceTimersByTimeAsync(11000);
  expect(signal?.aborted).toBe(true);
  expect(sockets.length > 0 || client.connectionStatus === 'offline').toBe(true);
  client.disconnect();
});

test('disconnect aborts ticket I/O and late tickets cannot open a socket', async () => {
  let signal: AbortSignal | undefined; let finish!: (v: unknown) => void;
  global.fetch = jest.fn((_url, init) => { signal = init?.signal ?? undefined; return new Promise(resolve => { finish = resolve; }); }) as unknown as typeof fetch;
  const client = phone(); client.connect(); await tick(); client.disconnect();
  expect(signal?.aborted).toBe(true);
  finish({ ok: true, json: async () => ({ ticket: 'stale' }) }); await tick();
  expect(sockets).toHaveLength(0);
});

test('application failure never advances a resume cursor', async () => {
  const client = phone(jest.fn(() => { throw new Error('bad payload'); }));
  client.connect(); await tick();
  expect(() => sockets[0]!.deliver({ ...createFrame({ type: 'evt.message_committed', source: 'bridge', payload: {} }), seq: 1 })).not.toThrow();
  expect(client.resumePoint).toBe(0);
  client.disconnect();
});

test('a throwing native send is conservatively possible delivery, not permission to redispatch', async () => {
  const client = phone(); client.connect(); await tick();
  expect(client.request('op.forget', {})).toBe(false);
  const socket = sockets[0]!; socket.readyState = 1; socket.onopen?.();
  jest.spyOn(socket, 'send').mockImplementation(() => { throw new Error('native boundary failure'); });
  expect(client.request('op.forget', {})).toBe(true);
  client.disconnect();
});

test('overlapping connect calls ignore a stale ticket response', async () => {
  let finish!: (v: unknown) => void;
  global.fetch = jest.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ ok: true, json: async () => ({ ticket: 'new' }) });
  const client = phone(); client.connect(); client.connect(); await tick();
  finish({ ok: true, json: async () => ({ ticket: 'old' }) }); await tick();
  expect(sockets).toHaveLength(1);
  expect(sockets[0]!.url).toContain('ticket=new');
  client.disconnect();
});
