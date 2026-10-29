/**
 * Pairing against a relay.
 *
 * The phone types the six digit code the desktop shows; the relay exchanges it for a
 * device scoped token. The token is the only credential the phone ever holds.
 */

import { isValidPairingCode, type PairingResponse } from '@minimax-bot/protocol';

import { relayHttpUrl } from './relay-url';

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
}): Promise<PairingResult> {
  const code = params.code.trim();
  if (!isValidPairingCode(code)) {
    return { ok: false, message: 'Enter the six digit code shown on your desktop.' };
  }

  const base = relayHttpUrl(params.url);
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
