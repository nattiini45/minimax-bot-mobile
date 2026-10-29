/**
 * Where a pairing code may be sent.
 *
 * The pairing code is a one-time credential: the relay exchanges it for a device token
 * that is good for a month, and the token is the only credential the phone holds. The
 * address in the pairing form is free text, so a user who is talked into typing an
 * address that is not theirs sends that code to whoever is listening - and the listener
 * can use it, or forward it to the real relay and keep the token.
 *
 * The phone knows two addresses it can compare a destination against: the one this
 * build was made for, and the one it was last paired with. A destination that is
 * neither of them is not refused outright - a self-hosted relay is a legitimate thing
 * to type - but the user has to acknowledge it before the code leaves the phone.
 */

import { relayHttpUrl, relayOrigin } from './relay-url';

export interface PairingTarget {
  /** The address the code would be sent to, in the form the request uses. */
  url: string;
  /** The origin of that address. */
  origin: string;
  /** True when the phone already knows this origin. */
  known: boolean;
  /** The origin the phone expected, when it expected one. */
  expectedOrigin: string | null;
}

export interface KnownRelays {
  /** The origin of the address this build was made for. */
  buildOrigin?: string | null;
  /** The origin of the relay this phone was last paired with. */
  lastOrigin?: string | null;
}

/**
 * Works out where a pairing code would go, and whether the phone knows that place.
 */
export function resolvePairingTarget(url: string, known: KnownRelays = {}): PairingTarget {
  const http = relayHttpUrl(url).trim().replace(/\/+$/, '');
  const origin = relayOrigin(url);
  const knownOrigins = [known.buildOrigin, known.lastOrigin].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return {
    url: http,
    origin,
    known: origin !== '' && knownOrigins.includes(origin),
    // The relay the phone is actually paired with is the one that matters when the two
    // differ; the build's address is the fallback.
    expectedOrigin: known.lastOrigin || known.buildOrigin || null,
  };
}

/**
 * The warning shown before a code goes to an address the phone does not know.
 *
 * It names the destination in full: the whole point is that the user can compare it
 * with the address on the desktop and see that they are not the same one.
 */
export function untrustedRelayWarning(target: PairingTarget): string {
  if (!target.expectedOrigin) {
    return `This phone has not paired with a relay yet. The code will be sent to ${target.origin}.`;
  }
  return `This phone is paired with ${target.expectedOrigin}. The code will be sent to ${target.origin}, which is a different relay.`;
}
