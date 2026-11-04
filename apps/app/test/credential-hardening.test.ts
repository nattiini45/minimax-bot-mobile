import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { loadSession, persistSession } from '../src/state/store';
import { loadDeviceToken, saveDeviceToken } from '../src/state/credential-store';
const A = { relayUrl: 'https://relay-a.example', accountId: 'default', deviceId: 'a', deviceToken: 'ta', deviceName: 'Phone' };
const B = { ...A, relayUrl: 'https://relay-b.example', deviceId: 'b', deviceToken: 'tb' };
beforeEach(async () => { await persistSession(null); await AsyncStorage.clear(); });
afterEach(() => jest.restoreAllMocks());

test('native keystore write failure rejects without writing a plaintext credential', async () => {
  jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValueOnce(new Error('locked'));
  await expect(saveDeviceToken('secret', A.relayUrl)).rejects.toThrow();
  expect(await AsyncStorage.getItem('minimax-bot.device-token')).toBeNull();
});

test('a failed replacement cannot load old secure credentials with new metadata', async () => {
  await persistSession(A);
  jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValueOnce(new Error('locked'));
  await expect(persistSession({ ...A, deviceToken: 'new', deviceId: 'new' })).rejects.toThrow();
  expect(await loadSession()).toBeNull();
  expect(await AsyncStorage.getItem('minimax-bot.device-token')).toBeNull();
});

test.each(['minimax-bot.device-token', 'minimax-bot.device-origin'])('unreadable secure %s fails closed despite plaintext copies', async key => {
  await persistSession(A);
  await AsyncStorage.setItem('minimax-bot.session', JSON.stringify({ ...B, deviceToken: undefined }));
  await AsyncStorage.setItem('minimax-bot.device-token', 'plaintext');
  await AsyncStorage.setItem('minimax-bot.device-origin', B.relayUrl);
  const get = SecureStore.getItemAsync;
  jest.spyOn(SecureStore, 'getItemAsync').mockImplementation(async k => { if (k === key) throw new Error('locked'); return get(k); });
  expect(await loadSession()).toBeNull();
});

test('a missing secure origin is not permission to trust modified plaintext metadata', async () => {
  await persistSession(A);
  await SecureStore.deleteItemAsync('minimax-bot.device-origin');
  await AsyncStorage.setItem('minimax-bot.session', JSON.stringify({ ...B, deviceToken: undefined }));
  expect(await loadSession()).toBeNull();
});

test('subject/account tampering cannot reuse a stored credential', async () => {
  await persistSession(A);
  await AsyncStorage.setItem('minimax-bot.session', JSON.stringify({ ...A, accountId: 'other', deviceId: 'other', deviceToken: undefined }));
  expect(await loadSession()).toBeNull();
});

test('concurrent saves and logout cannot recreate loadable metadata', async () => {
  const set = SecureStore.setItemAsync;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  jest.spyOn(SecureStore, 'setItemAsync').mockImplementation(async (key, value, options) => {
    if (!started) { started = true; await held; }
    return set(key, value, options);
  });
  const old = persistSession(A);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(started).toBe(true);
  const newer = persistSession(B);
  const logout = persistSession(null);
  release();
  await Promise.allSettled([old, newer, logout]);
  expect(await loadSession()).toBeNull();
  expect(await AsyncStorage.getItem('minimax-bot.session')).toBeNull();
  expect(await loadDeviceToken()).toBeNull();
});

test('overlapping saves commit one coherent latest token, subject and origin', async () => {
  const set = SecureStore.setItemAsync;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  jest.spyOn(SecureStore, 'setItemAsync').mockImplementation(async (key, value, options) => {
    if (!started) { started = true; await held; }
    return set(key, value, options);
  });
  const old = persistSession(A);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(started).toBe(true);
  const newer = persistSession(B);
  release();
  await Promise.all([old, newer]);
  const session = await loadSession();
  expect(session?.deviceToken).toBe('tb');
  expect(session?.deviceId).toBe('b');
  expect(session?.relayUrl).toBe(B.relayUrl);
});

test('native availability query failure is not web storage permission', async () => {
  jest.spyOn(SecureStore, 'isAvailableAsync').mockRejectedValue(new Error('unreadable'));
  await expect(saveDeviceToken('secret', A.relayUrl)).rejects.toThrow();
  expect(await AsyncStorage.getItem('minimax-bot.device-token')).toBeNull();
});

test('explicit web storage remains available when there is no native keystore', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  jest.spyOn(SecureStore, 'isAvailableAsync').mockResolvedValue(false);
  await saveDeviceToken('web-token', A.relayUrl);
  expect(await AsyncStorage.getItem('minimax-bot.device-token')).toBe('web-token');
  expect(await loadDeviceToken()).toBe('web-token');
});
