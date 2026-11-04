import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { issueToken, verifyToken } from '@minimax-bot/protocol';

import worker from '../src/index.js';
import { Relay } from '../src/relay.js';
import { RelaySession, type SessionStorage } from '../src/session.js';

const SECRET = 'worker-boundary-test-secret';

// Exercise the actual Worker and DO adapter. Closing deliberately does not emit
// a close event: authorization must end before the transport reports its close.
class TestSocket extends EventTarget {
  sent: string[] = [];
  closed = false;
  onClose?: () => void;
  accept() {}
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.onClose?.(); }
  message(frame: object | string) {
    const event = new Event('message');
    Object.defineProperty(event, 'data', { value: typeof frame === 'string' ? frame : JSON.stringify(frame) });
    this.dispatchEvent(event);
  }
}

const pairs: Array<{ 0: TestSocket; 1: TestSocket }> = [];
const NativeResponse = Response;
class UpgradeResponse extends NativeResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: TestSocket }) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    if (init?.status === 101) Object.defineProperty(this, 'status', { value: 101 });
  }
}

function setup(beforePut?: (key: string) => Promise<void>, beforeRpc?: (method: string) => Promise<void>) {
  const rooms = new Map<string, Relay>();
  const env = {
    RELAY_SECRET: SECRET,
    RELAY: { getByName(account: string) {
      if (!rooms.has(account)) {
        const data = new Map<string, unknown>();
        const storage: SessionStorage = {
          async get<T>(key: string) { return data.get(key) as T | undefined; },
          async put(key: string | Record<string, unknown>, value?: unknown) {
            if (typeof key === 'string') {
              await beforePut?.(key);
              data.set(key, value);
            } else {
              for (const [k, v] of Object.entries(key)) data.set(k, v);
            }
          },
        };
        rooms.set(account, new Relay({ storage } as never, { RELAY_SECRET: SECRET }));
      }
      const room = rooms.get(account)!;
      if (!beforeRpc) return room;
      return new Proxy(room, { get(target, key) {
        if (key === 'then') return undefined;
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          await beforeRpc(String(key));
          return value.apply(target, args);
        };
      } });
    } },
  };
  async function call(account: string, route: string, method = 'GET', token?: string, body?: object | string) {
    return worker.fetch(new Request(`https://relay.test/r/${account}/${route}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    }), env as never);
  }
  async function credential(account: string, bridgeId = `desktop-${account}`) {
    return (await issueToken(bridgeId, 'bridge', 60_000, SECRET, { accountId: account })).token;
  }
  async function pair(account: string, deviceId = 'phone-1') {
    const codeResponse = await call(account, 'pair/code', 'POST', await credential(account), { bridgeId: `desktop-${account}` });
    expect(codeResponse.status).toBe(200);
    const { code } = await codeResponse.json() as { code: string };
    const paired = await call(account, 'pair', 'POST', undefined, { code, deviceId });
    expect(paired.status).toBe(200);
    return (await paired.json() as { deviceToken: string }).deviceToken;
  }
  async function ticket(account: string, token: string) {
    const response = await call(account, 'ws-ticket', 'POST', token);
    expect(response.status).toBe(200);
    return await response.json() as { ticket: string; expiresAt: number };
  }
  async function connect(account: string, role: string, subject: string, token: string) {
    const response = await call(account, `ws?role=${role}&subject=${encodeURIComponent(subject)}&ticket=${encodeURIComponent(token)}`);
    expect(response.status).toBe(101);
    return pairs.at(-1)![1];
  }
  return { rooms, call, credential, pair, ticket, connect };
}

const op = { v: 1, id: 'op-1', ts: 1, source: 'app', type: 'op.list_team', payload: {} };
const evt = { v: 1, id: 'evt-1', ts: 1, source: 'bridge', type: 'evt.team_snapshot', payload: {} };

beforeEach(() => {
  pairs.length = 0;
  vi.stubGlobal('Response', UpgradeResponse);
  vi.stubGlobal('WebSocketPair', class {
    0 = new TestSocket();
    1 = new TestSocket();
    constructor() { pairs.push(this); }
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('account-bound device connection tickets', () => {
  it('rejects a foreign ticket even when both accounts have the same live device ID', async () => {
    const s = setup();
    const a = await s.pair('a');
    await s.pair('b');
    expect((await verifyToken(a, SECRET))?.acc).toBeUndefined();
    expect((await s.connect('b', 'device', 'phone-1', a)).closed).toBe(true);
    const issued = await s.ticket('a', a);
    expect((await s.connect('b', 'device', 'phone-1', issued.ticket)).closed).toBe(true);
    expect((await verifyToken(issued.ticket, SECRET))?.acc).toBe('a');
    expect((await s.connect('a', 'device', 'phone-1', issued.ticket)).closed).toBe(false);
    expect((await s.connect('a', 'device', 'phone-1', issued.ticket)).closed).toBe(true);
  });

  it('rejects claimless legacy tickets but keeps registry-matched ordinary credentials working', async () => {
    const s = setup();
    const device = await s.pair('a');
    const legacyTicket = await issueToken('phone-1', 'device', 30_000, SECRET, { ticket: true });
    expect((await s.connect('a', 'device', 'phone-1', legacyTicket.token)).closed).toBe(true);
    expect((await s.connect('a', 'device', 'phone-1', device)).closed).toBe(false);
  });

  it('still rejects unknown and revoked devices and ticket-to-ticket issuance', async () => {
    const s = setup();
    const issued = await s.ticket('a', await s.pair('a'));
    expect((await s.connect('b', 'device', 'phone-1', issued.ticket)).closed).toBe(true);
    expect((await s.call('a', 'ws-ticket', 'POST', issued.ticket)).status).toBe(401);
    expect((await s.call('a', 'devices/phone-1', 'DELETE', await s.credential('a'))).status).toBe(200);
    expect((await s.connect('a', 'device', 'phone-1', issued.ticket)).closed).toBe(true);
  });
});

describe('connection-only bridge tickets', () => {
  it.each([false, true])('cannot manage the account before/after consumption: %s', async (consume) => {
    const s = setup();
    await s.pair('a');
    const issued = await s.ticket('a', await s.credential('a'));
    if (consume) expect((await s.connect('a', 'bridge', 'desktop-a', issued.ticket)).closed).toBe(false);
    for (const [route, method, body] of [
      ['bridge/token', 'POST', undefined], ['bridge/token', 'DELETE', undefined],
      ['ws-ticket', 'POST', undefined], ['devices', 'GET', undefined],
      ['devices/phone-1', 'DELETE', undefined], ['status', 'GET', undefined],
      ['pair/code', 'POST', { bridgeId: 'desktop-a' }],
    ] as const) {
      expect((await s.call('a', route, method, issued.ticket, body)).status).toBe(401);
    }
  });

  it('keeps ordinary management credentials account-, owner- and cutoff-bound', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.pair('a');
    const token = await s.credential('a');
    expect((await s.call('a', 'devices', 'GET', token)).status).toBe(200);
    expect((await s.call('a', 'ws-ticket', 'POST', token)).status).toBe(200);
    expect((await s.call('b', 'bridge/token', 'POST', token)).status).toBe(401);
    expect((await s.call('a', 'bridge/token', 'POST', await s.credential('a', 'other-desktop'))).status).toBe(401);
    const expired = await issueToken('desktop-a', 'bridge', -1, SECRET, { accountId: 'a' });
    expect((await s.call('a', 'bridge/token', 'POST', expired.token)).status).toBe(401);
    vi.advanceTimersByTime(1);
    expect((await s.call('a', 'bridge/token', 'DELETE', token)).status).toBe(200);
    expect((await s.call('a', 'bridge/token', 'POST', token)).status).toBe(401);
    expect((await s.call('a', 'ws-ticket', 'POST', token)).status).toBe(401);
  });

  it('keeps bridge tickets single-use without imposing their expiry on an open connection', async () => {
    vi.useFakeTimers();
    const s = setup();
    const device = await s.pair('a');
    const issued = await s.ticket('a', await s.credential('a'));
    const bridge = await s.connect('a', 'bridge', 'desktop-a', issued.ticket);
    const phone = await s.connect('a', 'device', 'phone-1', device);
    phone.sent.length = 0;
    expect((await s.connect('a', 'bridge', 'desktop-a', issued.ticket)).closed).toBe(true);
    vi.advanceTimersByTime(30_001);
    bridge.message(evt);
    phone.message(op);
    expect(bridge.closed).toBe(false);
    expect(phone.sent).toHaveLength(1);
    expect(bridge.sent).toHaveLength(1);
  });
});

describe('active bridge revocation and replacement', () => {
  it('revalidates the original proof after delivery of the mutation RPC is delayed across a kill', async () => {
    let release!: () => void;
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = setup(undefined, async (method) => {
      if (method === 'rotateBridgeToken') { arrived(); await gate; }
    });
    await s.pair('a');
    const token = await s.credential('a');
    const pending = s.call('a', 'bridge/token', 'POST', token);
    await waiting;
    try {
      expect((await s.call('a', 'bridge/token', 'DELETE', token)).status).toBe(200);
      expect((await s.call('a', 'devices', 'GET', token)).status).toBe(401);
    } finally { release(); }
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty('token');
  });

  it('binds lifecycle mutation proof to role, purpose, account, owner and current cutoff inside the DO', async () => {
    const s = setup();
    const device = await s.pair('a');
    const owner = await s.credential('a');
    const ticket = (await s.ticket('a', owner)).ticket;
    const expired = (await issueToken('desktop-a', 'bridge', -1, SECRET, { accountId: 'a' })).token;
    expect(await s.rooms.get('a')!.rotateBridgeToken(owner, 'b')).toBeNull();
    for (const proof of [device, ticket, expired, await s.credential('b'), await s.credential('a', 'other-desktop'), 'invalid']) {
      expect(await s.rooms.get('a')!.rotateBridgeToken(proof, 'a')).toBeNull();
      expect(await s.rooms.get('a')!.revokeBridgeToken(proof, 'a')).toBe(false);
      expect(await s.rooms.get('a')!.revokeDeviceForOwner('phone-1', proof, 'a')).toBeNull();
    }
    expect((await s.call('a', 'bridge/token', 'DELETE', owner)).status).toBe(200);
    expect(await s.rooms.get('a')!.rotateBridgeToken(owner, 'a')).toBeNull();
  });

  it('a kill switch also invalidates a rotation already waiting on signing', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const s = setup();
    const credential = await s.credential('a');
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const signing = new Promise<void>(resolve => { entered = resolve; });
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    let blocked = false;
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      const result = await originalSign(...args);
      if (!blocked) { blocked = true; entered(); await gate; }
      return result;
    });
    const rotating = s.call('a', 'bridge/token', 'POST', credential);
    try {
      await signing;
      expect((await s.call('a', 'bridge/token', 'DELETE', credential)).status).toBe(200);
      release();
      const response = await rotating;
      expect(response.status).toBe(401);
      expect(await response.json()).not.toHaveProperty('token');
    } finally {
      release();
      await rotating;
      sign.mockRestore();
      clock.mockRestore();
    }
  });

  it('concurrent rotations do not return two surviving replacement credentials', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const s = setup();
      const credential = await s.credential('a');
      const responses = await Promise.all([
        s.call('a', 'bridge/token', 'POST', credential),
        s.call('a', 'bridge/token', 'POST', credential),
      ]);
      let valid = 0;
      for (const response of responses) {
        if (response.status !== 200) continue;
        const body = await response.json() as { token: string };
        if ((await s.call('a', 'devices', 'GET', body.token)).status === 200) valid += 1;
      }
      expect(valid).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([false, true])('terminates both directions for a token/ticket connection: %s', async (useTicket) => {
    vi.useFakeTimers();
    const s = setup();
    const device = await s.pair('a');
    const token = await s.credential('a');
    const bridge = await s.connect('a', 'bridge', 'desktop-a', useTicket ? (await s.ticket('a', token)).ticket : token);
    const phone = await s.connect('a', 'device', 'phone-1', device);
    phone.sent.length = 0;
    vi.advanceTimersByTime(1);
    expect((await s.call('a', 'bridge/token', 'DELETE', token)).status).toBe(200);
    bridge.message(evt);
    phone.message(op);
    expect(bridge.closed).toBe(true);
    expect((await s.rooms.get('a')!.status()).bridgeOnline).toBe(false);
    expect((await s.rooms.get('a')!.status()).lastSeq).toBe(0);
    expect(phone.sent).toEqual([]);
    expect(bridge.sent).toEqual([]);
    expect((await s.connect('a', 'bridge', 'desktop-a', token)).closed).toBe(true);
  });

  it('invalidates before awaiting storage or calling close, and does not detach a newer peer', async () => {
    vi.useFakeTimers();
    let finishWrite!: () => void;
    let beganWrite!: () => void;
    const writing = new Promise<void>((resolve) => { beganWrite = resolve; });
    const gate = new Promise<void>((resolve) => { finishWrite = resolve; });
    const s = setup(async (key) => { if (key === 'bridge-token-cutoff') { beganWrite(); await gate; } });
    const device = await s.pair('a');
    const bridge = await s.connect('a', 'bridge', 'desktop-a', await s.credential('a'));
    const phone = await s.connect('a', 'device', 'phone-1', device);
    phone.sent.length = 0;
    bridge.onClose = () => { bridge.message(evt); phone.message(op); };
    vi.advanceTimersByTime(1);
    const revoked = s.rooms.get('a')!.revokeBridgeTokensBefore(Date.now());
    await writing;
    bridge.message(evt);
    phone.message(op);
    expect(bridge.closed).toBe(true);
    expect(phone.sent).toEqual([]);
    expect(bridge.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    const fresh = await s.connect('a', 'bridge', 'desktop-a', await s.credential('a'));
    finishWrite();
    await revoked;
    bridge.dispatchEvent(new Event('close'));
    bridge.message(evt);
    phone.message(op);
    fresh.message(evt);
    expect((await s.rooms.get('a')!.status()).bridgeOnline).toBe(true);
    expect(fresh.closed).toBe(false);
    expect(fresh.sent).toHaveLength(1);
    expect(phone.sent).toHaveLength(1);
  });

  it('closes a peer revoked between session registration and transport acceptance', async () => {
    const s = setup();
    await s.pair('a');
    const original = RelaySession.prototype.registerSocket;
    vi.spyOn(RelaySession.prototype, 'registerSocket').mockImplementation(async function (this: RelaySession, params) {
      const result = await original.call(this, params);
      if (result.ok && params.role === 'bridge') {
        await this.revokeBridgeTokensBefore(Date.now() + 1);
      }
      return result;
    });
    // A Workers server socket cannot be closed until accept(). The adapter must
    // notice that registration was invalidated while its await was resuming.
    const close = TestSocket.prototype.close;
    const accepted = new WeakSet<TestSocket>();
    vi.spyOn(TestSocket.prototype, 'accept').mockImplementation(function (this: TestSocket) { accepted.add(this); });
    vi.spyOn(TestSocket.prototype, 'close').mockImplementation(function (this: TestSocket) {
      if (!accepted.has(this)) throw new Error('accept first');
      close.call(this);
    });
    const socket = await s.connect('a', 'bridge', 'desktop-a', await s.credential('a'));
    expect(socket.closed).toBe(true);
    expect((await s.rooms.get('a')!.status()).bridgeOnline).toBe(false);
  });

  it('refuses registration when revocation happens during signature verification', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.pair('a');
    const token = await s.credential('a');
    let finish!: () => void;
    let began!: () => void;
    const waiting = new Promise<void>((resolve) => { began = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'verify').mockImplementationOnce(async (...args) => {
      const valid = await verify(...args);
      began();
      await gate;
      return valid;
    });
    // Go straight through the DO transport so the gate is inside registration,
    // not in the Worker's preliminary credential check.
    const connecting = s.rooms.get('a')!.fetch(new Request(
      `https://relay.test/r/a/ws?role=bridge&subject=desktop-a&token=${encodeURIComponent(token)}`,
    ));
    await waiting;
    await s.rooms.get('a')!.revokeBridgeTokensBefore(Date.now());
    finish();
    expect((await connecting).status).toBe(101);
    expect(pairs.at(-1)![1].closed).toBe(true);
    expect((await s.rooms.get('a')!.status()).bridgeOnline).toBe(false);
  });

  it('does not finish minting a ticket after its source credential was revoked during signing', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.pair('a');
    const token = await s.credential('a');
    let finish!: () => void;
    let began!: () => void;
    const waiting = new Promise<void>((resolve) => { began = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const sign = crypto.subtle.sign.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(async (...args) => {
      const signature = await sign(...args);
      began();
      await gate;
      return signature;
    });
    const issuing = s.call('a', 'ws-ticket', 'POST', token);
    await waiting;
    await s.rooms.get('a')!.revokeBridgeTokensBefore(Date.now());
    finish();
    expect((await issuing).status).toBe(401);
  });

  it('does not sever a connection newer than a historical cutoff', async () => {
    vi.useFakeTimers();
    const s = setup();
    const token = await s.credential('a');
    const bridge = await s.connect('a', 'bridge', 'desktop-a', token);
    await s.rooms.get('a')!.revokeBridgeTokensBefore(Date.now() - 1);
    expect(bridge.closed).toBe(false);
    expect((await s.rooms.get('a')!.status()).bridgeOnline).toBe(true);
  });

  it('rotation allows replacement-token reconnect and ignores late frames/close from the old peer', async () => {
    vi.useFakeTimers();
    const s = setup();
    const device = await s.pair('a');
    const token = await s.credential('a');
    const old = await s.connect('a', 'bridge', 'desktop-a', token);
    const phone = await s.connect('a', 'device', 'phone-1', device);
    phone.sent.length = 0;
    vi.advanceTimersByTime(1);
    const response = await s.call('a', 'bridge/token', 'POST', token);
    expect(response.status).toBe(200);
    const rotated = await response.json() as { token: string };
    expect(old.closed).toBe(true);
    const fresh = await s.connect('a', 'bridge', 'desktop-a', (await s.ticket('a', rotated.token)).ticket);
    old.message(evt);
    old.dispatchEvent(new Event('close'));
    phone.message(op);
    fresh.message(evt);
    expect(fresh.closed).toBe(false);
    expect((await s.rooms.get('a')!.status()).bridgeOnline).toBe(true);
    expect(fresh.sent).toHaveLength(1);
    expect(old.sent).toEqual([]);
    expect(phone.sent).toHaveLength(1);
  });

  it('can immediately revoke a newly rotated credential and its active ticket connection', async () => {
    vi.useFakeTimers();
    const s = setup();
    await s.pair('a');
    const rotatedResponse = await s.call('a', 'bridge/token', 'POST', await s.credential('a'));
    const rotated = await rotatedResponse.json() as { token: string };
    const bridge = await s.connect('a', 'bridge', 'desktop-a', (await s.ticket('a', rotated.token)).ticket);
    expect(bridge.closed).toBe(false);
    expect((await s.call('a', 'bridge/token', 'DELETE', rotated.token)).status).toBe(200);
    expect(bridge.closed).toBe(true);
    expect((await s.connect('a', 'bridge', 'desktop-a', rotated.token)).closed).toBe(true);
  });

  it('immediate repeated rotations also revoke the previous replacement credential', async () => {
    vi.useFakeTimers();
    const s = setup();
    const firstResponse = await s.call('a', 'bridge/token', 'POST', await s.credential('a'));
    const first = await firstResponse.json() as { token: string };
    const secondResponse = await s.call('a', 'bridge/token', 'POST', first.token);
    expect(secondResponse.status).toBe(200);
    const second = await secondResponse.json() as { token: string };
    expect((await s.connect('a', 'bridge', 'desktop-a', first.token)).closed).toBe(true);
    expect((await s.connect('a', 'bridge', 'desktop-a', second.token)).closed).toBe(false);
  });

  it('rejects late frames from a replaced peer even without a revocation', async () => {
    const s = setup();
    const device = await s.pair('a');
    const token = await s.credential('a');
    const old = await s.connect('a', 'bridge', 'desktop-a', token);
    const phone = await s.connect('a', 'device', 'phone-1', device);
    phone.sent.length = 0;
    old.onClose = () => { old.message(evt); };
    const fresh = await s.connect('a', 'bridge', 'desktop-a', token);
    old.message(evt);
    old.dispatchEvent(new Event('close'));
    fresh.message(evt);
    expect(phone.sent).toHaveLength(1);
    expect((await s.rooms.get('a')!.status()).bridgeOnline).toBe(true);
  });
});

