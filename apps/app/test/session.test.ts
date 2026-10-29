import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { loadSession, persistSession, type Session } from '../src/state/store';

/**
 * The session is the phone's credential to the account's room, and the device token
 * in it is good for a month. These tests are about where that token is kept.
 */

const SESSION_KEY = 'minimax-bot.session';
const TOKEN_KEY = 'minimax-bot.device-token';
const ORIGIN_KEY = 'minimax-bot.device-origin';

const SESSION: Session = {
  relayUrl: 'https://relay.example.workers.dev',
  accountId: 'default',
  deviceId: 'device-1',
  deviceToken: 'the-device-token',
  deviceName: 'Phone',
};

beforeEach(async () => {
  await AsyncStorage.clear();
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(ORIGIN_KEY);
});

describe('where the device token is kept', () => {
  it('is not written to the plain store', async () => {
    await persistSession(SESSION);

    const raw = await AsyncStorage.getItem(SESSION_KEY);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('the-device-token');
  });

  it('is written to the keystore', async () => {
    await persistSession(SESSION);

    expect(await SecureStore.getItemAsync(TOKEN_KEY)).toBe('the-device-token');
    expect(await AsyncStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('comes back with the session', async () => {
    await persistSession(SESSION);

    const session = await loadSession();
    expect(session?.deviceToken).toBe('the-device-token');
    expect(session?.accountId).toBe('default');
    expect(session?.relayUrl).toBe(SESSION.relayUrl);
  });

  it('is thrown away when the phone unpairs', async () => {
    await persistSession(SESSION);
    await persistSession(null);

    expect(await SecureStore.getItemAsync(TOKEN_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(SESSION_KEY)).toBeNull();
    expect(await loadSession()).toBeNull();
  });
});

describe('a stored session that was tampered with', () => {
  it('is refused when the relay address is one the app may not use', async () => {
    await AsyncStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...SESSION, relayUrl: 'http://evil.example', deviceToken: undefined }),
    );
    await SecureStore.setItemAsync(TOKEN_KEY, 'the-device-token');

    expect(await loadSession()).toBeNull();
    // The token is not used with the address either, and it is not left behind.
    expect(await SecureStore.getItemAsync(TOKEN_KEY)).toBeNull();
  });

  it('is refused when the relay address names another relay', async () => {
    await persistSession(SESSION);

    // The address is in the plain store, so anything that can write to it can
    // point the token at a host of its own.
    const stored = JSON.parse((await AsyncStorage.getItem(SESSION_KEY))!);
    await AsyncStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...stored, relayUrl: 'https://evil.example' }),
    );

    expect(await loadSession()).toBeNull();
    expect(await SecureStore.getItemAsync(TOKEN_KEY)).toBeNull();
  });

  it('is accepted when the relay address still names the same relay', async () => {
    await persistSession(SESSION);

    const stored = JSON.parse((await AsyncStorage.getItem(SESSION_KEY))!);
    // A spelling change of the same relay is the same relay.
    await AsyncStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...stored, relayUrl: 'wss://relay.example.workers.dev' }),
    );

    const session = await loadSession();
    expect(session?.deviceToken).toBe('the-device-token');
  });
});

describe('a phone that paired before the token moved to the keystore', () => {
  it('keeps its session', async () => {
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));

    const session = await loadSession();
    expect(session?.deviceToken).toBe('the-device-token');
    expect(session?.relayUrl).toBe(SESSION.relayUrl);
  });

  it('has the plain text copy taken away', async () => {
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(SESSION));

    await loadSession();

    const raw = await AsyncStorage.getItem(SESSION_KEY);
    expect(raw).not.toContain('the-device-token');
    expect(await SecureStore.getItemAsync(TOKEN_KEY)).toBe('the-device-token');
  });
});
