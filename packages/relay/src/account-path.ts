/**
 * The account a relay path names.
 *
 * Both the Worker and the Durable Object read the account out of the request
 * path: the Worker routes `/r/:accountId/...` to the object that holds that
 * account, and the object has to check the account itself before it lets a
 * peer into the room. The two sides have to agree on what the path says, so
 * they both parse it through this function rather than each doing it
 * differently.
 */

/**
 * The account named by a request path, or an empty string when the path names
 * no account.
 *
 * `/r/<accountId>/ws` -> `<accountId>`; anything else -> `''`.
 */
export function accountIdFromPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'r') return '';
  return segments[1] ?? '';
}
