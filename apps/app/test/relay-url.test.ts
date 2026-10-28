import { isValidRelayUrl, relayHttpUrl, relayWsUrl } from '../src/net/relay-url';

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

  it('refuses an address that names nothing', () => {
    expect(isValidRelayUrl('')).toBe(false);
    expect(isValidRelayUrl('relay.example.workers.dev')).toBe(false);
    expect(isValidRelayUrl('ftp://relay.example.workers.dev')).toBe(false);
    expect(isValidRelayUrl('https://')).toBe(false);
  });
});
