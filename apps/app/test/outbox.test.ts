import { connectRelay, unpairPhone, useAppStore } from '../src/state/store';

/**
 * The outbox is the queue of operations the phone composed while the desktop was
 * unreachable.
 *
 * The phone holds one credential at a time, so an operation composed for one
 * account cannot be delivered to another one: the room it belongs to is reached
 * with a credential this phone does not have. The outbox outlives unpairing, so
 * without the account on every entry the next account's connection would flush
 * it.
 */

const mockSent: unknown[] = [];

jest.mock('../src/net/relay-client', () => {
  class FakeRelayClient {
    /** The frames the store tried to send. */
    readonly sent = mockSent;

    /** Whether the socket is up. The first send is refused so the frame is queued. */
    private refused = false;

    connect(): void {}

    disconnect(): void {}

    send(frame: unknown): boolean {
      if (!this.refused) {
        this.refused = true;
        return false;
      }
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

beforeEach(() => {
  mockSent.length = 0;
  useAppStore.setState({ session: null, outbox: [] });
});

describe('the outbox', () => {
  it('remembers the account an operation was composed for', () => {
    useAppStore.setState({ session: SESSION_A });
    connectRelay(SESSION_A);

    useAppStore.getState().request('op.send_message', { text: 'hello' });

    const queued = useAppStore.getState().outbox;
    expect(queued).toHaveLength(1);
    expect(queued[0]?.accountId).toBe('account-a');
  });

  it('sends the operations of the account it is connected to', () => {
    useAppStore.setState({ session: SESSION_A });
    connectRelay(SESSION_A);
    useAppStore.getState().request('op.send_message', { text: 'hello' });

    useAppStore.getState().flushOutbox();

    expect(mockSent).toHaveLength(1);
    expect(useAppStore.getState().outbox).toHaveLength(0);
  });

  it('does not send an operation that belongs to another account', () => {
    useAppStore.setState({ session: SESSION_A });
    connectRelay(SESSION_A);
    useAppStore.getState().request('op.send_message', { text: 'for account a' });
    expect(useAppStore.getState().outbox).toHaveLength(1);

    // The phone is paired to another account now. The operation was written for
    // the first account's room and must not be delivered into the second one.
    useAppStore.setState({ session: SESSION_B });
    useAppStore.getState().flushOutbox();

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
