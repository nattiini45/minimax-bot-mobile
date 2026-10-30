import { isValidRelayUrl, relayHttpUrl, relayOrigin, relayWsUrl } from '../src/net/relay-url';

/**
 * The phone is given one relay address and uses it for two transports: an HTTP
 * request to pair and a WebSocket for the frames. These tests pin the translation
 * between them, because the scheme the user types must not decide which one works.
 */

describe('the relay address', () => {
  it('keeps an http address for the pairing request', () => {
    expect(relayHttpUrl('http://127.0.0.1:8100')).toBe('http://127.0.0.1:8100');
  });

  it('turns a websocket address into one the pairing request can reach', () => {
    expect(relayHttpUrl('wss://relay.example.workers.dev')).toBe('https://relay.example.workers.dev');
    expect(relayHttpUrl('ws://127.0.0.1:8100')).toBe('http://127.0.0.1:8100');
  });

  it('turns an http address into one the frame channel can open', () => {
    expect(relayWsUrl('http://127.0.0.1:8100')).toBe('ws://127.0.0.1:8100');
    expect(relayWsUrl('https://relay.example.workers.dev')).toBe('wss://relay.example.workers.dev');
  });

  it('leaves an address that is already in the right form alone', () => {
    expect(relayWsUrl('ws://127.0.0.1:8100')).toBe('ws://127.0.0.1:8100');
    expect(relayWsUrl('wss://relay.example.workers.dev')).toBe('wss://relay.example.workers.dev');
  });

  it('drops a trailing slash, so the path is not doubled', () => {
    expect(relayHttpUrl('https://relay.example.workers.dev/')).toBe('https://relay.example.workers.dev');
    expect(relayWsUrl('https://relay.example.workers.dev///')).toBe('wss://relay.example.workers.dev');
  });

  it('accepts the addresses a relay really has', () => {
    expect(isValidRelayUrl('https://relay.example.workers.dev')).toBe(true);
    expect(isValidRelayUrl('wss://relay.example.workers.dev')).toBe(true);
    expect(isValidRelayUrl('http://127.0.0.1:8100')).toBe(true);
    expect(isValidRelayUrl('  http://127.0.0.1:8100  ')).toBe(true);
  });

  it('refuses a cleartext relay that is not on this device', () => {
    // The pairing code and the device token would cross the network in the clear.
    expect(isValidRelayUrl('http://relay.example.workers.dev')).toBe(false);
    expect(isValidRelayUrl('ws://relay.example.workers.dev')).toBe(false);
    expect(isValidRelayUrl('http://192.168.1.10:8100')).toBe(false);
    expect(isValidRelayUrl('http://10.0.0.5:8100')).toBe(false);
    expect(isValidRelayUrl('http://169.254.169.254')).toBe(false);
  });

  it('refuses an address that names nothing', () => {
    expect(isValidRelayUrl('')).toBe(false);
    expect(isValidRelayUrl('relay.example.workers.dev')).toBe(false);
    expect(isValidRelayUrl('ftp://relay.example.workers.dev')).toBe(false);
    expect(isValidRelayUrl('https://')).toBe(false);
  });
});

describe('the origin of a relay address', () => {
  it('is the scheme and the host', () => {
    expect(relayOrigin('https://relay.example.workers.dev')).toBe('https://relay.example.workers.dev');
    expect(relayOrigin('wss://relay.example.workers.dev')).toBe('https://relay.example.workers.dev');
    expect(relayOrigin('http://127.0.0.1:8100')).toBe('http://127.0.0.1:8100');
  });

  it('does not let the host be hidden behind a userinfo part', () => {
    // This address reaches `evil.example`, and the origin has to say so: an origin
    // that still named `relay.example` would tell the user they are talking to the
    // trusted relay.
    expect(relayOrigin('https://relay.example.workers.dev@evil.example')).toBe('https://evil.example');
    expect(relayOrigin('https://user:pass@relay.example.workers.dev')).toBe('https://relay.example.workers.dev');
  });

  it('leaves out what an origin does not carry', () => {
    // A query and a fragment are not part of an origin, and a default port is not
    // part of one either: the platform says `https://relay.example:443` and
    // `https://relay.example` are one origin.
    expect(relayOrigin('https://relay.example.workers.dev?q=1')).toBe('https://relay.example.workers.dev');
    expect(relayOrigin('https://relay.example.workers.dev#x')).toBe('https://relay.example.workers.dev');
    expect(relayOrigin('https://relay.example.workers.dev:443')).toBe('https://relay.example.workers.dev');
    expect(relayOrigin('http://relay.example.workers.dev:80')).toBe('http://relay.example.workers.dev');
    // A port that is not the default is part of the origin.
    expect(relayOrigin('https://relay.example.workers.dev:8443')).toBe('https://relay.example.workers.dev:8443');
  });

  it('refuses an address that carries credentials in it', () => {
    // A relay address never needs a userinfo part.
    expect(isValidRelayUrl('https://relay.example.workers.dev@evil.example')).toBe(false);
    expect(isValidRelayUrl('https://user:pass@relay.example.workers.dev')).toBe(false);
  });
});
