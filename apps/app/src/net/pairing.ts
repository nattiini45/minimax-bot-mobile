/**
 * Pairing against a relay.
 *
 * The phone types the six digit code the desktop shows; the relay exchanges it for a
 * device scoped token. The token is the only credential the phone ever holds.
 */

import { isValidPairingCode, type PairingResponse } from '@minimax-bot/protocol';

import { isValidRelayUrl } from './relay-url';
import { resolvePairingTarget, untrustedRelayWarning, type KnownRelays } from './pairing-target';

export interface PairingResult {
  ok: boolean;
  deviceToken?: string;
  expiresAt?: number;
  message?: string;
  code?: string;
}

export async function pairWithCode(params: {
  url: string;
  accountId: string;
  code: string;
  deviceId: string;
  deviceName: string;
  clientVersion: string;
  /** The origins this phone already knows. */
  known?: KnownRelays;
  /**
   * Whether the user has acknowledged a destination the phone does not know.
   *
   * The acknowledgement is for one address and one address only: the caller checks
   * that the address it acknowledged is the one it is about to send to.
   */
  confirmed?: boolean;
}): Promise<PairingResult> {
  const code = params.code.trim();
  if (!isValidPairingCode(code)) {
    return { ok: false, message: 'Enter the six digit code shown on your desktop.' };
  }

  if (!isValidRelayUrl(params.url)) {
    return { ok: false, message: 'Enter the relay address, for example https://relay.example.workers.dev' };
  }

  const target = resolvePairingTarget(params.url, params.known);

  // The code does not leave the phone for an address the phone does not know, unless
  // the user has acknowledged that address first. Without this, an address that was
  // talked into the form takes the one-time credential with it.
  if (!target.known && params.confirmed !== true) {
    return { ok: false, code: 'UNTRUSTED_RELAY', message: untrustedRelayWarning(target) };
  }

  const base = target.url;
  try {
    const response = await fetch(`${base}/r/${encodeURIComponent(params.accountId)}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        deviceId: params.deviceId,
        deviceName: params.deviceName,
        clientVersion: params.clientVersion,
      }),
    });

    const body = (await response.json()) as PairingResponse;
    if (!response.ok || body.ok !== true) {
      return {
        ok: false,
        code: body.code,
        message: body.message ?? 'The relay refused the pairing request.',
      };
    }
    return { ok: true, deviceToken: body.deviceToken, expiresAt: body.expiresAt };
  } catch {
    return { ok: false, message: 'The relay could not be reached. Check the URL and try again.' };
  }
}
