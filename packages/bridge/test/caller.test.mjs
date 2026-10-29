import assert from 'node:assert/strict';
import test from 'node:test';

import { checkCaller } from '../miniapp/node/caller.mjs';

/** The address the Host assigned to the bridge in these tests. */
const SURFACE = { host: '127.0.0.1', port: 53378 };

/**
 * A request as the browser would send it.
 *
 * @param {Record<string, string>} [headers]
 * @returns {any}
 */
function fakeRequest(headers = {}) {
  return { method: 'GET', url: '/api/session', headers };
}

/**
 * @param {Record<string, string>} headers
 * @returns {any}
 */
function requestWith(headers) {
  return fakeRequest(headers);
}

test('the surface itself is welcome', () => {
  const verdict = checkCaller(requestWith({ host: '127.0.0.1:53378' }), SURFACE);
  assert.equal(verdict.ok, true);
});

test('the loopback name is welcome too', () => {
  // A user may reach the surface by another name for the same machine.
  const verdict = checkCaller(requestWith({ host: 'localhost:53378' }), SURFACE);
  assert.equal(verdict.ok, true);
});

test('a request that names another host is refused', () => {
  // DNS rebinding: the page was loaded from its own name, which now resolves to
  // the loopback address. The browser sends that name, and it is not this bridge.
  for (const host of [
    'evil.example:53378',
    'evil.example',
    '127.0.0.1.evil.example:53378',
    'localhost.evil.example:53378',
    '10.0.0.5:53378',
    '169.254.169.254:53378',
  ]) {
    const verdict = checkCaller(requestWith({ host }), SURFACE);
    assert.equal(verdict.ok, false, `expected ${host} to be refused`);
  }
});

test('a request that names another port is refused', () => {
  const verdict = checkCaller(requestWith({ host: '127.0.0.1:1234' }), SURFACE);
  assert.equal(verdict.ok, false);
});

test('a request without a host is refused', () => {
  const verdict = checkCaller(requestWith({}), SURFACE);
  assert.equal(verdict.ok, false);
});

test('a request from another origin is refused', () => {
  const verdict = checkCaller(
    requestWith({ host: '127.0.0.1:53378', origin: 'https://evil.example' }),
    SURFACE,
  );
  assert.equal(verdict.ok, false);
});

test('a request from the surface origin is welcome', () => {
  const verdict = checkCaller(
    requestWith({ host: '127.0.0.1:53378', origin: 'http://127.0.0.1:53378' }),
    SURFACE,
  );
  assert.equal(verdict.ok, true);
});

test('a request from another loopback port is refused', () => {
  // Another page on this machine is a different origin, even though it is
  // loopback.
  const verdict = checkCaller(
    requestWith({ host: '127.0.0.1:53378', origin: 'http://127.0.0.1:1234' }),
    SURFACE,
  );
  assert.equal(verdict.ok, false);
});

test('a cross-site request is refused', () => {
  const verdict = checkCaller(
    requestWith({ host: '127.0.0.1:53378', 'sec-fetch-site': 'cross-site' }),
    SURFACE,
  );
  assert.equal(verdict.ok, false);
});

test('the same-site and same-origin markers are welcome', () => {
  for (const site of ['same-origin', 'same-site', 'none']) {
    const verdict = checkCaller(
      requestWith({ host: '127.0.0.1:53378', 'sec-fetch-site': site }),
      SURFACE,
    );
    assert.equal(verdict.ok, true, `expected ${site} to be welcome`);
  }
});
