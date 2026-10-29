/**
 * Releasing the phone's own credential.
 *
 * Unpairing has to reach the relay. A phone that only forgets its own token
 * leaves a working credential behind on the relay: it is still accepted, and
 * whoever holds the phone can attach to the account's room, read every
 * conversation frame and drive the desktop agent.
 *
 * The relay decides whether the token is released: it knows whether the token
 * was the one it issued to that device.
 */

import { relayHttpUrl } from './relay-url';

/**
 * Releases this phone's token on the relay.
 *
 * @param url The relay address.
 * @param accountId The room the phone is paired to.
 * @param token The phone's own device token.
 * @returns whether the relay released the token.
 */
export async function releaseDevice(
  url: string,
  accountId: string,
  token: string,
): Promise<boolean> {
  const base = relayHttpUrl(url);
  try {
    const response = await fetch(`${base}/r/${encodeURIComponent(accountId)}/devices/me`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    // The relay could not be reached. The phone still forgets its own token; the
    // owner is told that the relay has to be told as well.
    return false;
  }
}
