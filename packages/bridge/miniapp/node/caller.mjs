/**
 * Who is allowed to talk to the bridge's loopback surface.
 *
 * The surface binds loopback, so every process on the machine — and every page in
 * the user's browser — can reach the port. Two headers narrow that down to the
 * desktop surface:
 *
 * - `Host` is set by the browser from the address the page was loaded from, and
 *   the desktop surface is loaded from the bridge's own address. A hostile page
 *   that resolves its own name to the loopback address — DNS rebinding — sends
 *   its own hostname instead, and is refused.
 * - `Origin` is set by the browser from the page that made the request, and a
 *   cross-site request never carries the surface's own origin.
 *
 * Neither header is a secret, so neither is enough on its own: a local process
 * can send either one. They are what makes the per-process secret hard to get
 * hold of in the first place. Without them, a page could read `GET /api/session`
 * and then do anything the surface can do.
 */

/**
 * @typedef {object} Surface
 * @property {string} host The address the Host assigned to the bridge.
 * @property {number} port The port the Host assigned to the bridge.
 */

/**
 * @typedef {{ok: true} | {ok: false, message: string}} Verdict
 */

/**
 * Decides whether a request may be answered.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {Surface} surface
 * @returns {Verdict}
 */
export function checkCaller(request, surface) {
  const headers = request.headers ?? {};

  const host = headers['host'];
  const address = typeof host === 'string' ? parseHost(host) : null;
  if (!address) {
    return { ok: false, message: 'The request did not name the bridge.' };
  }
  if (!isLoopbackHost(address.hostname)) {
    return { ok: false, message: 'This request was not addressed to this machine.' };
  }
  if (address.port !== surface.port) {
    return { ok: false, message: 'This request was not addressed to this bridge.' };
  }

  const origin = headers['origin'];
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    let from = null;
    try {
      from = new URL(origin);
    } catch {
      return { ok: false, message: 'This request came from somewhere else.' };
    }
    if (!isLoopbackHost(from.hostname) || Number(from.port) !== surface.port) {
      return { ok: false, message: 'This request came from somewhere else.' };
    }
  }

  // The browser says where the request came from, and a cross-site request is
  // exactly what the two checks above are about.
  const fetchSite = headers['sec-fetch-site'];
  if (typeof fetchSite === 'string' && fetchSite === 'cross-site') {
    return { ok: false, message: 'This request came from somewhere else.' };
  }

  return { ok: true };
}

/**
 * The host and port a `Host` header names.
 *
 * @param {string} value
 * @returns {{hostname: string, port: number | null} | null}
 */
function parseHost(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;

  // An IPv6 literal: `[::1]:53378`.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return {
      hostname: bracketed[1],
      port: bracketed[2] === undefined ? null : Number(bracketed[2]),
    };
  }

  const index = trimmed.lastIndexOf(':');
  if (index === -1) return { hostname: trimmed, port: null };
  const port = trimmed.slice(index + 1);
  if (!/^\d+$/.test(port)) return null;
  return { hostname: trimmed.slice(0, index), port: Number(port) };
}

/**
 * Whether a hostname names this machine.
 *
 * The bridge binds loopback, so the only hostnames that can name it are the
 * loopback address and the names that mean it. A name that merely *contains* a
 * loopback address — `127.0.0.1.example.com` — names somewhere else.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
function isLoopbackHost(hostname) {
  const host = String(hostname ?? '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (host === 'localhost') return true;
  if (host === '::1') return true;
  // 127.0.0.0/8 is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
