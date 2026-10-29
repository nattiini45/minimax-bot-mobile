/**
 * Whether a verified token may act on an account.
 *
 * The account is part of the signed token, so this is the one place that decides
 * it. A bridge token is bound to the account it was minted for: it may not list
 * or revoke another account's devices, and it may not ask another account for a
 * pairing code.
 *
 * It is deliberately separate from the owner check. The owner says "this room
 * belongs to that desktop"; the account says "this credential belongs to that
 * room". A relay that hosts many accounts needs both: the owner check alone
 * accepts any valid bridge token against a room nobody has claimed yet.
 */

import type { TokenPayload } from '@minimax-bot/protocol';

/**
 * Whether a token may act on this account.
 *
 * @param payload the verified token, or null when it did not verify
 * @param accountId the account the request is addressed to
 */
export function isBridgeTokenForAccount(
  payload: TokenPayload | null,
  accountId: string,
): payload is TokenPayload {
  if (!payload || payload.role !== 'bridge') return false;
  return typeof payload.acc === 'string' && payload.acc === accountId;
}
