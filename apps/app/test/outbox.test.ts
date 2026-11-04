import AsyncStorage from '@react-native-async-storage/async-storage';
import { createFrame, type Frame } from '@minimax-bot/protocol';
import { connectRelay, disconnectRelay, loadOutbox, unpairPhone, useAppStore } from '../src/state/store';

/**
 * The outbox is the queue of operations the phone composed while the desktop was
 * unreachable.
 *
 * The phone holds one credential at a time, so an operation composed for one
 * account cannot be delivered to another one: the room it belongs to is reached
 * with a credential this phone does not have. The outbox outlives a dropped
 * session, so without the account on every entry the next account's connection
 * would flush it.
 */

const mockSent: Frame[] = [];
let mockCanSend = false;

jest.mock('../src/net/relay-client', () => {
  class FakeRelayClient {
    /** The frames the store tried to send. */
    readonly sent = mockSent;

    connect(): void {}

    disconnect(): void {}

    send(frame: Frame): boolean {
      if (!mockCanSend) return false;
      mockSent.push(frame);
      return true;
    }
  }

  return {
    __esModule: true,
    RelayClient: FakeRelayClient,
    CLOSE_DEVICE_REVOKED: 4003,
  };
});

const SESSION_A = {
  relayUrl: 'https://relay.example.workers.dev',
  accountId: 'account-a',
  deviceId: 'device-1',
  deviceToken: 'the-device-token',
  deviceName: 'Phone',
};

const SESSION_B = { ...SESSION_A, accountId: 'account-b' };

beforeEach(async () => {
  disconnectRelay();
  useAppStore.getState().setSession(null);
  useAppStore.setState(useAppStore.getInitialState(), true);
  mockSent.length = 0;
  mockCanSend = false;
  await loadOutbox();
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
});

afterEach(async () => {
  disconnectRelay();
  useAppStore.getState().setSession(null);
  await loadOutbox();
  jest.restoreAllMocks();
});

describe('the outbox', () => {
  it('keeps at most a hundred operations', () => {
    // The queue survives a dropped session, so a phone that is offline for a long
    // time would otherwise grow it without bound and then deliver a week-old
    // conversation in one burst.
    useAppStore.setState({ outbox: [] });
    for (let index = 0; index < 120; index += 1) {
      useAppStore.getState().request('op.send_message', { chatId: 'bot:b1', text: `message ${index}` });
    }

    const outbox = useAppStore.getState().outbox;
    expect(outbox.length).toBe(100);
    // The newest are the ones that are kept.
    expect(outbox[outbox.length - 1]?.payload).toEqual({ chatId: 'bot:b1', text: 'message 119' });
  });

  it('remembers the account an operation was composed for', () => {
    useAppStore.setState({ session: SESSION_A });
    connectRelay(SESSION_A);

    useAppStore.getState().request('op.send_message', { text: 'hello' });

    const queued = useAppStore.getState().outbox;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual(expect.objectContaining({
      accountId: 'account-a', origin: 'https://relay.example.workers.dev', deviceId: 'device-1',
      ownerId: useAppStore.getState().session?.ownerId,
    }));
    expect(queued[0]?.ownerId).toBeTruthy();
    expect(JSON.stringify(queued)).not.toContain(SESSION_A.deviceToken);
  });

  it('journals before sending for a present bridge and retains the operation until its matching acknowledgement', async () => {
    useAppStore.getState().setSession(SESSION_A);
    connectRelay(SESSION_A);
    mockCanSend = true;
    useAppStore.setState({ status: 'online', bridgeOnline: false, desktopKnown: true });
    const opId = useAppStore.getState().request('op.send_message', { chatId: 'bot:b1', text: 'hello' });
    await loadOutbox();
    expect(mockSent).toHaveLength(0);

    const save = AsyncStorage.setItem;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const journalStarted = new Promise<void>(resolve => { started = resolve; });
    jest.spyOn(AsyncStorage, 'setItem').mockImplementation(async (key, value) => {
      if (key === 'minimax-bot.outbox' && JSON.parse(value).some((item: { opId: string; sentAt?: number }) => item.opId === opId && item.sentAt !== undefined)) {
        started();
        await held;
      }
      return save(key, value);
    });
    useAppStore.setState({ bridgeOnline: true });
    useAppStore.getState().flushOutbox();
    try {
      await journalStarted;
      expect(mockSent).toHaveLength(0);
      expect(useAppStore.getState().outbox.map(item => item.opId)).toEqual([opId]);
    } finally { release(); }
    await loadOutbox();
    expect(mockSent).toHaveLength(1);
    expect(mockSent[0]).toEqual(expect.objectContaining({ opId, type: 'op.send_message', payload: { chatId: 'bot:b1', text: 'hello' } }));
    expect(useAppStore.getState().outbox.map(item => item.opId)).toEqual([opId]);

    useAppStore.getState().applyFrame(createFrame({ type: 'ack', source: 'bridge', payload: { opId: 'some-other-operation' } }));
    useAppStore.getState().flushOutbox();
    await loadOutbox();
    expect(useAppStore.getState().outbox.map(item => item.opId)).toEqual([opId]);
    expect(mockSent).toHaveLength(1);

    useAppStore.getState().applyFrame(createFrame({ type: 'ack', source: 'bridge', payload: { opId } }));
    expect(useAppStore.getState().outbox).toHaveLength(0);
    expect(await loadOutbox()).toEqual([]);
  });

  it('does not send another owner\'s operation even when the current bridge is present', async () => {
    useAppStore.getState().setSession(SESSION_A);
    connectRelay(SESSION_A);
    useAppStore.getState().request('op.send_message', { text: 'for account a' });
    const oldQueue = useAppStore.getState().outbox;
    expect(oldQueue).toHaveLength(1);

    useAppStore.getState().setSession(SESSION_B);
    connectRelay(SESSION_B);
    mockCanSend = true;
    // Deliberately inject an old hydrated entry. Both the normal account-change
    // clearing AND dispatch-time ownership checking must protect the new room.
    useAppStore.setState({ outbox: oldQueue, status: 'online', bridgeOnline: true, desktopKnown: true });
    useAppStore.getState().flushOutbox();
    await loadOutbox();

    expect(mockSent).toHaveLength(0);
    expect(useAppStore.getState().outbox).toHaveLength(0);
  });

  it('does not send an operation that cannot be attributed to an account', () => {
    // An entry written before the outbox knew its account.
    useAppStore.setState({
      session: SESSION_A,
      outbox: [
        {
          opId: 'op_1',
          type: 'op.send_message',
          payload: { text: 'from an older version' },
          queuedAt: 1,
          accountId: '',
        },
      ],
    });
    connectRelay(SESSION_A);
    mockCanSend = true;
    useAppStore.setState({ status: 'online', bridgeOnline: true, desktopKnown: true });

    useAppStore.getState().flushOutbox();

    expect(mockSent).toHaveLength(0);
    expect(useAppStore.getState().outbox).toHaveLength(0);
  });

  it('is thrown away when the phone unpairs', async () => {
    useAppStore.setState({ session: SESSION_A });
    connectRelay(SESSION_A);
    useAppStore.getState().request('op.send_message', { text: 'hello' });
    expect(useAppStore.getState().outbox).toHaveLength(1);

    await unpairPhone();

    expect(useAppStore.getState().outbox).toHaveLength(0);
  });
});
