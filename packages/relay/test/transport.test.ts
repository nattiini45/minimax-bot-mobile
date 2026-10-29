import { describe, expect, it } from 'vitest';

import { isCleartextRequestRefused, isLoopbackHost } from '../src/transport.js';

describe('the loopback interface', () => {
  it('is the loopback interface', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('is not anything else', () => {
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
    expect(isLoopbackHost('169.254.169.254')).toBe(false);
    expect(isLoopbackHost('relay.example.workers.dev')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
  });
});

describe('a request that arrived in the clear', () => {
  it('is refused when it did not come from the loopback interface', () => {
    // The relay carries a device token that lives thirty days and a bridge token
    // that lives as long as the desktop does. A request that arrives in the
    // clear hands them to the network.
    expect(isCleartextRequestRefused('http:', 'relay.example.workers.dev')).toBe(true);
    expect(isCleartextRequestRefused('http:', '192.168.1.10')).toBe(true);
    expect(isCleartextRequestRefused('http:', '169.254.169.254')).toBe(true);
  });

  it('is allowed on the loopback interface, where it never leaves the machine', () => {
    // This is the relay a developer runs with `wrangler dev`.
    expect(isCleartextRequestRefused('http:', '127.0.0.1')).toBe(false);
    expect(isCleartextRequestRefused('http:', 'localhost')).toBe(false);
  });

  it('is not a thing when the request arrived over tls', () => {
    expect(isCleartextRequestRefused('https:', 'relay.example.workers.dev')).toBe(false);
  });
});
