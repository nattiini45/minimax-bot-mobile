/**
 * The transport the relay answers on.
 *
 * The relay carries long-lived tokens — a device token lives thirty days — so
 * a request that arrived in the clear is refused rather than answered. The
 * exception is the loopback interface: that is the relay a developer runs on
 * their own machine, and its traffic never leaves the machine.
 */

/**
 * Whether a host is the loopback interface.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === '::1') return true;
  // 127.0.0.0/8 is loopback.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Whether a request to this URL has to be refused for arriving in the clear.
 *
 * @param {string} protocol the URL's protocol, with its colon
 * @param {string} hostname the URL's hostname
 * @returns {boolean}
 */
export function isCleartextRequestRefused(protocol: string, hostname: string): boolean {
  if (protocol !== 'http:') return false;
  return !isLoopbackHost(hostname);
}
