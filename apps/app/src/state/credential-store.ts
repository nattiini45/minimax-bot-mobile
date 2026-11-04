/** Credentials never downgrade to plaintext after a native keystore failure. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const TOKEN_KEY = 'minimax-bot.device-token';
const ORIGIN_KEY = 'minimax-bot.device-origin';
const BINDING_KEY = 'minimax-bot.device-binding';
const LAST_RELAY_KEY = 'minimax-bot.last-relay';

export interface CredentialBinding {
  token: string;
  origin: string;
  accountId: string;
  deviceId: string;
  ownerId?: string;
}

async function hasKeystore(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (typeof SecureStore.isAvailableAsync !== 'function' || !(await SecureStore.isAvailableAsync())) {
    throw new Error('The native credential store is unavailable.');
  }
  return true;
}

// All credential writes (including removal) are ordered. A failed write is not absence.
let writes: Promise<void> = Promise.resolve();
function writeCredential(work: () => Promise<void>): Promise<void> {
  const result = writes.then(work);
  writes = result.catch(() => {});
  return result;
}

export function saveDeviceToken(
  token: string,
  origin: string,
  subject?: { accountId: string; deviceId: string; ownerId?: string },
): Promise<void> {
  return writeCredential(async () => {
    const binding = subject ? JSON.stringify({ token, origin, accountId: subject.accountId, deviceId: subject.deviceId, ownerId: subject.ownerId }) : null;
    if (await hasKeystore()) {
      // Invalidate the old binding before replacing either half of the credential.
      await SecureStore.deleteItemAsync(BINDING_KEY);
      await SecureStore.setItemAsync(TOKEN_KEY, token);
      await SecureStore.setItemAsync(ORIGIN_KEY, origin);
      if (binding) await SecureStore.setItemAsync(BINDING_KEY, binding);
      await AsyncStorage.removeItem(TOKEN_KEY);
      await AsyncStorage.removeItem(ORIGIN_KEY);
      await AsyncStorage.removeItem(BINDING_KEY);
      return;
    }
    await AsyncStorage.removeItem(BINDING_KEY);
    await AsyncStorage.setItem(TOKEN_KEY, token);
    await AsyncStorage.setItem(ORIGIN_KEY, origin);
    if (binding) await AsyncStorage.setItem(BINDING_KEY, binding);
  });
}

async function readCredential(key: string): Promise<string | null> {
  await writes;
  return (await hasKeystore()) ? SecureStore.getItemAsync(key) : AsyncStorage.getItem(key);
}

export function loadDeviceToken(): Promise<string | null> {
  return readCredential(TOKEN_KEY);
}

export function loadDeviceOrigin(): Promise<string | null> {
  return readCredential(ORIGIN_KEY);
}

export async function loadDeviceBinding(): Promise<CredentialBinding | null> {
  const raw = await readCredential(BINDING_KEY);
  if (!raw) return null;
  const binding = JSON.parse(raw) as CredentialBinding;
  if (!binding || !['token', 'origin', 'accountId', 'deviceId'].every(
    key => typeof binding[key as keyof CredentialBinding] === 'string',
  )) throw new Error('Invalid credential binding.');
  return binding;
}

export function clearDeviceToken(): Promise<void> {
  return writeCredential(async () => {
    // Plain copies are removed even if the native store is locked. The caller removes
    // session metadata first, so a leftover secure token cannot resurrect a session.
    await AsyncStorage.removeItem(TOKEN_KEY);
    await AsyncStorage.removeItem(ORIGIN_KEY);
    await AsyncStorage.removeItem(BINDING_KEY);
    if (await hasKeystore()) {
      await SecureStore.deleteItemAsync(BINDING_KEY);
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(ORIGIN_KEY);
    }
  });
}

export async function saveLastRelayUrl(url: string): Promise<void> {
  try { await AsyncStorage.setItem(LAST_RELAY_KEY, url); } catch { /* not a credential */ }
}

export async function loadLastRelayUrl(): Promise<string | null> {
  try { return await AsyncStorage.getItem(LAST_RELAY_KEY); } catch { return null; }
}
