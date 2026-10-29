/**
 * Where the device token lives.
 *
 * The device token is the only credential the phone holds, and it is good for a
 * month. AsyncStorage is plain text inside the app sandbox: on a rooted phone, in
 * an unencrypted backup or in a device image, anyone can read it. The platform
 * keystore cannot be read that way, so the token goes there and only the parts of
 * the session that are not secret stay in AsyncStorage.
 *
 * The origin the token was minted for is kept beside it. The relay address is in
 * the plain store, so it can be changed by anything that can write to it, and the
 * token is presented to whatever host the address names. Binding the two means a
 * changed address is a refused session rather than a token handed to a stranger.
 *
 * The web build has no keystore - `expo-secure-store` is not available in a
 * browser - so the token falls back to the same store the rest of the app uses. A
 * browser holds the credential in its own storage, which is the most a browser
 * can do.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

/** The key the token is filed under. */
const TOKEN_KEY = 'minimax-bot.device-token';

/** The key the relay the token was minted for is filed under. */
const ORIGIN_KEY = 'minimax-bot.device-origin';

/** Whether this build has a keystore the app sandbox cannot read. */
let keystoreAvailable: boolean | undefined;

/**
 * Whether the platform keeps secrets in a keystore.
 *
 * The answer does not change while the app runs, so it is asked once.
 *
 * @returns {Promise<boolean>}
 */
async function hasKeystore(): Promise<boolean> {
  if (keystoreAvailable === undefined) {
    try {
      // The web build has no keystore at all - the module is empty there - so the
      // question is not even asked.
      keystoreAvailable =
        typeof SecureStore.isAvailableAsync === 'function'
          ? await SecureStore.isAvailableAsync()
          : false;
    } catch {
      keystoreAvailable = false;
    }
  }
  return keystoreAvailable;
}

/**
 * Writes the device token down where only the platform can read it.
 *
 * @param {string} token
 * @param {string} origin The relay the token was minted for.
 */
export async function saveDeviceToken(token: string, origin: string): Promise<void> {
  if (await hasKeystore()) {
    try {
      await SecureStore.setItemAsync(TOKEN_KEY, token);
      await SecureStore.setItemAsync(ORIGIN_KEY, origin);
      // The plain text copies, if there are any, are the things this store exists
      // to remove.
      await AsyncStorage.removeItem(TOKEN_KEY);
      await AsyncStorage.removeItem(ORIGIN_KEY);
      return;
    } catch {
      // A keystore that refuses the write - a device whose keystore is broken -
      // must not lock the user out of their own account. The token goes back to
      // the plain store, which is where it was before.
    }
  }
  await AsyncStorage.setItem(TOKEN_KEY, token);
  await AsyncStorage.setItem(ORIGIN_KEY, origin);
}

/**
 * Reads the device token back.
 *
 * @returns {Promise<string | null>}
 */
export async function loadDeviceToken(): Promise<string | null> {
  if (await hasKeystore()) {
    try {
      const stored = await SecureStore.getItemAsync(TOKEN_KEY);
      if (stored) return stored;
    } catch {
      // fall through to the plain store
    }
  }
  try {
    return await AsyncStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * The relay the device token was minted for.
 *
 * @returns {Promise<string | null>}
 */
export async function loadDeviceOrigin(): Promise<string | null> {
  if (await hasKeystore()) {
    try {
      const stored = await SecureStore.getItemAsync(ORIGIN_KEY);
      if (stored) return stored;
    } catch {
      // fall through to the plain store
    }
  }
  try {
    return await AsyncStorage.getItem(ORIGIN_KEY);
  } catch {
    return null;
  }
}

/**
 * Throws the device token away.
 */
export async function clearDeviceToken(): Promise<void> {
  if (await hasKeystore()) {
    try {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
      await SecureStore.deleteItemAsync(ORIGIN_KEY);
    } catch {
      // the plain copies below are removed either way
    }
  }
  try {
    await AsyncStorage.removeItem(TOKEN_KEY);
    await AsyncStorage.removeItem(ORIGIN_KEY);
  } catch {
    // nothing to do
  }
}