describe('lossless authenticated sender metadata', () => {
  it.each(['phone-$1', 'phone-$&-$`-$\'', 'phone-"-\\-雪'])('preserves %s and original numeric payload text', async (deviceId) => {
    const s = setup();
    const device = await s.pair('a', deviceId);
    const bridge = await s.connect('a', 'bridge', 'desktop-a', await s.credential('a'));
    const phone = await s.connect('a', 'device', deviceId, device);
    const raw = ' \n {"v":1,"id":"precise","ts":1,"source":"app","type":"op.list_team","payload":{"integer":9007199254740993,"decimal":1.234567890123456789}}';
    phone.message(raw);
    const forwarded = bridge.sent.at(-1)!;
    expect(JSON.parse(forwarded).from).toBe(deviceId);
    expect(forwarded).toContain('9007199254740993');
    expect(forwarded).toContain('1.234567890123456789');
    expect(forwarded).toBe(raw.replace('{', () => `{"from":${JSON.stringify(deviceId)},`));
  });
});

describe('owner revocation of accepted device IDs', () => {
  it.each(['phone-1', ' ', 'phone/slash', '/', '\\', '%', '%2e', '%2e%2e', '%2F', 'me', '手机-雪'])('body-based revocation preserves exact stored ID %s', async (deviceId) => {
    const s = setup();
    const device = await s.pair('a', deviceId);
    const other = await s.pair('a', 'other-phone');
    const socket = await s.connect('a', 'device', deviceId, device);
    expect((await s.call('a', 'devices/revoke', 'POST', await s.credential('a'), { deviceId })).status).toBe(200);
    expect(socket.closed).toBe(true);
    expect((await s.connect('a', 'device', deviceId, device)).closed).toBe(true);
    expect((await s.connect('a', 'device', 'other-phone', other)).closed).toBe(false);
  });

  it.each([{}, { deviceId: '' }, { deviceId: null }, { deviceId: 0 }, { deviceId: {} }, []])('rejects malformed body %j without revoking a phone', async (body) => {
    const s = setup();
    const device = await s.pair('a');
    expect((await s.call('a', 'devices/revoke', 'POST', await s.credential('a'), body)).status).toBe(400);
    expect((await s.connect('a', 'device', 'phone-1', device)).closed).toBe(false);
  });

  it.each(['{', 'null', '"text"', '42', ''])('rejects invalid or non-object JSON %s', async (body) => {
    const s = setup();
    const device = await s.pair('a');
    expect((await s.call('a', 'devices/revoke', 'POST', await s.credential('a'), body)).status).toBe(400);
    expect((await s.connect('a', 'device', 'phone-1', device)).closed).toBe(false);
  });

  it('bounds body parsing and returns 404 for an exact unknown ID', async () => {
    const s = setup();
    await s.pair('a');
    const owner = await s.credential('a');
    expect((await s.call('a', 'devices/revoke', 'POST', owner, { deviceId: 'x'.repeat(17 * 1024) })).status).toBe(413);
    expect((await s.call('a', 'devices/revoke', 'POST', owner, { deviceId: 'unknown' })).status).toBe(404);
  });

  it('requires current non-ticket owner proof for the body-based operation', async () => {
    const s = setup();
    const device = await s.pair('a');
    const owner = await s.credential('a');
    const ticket = (await s.ticket('a', owner)).ticket;
    for (const proof of [undefined, device, ticket, await s.credential('b'), await s.credential('a', 'other-desktop')]) {
      expect((await s.call('a', 'devices/revoke', 'POST', proof, { deviceId: 'phone-1' })).status).toBe(401);
    }
    expect((await s.call('a', 'bridge/token', 'DELETE', owner)).status).toBe(200);
    expect((await s.call('a', 'devices/revoke', 'POST', owner, { deviceId: 'phone-1' })).status).toBe(401);
    expect((await s.connect('a', 'device', 'phone-1', device)).closed).toBe(false);
  });

  it('revalidates owner proof after a revocation RPC was delayed across a kill', async () => {
    let release!: () => void;
    let arrived!: () => void;
    const waiting = new Promise<void>((resolve) => { arrived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const s = setup(undefined, async (method) => {
      if (method === 'revokeDeviceForOwner') { arrived(); await gate; }
    });
    const device = await s.pair('a');
    const owner = await s.credential('a');
    const pending = s.call('a', 'devices/revoke', 'POST', owner, { deviceId: 'phone-1' });
    // A missing route must fail rather than leave the test waiting on an RPC.
    const result = await Promise.race([waiting.then(() => 'arrived'), pending.then(() => 'completed')]);
    expect(result).toBe('arrived');
    try { expect((await s.call('a', 'bridge/token', 'DELETE', owner)).status).toBe(200); }
    finally { release(); }
    expect((await pending).status).toBe(401);
    expect((await s.connect('a', 'device', 'phone-1', device)).closed).toBe(false);
  });

  it.each(['.', '..'])('has a lossless owner revocation route for URL-normalized ID %s', async (deviceId) => {
    const s = setup();
    const device = await s.pair('a', deviceId);
    const other = await s.pair('a', 'other-phone');
    const socket = await s.connect('a', 'device', deviceId, device);
    // WHATWG URL normalization consumes dot-only path segments, including
    // percent-encoded dots. A body-based owner operation must cover these IDs.
    expect((await s.call('a', 'devices/revoke', 'POST', await s.credential('a'), { deviceId })).status).toBe(200);
    expect(socket.closed).toBe(true);
    expect((await s.connect('a', 'device', deviceId, device)).closed).toBe(true);
    expect((await s.connect('a', 'device', 'other-phone', other)).closed).toBe(false);
  });

  it.each(['phone-1', 'phone space', 'phone/slash', 'phone%percent', 'phone%2Fslash', 'me', '手机-雪'])('revokes exactly the encoded ID %s', async (deviceId) => {
    const s = setup();
    const device = await s.pair('a', deviceId);
    const other = await s.pair('a', 'other-phone');
    const socket = await s.connect('a', 'device', deviceId, device);
    expect((await s.call('a', `devices/${encodeURIComponent(deviceId)}`, 'DELETE', await s.credential('a'))).status).toBe(200);
    expect(socket.closed).toBe(true);
    expect((await s.connect('a', 'device', deviceId, device)).closed).toBe(true);
    expect((await s.connect('a', 'device', 'other-phone', other)).closed).toBe(false);
  });

  it('decodes exactly once when encoded-looking and decoded IDs coexist', async () => {
    const s = setup();
    const literal = await s.pair('a', 'phone%2Fslash');
    const slash = await s.pair('a', 'phone/slash');
    expect((await s.call('a', 'devices/phone%252Fslash', 'DELETE', await s.credential('a'))).status).toBe(200);
    expect((await s.connect('a', 'device', 'phone%2Fslash', literal)).closed).toBe(true);
    expect((await s.connect('a', 'device', 'phone/slash', slash)).closed).toBe(false);
  });

  it.each(['%', '%2', '%GG', '%E0%A4'])('refuses malformed encoding %s without revoking another device', async (suffix) => {
    const s = setup();
    const token = await s.pair('a');
    expect((await s.call('a', `devices/${suffix}`, 'DELETE', await s.credential('a'))).status).toBe(400);
    expect((await s.connect('a', 'device', 'phone-1', token)).closed).toBe(false);
  });

  it('does not silently revoke a prefix when given multiple unencoded path segments', async () => {
    const s = setup();
    const token = await s.pair('a', 'phone');
    expect((await s.call('a', 'devices/phone/slash', 'DELETE', await s.credential('a'))).status).toBe(404);
    expect((await s.connect('a', 'device', 'phone', token)).closed).toBe(false);
  });

  it('preserves device self-release without letting a phone revoke a path-selected device', async () => {
    const s = setup();
    const other = await s.pair('a', 'me');
    const token = await s.pair('a', 'phone/slash');
    expect((await s.call('a', 'devices/me', 'DELETE', token)).status).toBe(200);
    expect((await s.connect('a', 'device', 'phone/slash', token)).closed).toBe(true);
    expect((await s.connect('a', 'device', 'me', other)).closed).toBe(false);
    expect((await s.call('a', 'devices/phone%2Fslash', 'DELETE', other)).status).toBe(401);
  });

  it('retains account, owner and role checks for encoded revocation and reserved me', async () => {
    const s = setup();
    const token = await s.pair('a', 'me');
    for (const credential of [await s.credential('b'), await s.credential('a', 'other-desktop'), token, undefined]) {
      expect((await s.call('a', 'devices/%6De', 'DELETE', credential)).status).toBe(401);
    }
    expect((await s.connect('a', 'device', 'me', token)).closed).toBe(false);
  });
});
