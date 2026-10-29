/**
 * The relay address, in the form each transport needs.
 *
 * The pairing request is an HTTP POST and the frame channel is a WebSocket, but the
 * user is given a single address and the scheme they type must not decide which one
 * works. A `wss://` address cannot be fetched — `fetch` refuses a scheme that is not
 * HTTP — and an `https://` address is not a WebSocket URL, so the two are translated
 * into each other instead of failing.
 *
 * The translations are done with string operations on purpose: React Native's `URL`
 * is not a real URL parser and throws on anything but `blob:` and `data:`.
 */

const TO_HTTP: Record<string, string> = {
  'http:': 'http:',
  'https:': 'https:',
  'ws:': 'http:',
  'wss:': 'https:',
};

const TO_WS: Record<string, string> = {
  'http:': 'ws:',
  'https:': 'wss:',
  'ws:': 'ws:',
  'wss:': 'wss:',
};

function translate(url: string, schemes: Record<string, string>): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const match = /^([a-z][a-z0-9+.-]*:)/i.exec(trimmed);
  if (!match) return trimmed;
  const scheme = match[1]!.toLowerCase();
  const target = schemes[scheme];
  if (!target) return trimmed;
  return target + trimmed.slice(scheme.length);
}

/** The relay address as an HTTP origin, for the pairing request and the status read. */
export function relayHttpUrl(url: string): string {
  return translate(url, TO_HTTP);
}

/** The relay address as a WebSocket origin, for the frame channel. */
export function relayWsUrl(url: string): string {
  return translate(url, TO_WS);
}

/**
 * The hosts a cleartext relay may live on.
 *
 * A relay on the loopback interface is on this phone's own machine — the
 * developer runs it with `wrangler dev` — and that traffic never leaves the
 * device. Anything else, including a relay on the same wifi, would carry the
 * pairing code and the device token in the clear.
 */
const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * True when the address names a relay the app can reach.
 *
 * The address has to be a secure one, unless the relay is on this device. The
 * pairing code and the device token are long-lived credentials, and a relay
 * that answers in the clear is a relay that hands them to the network.
 */
export function isValidRelayUrl(url: string): boolean {
  const trimmed = url.trim();
  const match = /^(https?|wss?):\/\/([^/\s]+)(?:\/.*)?$/i.exec(trimmed);
  if (!match) return false;

  const scheme = match[1]!.toLowerCase();
  const authority = match[2]!.toLowerCase();
  if (scheme === 'https' || scheme === 'wss') return true;

  // Cleartext is the relay on this device and nothing else.
  const host = authority.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
  return LOOPBACK.test(host);
}
