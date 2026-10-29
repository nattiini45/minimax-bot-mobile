import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedRelayUrl, relayOrigin } from '../miniapp/node/config.mjs';

test('a secure relay is allowed wherever it is', () => {
  assert.equal(isAllowedRelayUrl('https://relay.example.workers.dev'), true);
  assert.equal(isAllowedRelayUrl('wss://relay.example.workers.dev'), true);
  assert.equal(isAllowedRelayUrl('https://relay.example.workers.dev/r/default'), true);
});

test('a cleartext relay is allowed only on the loopback interface', () => {
  assert.equal(isAllowedRelayUrl('http://127.0.0.1:8787'), true);
  assert.equal(isAllowedRelayUrl('ws://127.0.0.1:8787'), true);
  assert.equal(isAllowedRelayUrl('http://localhost:8787'), true);
  assert.equal(isAllowedRelayUrl('http://[::1]:8787'), true);
});

test('a cleartext relay anywhere else is refused', () => {
  // The token would cross the network in the clear.
  assert.equal(isAllowedRelayUrl('http://relay.example.workers.dev'), false);
  // A LAN host is reachable but not trusted.
  assert.equal(isAllowedRelayUrl('http://192.168.1.10:8787'), false);
  assert.equal(isAllowedRelayUrl('http://10.0.0.5:8787'), false);
  // Link-local and the cloud metadata address.
  assert.equal(isAllowedRelayUrl('http://169.254.169.254'), false);
  assert.equal(isAllowedRelayUrl('http://[fe80::1]:8787'), false);
  // The metadata address over TLS is still not a relay.
  assert.equal(isAllowedRelayUrl('https://169.254.169.254'), true);
});

test('an address that is not a relay address is refused', () => {
  assert.equal(isAllowedRelayUrl(''), false);
  assert.equal(isAllowedRelayUrl('   '), false);
  assert.equal(isAllowedRelayUrl('relay.example.workers.dev'), false);
  assert.equal(isAllowedRelayUrl('file:///etc/passwd'), false);
  assert.equal(isAllowedRelayUrl('javascript:alert(1)'), false);
  assert.equal(isAllowedRelayUrl('https://'), false);
  assert.equal(isAllowedRelayUrl(undefined), false);
});

test('the origin of a relay address is the same for every scheme spelling', () => {
  // The pairing request is HTTP and the frame channel is a WebSocket, so one relay
  // has several spellings. They have to compare as the same relay.
  assert.equal(relayOrigin('https://relay.example.workers.dev'), relayOrigin('wss://relay.example.workers.dev'));
  assert.equal(relayOrigin('http://127.0.0.1:8787'), relayOrigin('ws://127.0.0.1:8787'));
  assert.equal(relayOrigin('https://relay.example.workers.dev/'), relayOrigin('https://relay.example.workers.dev'));
});

test('two different relays have different origins', () => {
  assert.notEqual(
    relayOrigin('https://relay.example.workers.dev'),
    relayOrigin('https://other.example.workers.dev'),
  );
  assert.notEqual(relayOrigin('https://relay.example.workers.dev'), relayOrigin('http://relay.example.workers.dev'));
});

test('an address that is not a relay address has no origin', () => {
  assert.equal(relayOrigin(''), '');
  assert.equal(relayOrigin('nonsense'), '');
});
