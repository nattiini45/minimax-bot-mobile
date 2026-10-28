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

/** True when the address names a relay the app can reach. */
export function isValidRelayUrl(url: string): boolean {
  return /^(https?|wss?):\/\/[^\s/]+(?:\/.*)?$/i.test(url.trim());
}
