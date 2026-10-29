import { resolvePairingTarget, untrustedRelayWarning } from '../src/net/pairing-target';

/**
 * Which relays a phone knows.
 *
 * A phone can compare a destination against the address its build was made for and the
 * address it was last paired with. Anything else has to be acknowledged by the user
 * before a pairing code goes there.
 */

/** The relay this build was made for. */
const BUILD_ORIGIN = 'https://relay.example.workers.dev';

describe('the relays a phone knows', () => {
  it('knows the relay this build was made for', () => {
    const target = resolvePairingTarget(BUILD_ORIGIN, { buildOrigin: BUILD_ORIGIN });
    expect(target.known).toBe(true);
    expect(target.origin).toBe(BUILD_ORIGIN);
    expect(target.url).toBe(BUILD_ORIGIN);
  });

  it('knows the relay this phone was last paired with', () => {
    const target = resolvePairingTarget(BUILD_ORIGIN, {
      buildOrigin: null,
      lastOrigin: BUILD_ORIGIN,
    });
    expect(target.known).toBe(true);
  });

  it('does not know a relay it has never seen', () => {
    const target = resolvePairingTarget('https://other.example.workers.dev', {
      buildOrigin: BUILD_ORIGIN,
      lastOrigin: BUILD_ORIGIN,
    });
    expect(target.known).toBe(false);
    expect(target.expectedOrigin).toBe(BUILD_ORIGIN);
  });

  it('compares origins, not the whole address', () => {
    // The same relay with a path on it is the same relay.
    const target = resolvePairingTarget('https://relay.example.workers.dev/relay', {
      buildOrigin: BUILD_ORIGIN,
    });
    expect(target.known).toBe(true);
  });

  it('reads a websocket address as the relay behind it', () => {
    const target = resolvePairingTarget('wss://relay.example.workers.dev', {
      buildOrigin: BUILD_ORIGIN,
    });
    expect(target.known).toBe(true);
    expect(target.url).toBe(BUILD_ORIGIN);
  });

  it('names the destination in the warning', () => {
    const target = resolvePairingTarget('https://other.example.workers.dev', {
      buildOrigin: BUILD_ORIGIN,
    });
    const warning = untrustedRelayWarning(target);
    expect(warning).toContain('https://other.example.workers.dev');
    expect(warning).toContain(BUILD_ORIGIN);
  });

  it('says what it is doing when the phone has not paired before', () => {
    const target = resolvePairingTarget('https://relay.example.workers.dev', {});
    expect(target.known).toBe(false);
    expect(target.expectedOrigin).toBeNull();
    expect(untrustedRelayWarning(target)).toContain('https://relay.example.workers.dev');
  });
});
