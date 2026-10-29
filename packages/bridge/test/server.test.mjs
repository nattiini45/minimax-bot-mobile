import assert from 'node:assert/strict';
import test from 'node:test';

import { handle } from '../miniapp/node/server.mjs';

const SECRET = 'the-per-process-secret';

/**
 * A request the surface can read.
 *
 * `readJson` walks the request as an async iterable of chunks, so the fake has to
 * be one. It is typed as `any` because it stands in for a socket request.
 *
 * @returns {any}
 */
function fakeRequest(method, path, { headers = {}, body = null } = {}) {
  const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  return {
    method,
    url: `http://127.0.0.1${path}`,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/**
 * A response the surface can write to.
 *
 * @returns {any}
 */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk;
    },
  };
}

/** The dependencies the surface needs, with the configuration the desktop starts from. */
function makeDeps(overrides = {}) {
  const state = {
    config: {
      relayUrl: 'https://relay.example.workers.dev',
      accountId: 'default',
      bridgeId: 'bridge-1',
      bridgeToken: 'token-1',
      bridgeName: 'Desktop',
    },
  };
  return {
    state,
    bridge: {
      relay: { configured: true, connected: true, listDevices: async () => [] },
      diagnostics: () => ({}),
      pending: { list: () => [] },
    },
    context: {},
    secret: SECRET,
    getConfig: () => state.config,
    setConfig: async (next) => {
      state.config = next;
    },
    ...overrides,
  };
}

const TRUSTED = { 'content-type': 'application/json', 'x-bridge-secret': SECRET };

async function postConfig(body, deps = makeDeps()) {
  const response = fakeResponse();
  await handle(fakeRequest('POST', '/api/config', { headers: TRUSTED, body }), response, deps);
  return { response, deps };
}

test('a relay address that is not one the bridge may use is refused', async () => {
  for (const relayUrl of [
    'http://169.254.169.254',
    'http://10.0.0.5:8787',
    'http://192.168.1.10:8787',
    'http://relay.example.workers.dev',
    'file:///etc/passwd',
  ]) {
    const { response, deps } = await postConfig({ relayUrl });
    assert.equal(response.status, 400, `expected ${relayUrl} to be refused`);
    // The configuration is untouched.
    assert.equal(deps.state.config.relayUrl, 'https://relay.example.workers.dev');
  }
});

test('pointing the bridge at a different relay without a token for it is refused', async () => {
  // This is the one that hands the long-lived bridge token to a third party: the
  // token was minted for the current relay, and it must not travel to another one.
  const { response, deps } = await postConfig({ relayUrl: 'https://other.example.workers.dev' });

  assert.equal(response.status, 400);
  assert.equal(deps.state.config.relayUrl, 'https://relay.example.workers.dev');
  assert.equal(deps.state.config.bridgeToken, 'token-1');
});

test('pointing the bridge at a different account without a token for it is refused', async () => {
  const { response, deps } = await postConfig({ accountId: 'other-account' });

  assert.equal(response.status, 400);
  assert.equal(deps.state.config.accountId, 'default');
});

test('a different relay is accepted when a token minted for it comes with it', async () => {
  const { response, deps } = await postConfig({
    relayUrl: 'https://other.example.workers.dev',
    bridgeToken: 'token-2',
  });

  assert.equal(response.status, 200);
  assert.equal(deps.state.config.relayUrl, 'https://other.example.workers.dev');
  assert.equal(deps.state.config.bridgeToken, 'token-2');
});

test('the same relay with the same account needs no new token', async () => {
  const { response, deps } = await postConfig({ bridgeName: 'Work' });

  assert.equal(response.status, 200);
  assert.equal(deps.state.config.bridgeName, 'Work');
  assert.equal(deps.state.config.bridgeToken, 'token-1');
});

test('a spelling change of the same relay is not a change of relay', async () => {
  // `wss://` and `https://` name the same relay, so the token stays.
  const { response, deps } = await postConfig({ relayUrl: 'wss://relay.example.workers.dev' });

  assert.equal(response.status, 200);
  assert.equal(deps.state.config.bridgeToken, 'token-1');
});

test('the configuration never echoes the bridge token back', async () => {
  const { response } = await postConfig({ relayUrl: 'https://other.example.workers.dev', bridgeToken: 'token-2' });

  assert.equal(response.status, 200);
  assert.equal(response.body.includes('token-1'), false);
  assert.equal(response.body.includes('token-2'), false);
});

test('a request without the surface secret cannot change the configuration', async () => {
  const response = fakeResponse();
  await handle(
    fakeRequest('POST', '/api/config', {
      headers: { 'content-type': 'application/json' },
      body: { relayUrl: 'https://other.example.workers.dev' },
    }),
    response,
    makeDeps(),
  );

  assert.equal(response.status, 403);
});
