import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { unpairPhone, useAppStore } from '../src/state/store';

/**
 * Unpairing has to reach the relay.
 *
 * A phone that only forgets its own token leaves a working credential behind on
 * the relay: it is still accepted, and whoever holds the phone can attach to the
 * account's room and read every conversation frame.
 */

const SESSION = {
  relayUrl: 'https://relay.example.workers.dev',
  accountId: 'default',
  deviceId: 'device-1',
  deviceToken: 'the-device-token',
  deviceName: 'Phone',
};

const originalFetch = global.fetch;

beforeEach(async () => {
  await AsyncStorage.clear();
  await SecureStore.deleteItemAsync('minimax-bot.device-token');
  await SecureStore.deleteItemAsync('minimax-bot.device-origin');
  useAppStore.setState({ session: null });
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('unpairing this phone', () => {
  it('tells the relay to release the token', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    useAppStore.setState({ session: SESSION });

    const released = await unpairPhone();

    expect(released).toBe(true);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://relay.example.workers.dev/r/default/devices/me');
    expect(init.method).toBe('DELETE');
    expect(init.headers.authorization).toBe('Bearer the-device-token');
  });

  it('forgets the session', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true });
    useAppStore.setState({ session: SESSION });

    await unpairPhone();

    expect(useAppStore.getState().session).toBeNull();
  });

  it('throws the token away even when the relay cannot be reached', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    useAppStore.setState({ session: SESSION });

    const released = await unpairPhone();

    // The phone forgets its own token either way; the caller is told that the
    // relay has to be told as well.
    expect(released).toBe(false);
    expect(useAppStore.getState().session).toBeNull();
    expect(await SecureStore.getItemAsync('minimax-bot.device-token')).toBeNull();
  });

  it('does nothing when the phone was not paired', async () => {
    const released = await unpairPhone();

    expect(released).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
