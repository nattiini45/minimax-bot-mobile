/**
 * Mini App entry point.
 *
 * `start(context)` is the contract the Host requires. The bridge listens on the address
 * the Host assigns (always loopback) and serves the small `/api` surface the desktop
 * surface uses to show a pairing code and manage paired phones.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

import { Bridge } from './bridge.mjs';
import { checkCaller } from './caller.mjs';
import { isAllowedRelayUrl, loadConfig, relayOrigin, saveConfig } from './config.mjs';

const MAX_BODY = 256 * 1024;

export async function start(context) {
  const logger = context.logger;
  const config = await loadConfig(context.dataDir);

  const bridge = new Bridge(context, { config, logger });

  /**
   * The secret that proves a mutating request came from the desktop surface.
   *
   * It is handed out by `GET /api/session`, which only answers a caller whose own
   * headers say it is the surface, and it is regenerated every time the bridge
   * starts.
   */
  const secret = randomBytes(32).toString('hex');

  /**
   * The address the Host assigned to this bridge.
   *
   * The desktop surface is served from this address, so it is also the only origin
   * a legitimate request can come from.
   */
  const surface = { host: context.listen.host, port: context.listen.port };

  /**
   * Writes the configuration and hands it to the live bridge.
   *
   * @param {import('./config.mjs').BridgeConfig} next
   */
  const setConfig = async (next) => {
    await saveConfig(context.dataDir, next);
    bridge.config = next;
    bridge.relay.url = next.relayUrl;
    bridge.relay.accountId = next.accountId;
    bridge.relay.bridgeId = next.bridgeId;
    bridge.relay.token = next.bridgeToken;
    bridge.relay.name = next.bridgeName;
    bridge.relay.start();
  };

  const server = createServer((request, response) => {
    // The bridge's own configuration is the live one: a rotated token changes it,
    // and the surface must not answer with a token the relay has already revoked.
    handle(request, response, {
      bridge,
      context,
      secret,
      surface,
      getConfig: () => bridge.config,
      setConfig,
    }).catch((error) => {
      logger.error(`request failed: ${error instanceof Error ? error.message : error}`);
      json(response, 500, { error: 'internal' });
    });
  });

  await bridge.start();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(context.listen.port, context.listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.info('bridge listening', { host: context.listen.host, port: context.listen.port });

  const onAbort = () => {
    bridge.stop();
    server.close();
  };
  context.signal.addEventListener('abort', onAbort, { once: true });

  return {
    dispose() {
      context.signal.removeEventListener('abort', onAbort);
      onAbort();
    },
  };
}

/**
 * Handles one request.
 *
 * Exported so the surface can be tested without a socket: the routes that matter
 * here are the ones that decide whether a request may change the bridge's
 * configuration.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {any} deps
 */
export async function handle(request, response, deps) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = url.pathname;

  // The surface binds loopback, so every process on the machine — and every page
  // in the user's browser — can reach the port. The caller's own headers say
  // whether this is the desktop surface, and a request that fails to say so is
  // not answered at all: not with the account details, and not with the secret.
  const caller = checkCaller(request, deps.surface);
  if (caller.ok === false) {
    return json(response, 403, { error: 'forbidden', message: caller.message });
  }

  // Everything that can change state is restricted to the desktop surface.
  //
  // `POST /api/config` in particular can point the bridge at another relay, which
  // would hand that relay the bridge token and every frame that follows — so a
  // request from a page the user did not open must never be honoured.
  if (request.method !== 'GET' && !isTrustedRequest(request, deps)) {
    return json(response, 403, { error: 'forbidden', message: 'This request did not come from the bridge surface.' });
  }

  if (request.method === 'GET' && path === '/api/health') {
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && path === '/api/session') {
    // The secret is the last thing that goes wrong: a page that cannot be shown to
    // be the surface never gets this far, and the surface is the only thing that
    // can read the answer.
    return json(response, 200, { secret: deps.secret });
  }

  if (request.method === 'GET' && path === '/api/status') {
    // The account id and the relay address are what an attacker aims with, so they
    // are not handed to a caller that has not shown it holds the surface secret.
    if (!hasSecret(request, deps)) {
      return json(response, 403, { error: 'forbidden', message: 'This request did not come from the bridge surface.' });
    }
    const { bridge, getConfig } = deps;
    const config = getConfig();
    return json(response, 200, {
      bridgeId: config.bridgeId,
      bridgeName: config.bridgeName,
      relayConfigured: bridge.relay.configured,
      relayConnected: bridge.relay.connected,
      relayUrl: config.relayUrl,
      accountId: config.accountId,
      diagnostics: bridge.diagnostics(),
      pending: bridge.pending.list().length,
    });
  }

  if (request.method === 'POST' && path === '/api/pair/code') {
    const { bridge } = deps;
    try {
      const result = await bridge.relay.createPairingCode();
      return json(response, 200, result);
    } catch (error) {
      return json(response, 400, {
        error: 'PAIRING_UNAVAILABLE',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (request.method === 'POST' && path === '/api/rotate-token') {
    const { bridge } = deps;
    try {
      await bridge.rotateToken();
      return json(response, 200, { ok: true });
    } catch (error) {
      return json(response, 502, {
        error: 'rotation_failed',
        message:
          error instanceof Error ? error.message : 'The relay refused the token rotation.',
      });
    }
  }

  if (request.method === 'GET' && path === '/api/devices') {
    if (!hasSecret(request, deps)) {
      return json(response, 403, { error: 'forbidden', message: 'This request did not come from the bridge surface.' });
    }
    const { bridge } = deps;
    return json(response, 200, { devices: await bridge.relay.listDevices() });
  }

  if (request.method === 'DELETE' && path.startsWith('/api/devices/')) {
    const { bridge } = deps;
    let deviceId;
    try {
      deviceId = decodeURIComponent(path.slice('/api/devices/'.length));
    } catch {
      return json(response, 400, { error: 'bad_request', message: 'Malformed device id.' });
    }
    const revoked = await bridge.revokeDevice(deviceId);
    return json(response, revoked ? 200 : 404, { revoked });
  }

  if (request.method === 'GET' && path === '/api/snapshot') {
    if (!hasSecret(request, deps)) {
      return json(response, 403, { error: 'forbidden', message: 'This request did not come from the bridge surface.' });
    }
    const { bridge } = deps;
    const team = await bridge.readTeam();
    return json(response, 200, {
      ...team,
      diagnostics: bridge.diagnostics(),
      tools: bridge.tools.catalog,
    });
  }

  if (request.method === 'POST' && path === '/api/config') {
    const body = await readJson(request);
    if (body === null) {
      return json(response, 413, { error: 'too_large', message: 'The request body is too large.' });
    }
    const { getConfig, setConfig } = deps;
    const current = getConfig();

    const nextRelayUrl =
      typeof body.relayUrl === 'string' && body.relayUrl.length > 0
        ? body.relayUrl
        : current.relayUrl;
    if (!isAllowedRelayUrl(nextRelayUrl)) {
      return json(response, 400, {
        error: 'bad_request',
        message: 'That relay address is not one the bridge may use.',
      });
    }

    const nextAccountId =
      typeof body.accountId === 'string' && body.accountId.length > 0
        ? body.accountId
        : current.accountId;

    // The bridge token is the relay's credential for this desktop, and it is minted
    // for one relay and one account. Pointing the bridge at a different relay — or a
    // different room — while carrying the current token over would hand that
    // credential to whoever is on the other end. A change of target therefore needs
    // a token minted for it.
    const suppliedToken =
      typeof body.bridgeToken === 'string' && body.bridgeToken.length > 0
        ? body.bridgeToken
        : null;
    const targetChanged =
      relayOrigin(nextRelayUrl) !== relayOrigin(current.relayUrl) ||
      nextAccountId !== current.accountId;
    if (targetChanged && !suppliedToken) {
      return json(response, 400, {
        error: 'bad_request',
        message: 'A different relay or account needs a token minted for it.',
      });
    }

    const next = {
      ...current,
      relayUrl: nextRelayUrl,
      accountId: nextAccountId,
      bridgeName: typeof body.bridgeName === 'string' ? body.bridgeName : current.bridgeName,
      // The bridge id is the subject of the bridge token, so it has to be pinnable:
      // a token is minted for one specific bridge id, and the desktop must be told
      // which id it is before the token is pasted in.
      bridgeId:
        typeof body.bridgeId === 'string' && body.bridgeId.length > 0
          ? body.bridgeId
          : current.bridgeId,
      // The bridge token is the relay's credential for this desktop. It is minted by
      // whoever holds the relay secret and pasted into the surface, so it has to be
      // settable here — but never echoed back, not even to the surface that set it.
      bridgeToken: suppliedToken ?? current.bridgeToken,
    };
    await setConfig(next);
    return json(response, 200, { ok: true, config: { ...next, bridgeToken: undefined } });
  }

  return json(response, 404, { error: 'not_found' });
}

/**
 * Whether the caller holds the bridge's per-process secret.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {any} deps
 * @returns {boolean}
 */
function hasSecret(request, deps) {
  const presented = request.headers['x-bridge-secret'];
  return typeof presented === 'string' && presented === deps.secret;
}

/**
 * Whether a mutating request came from the bridge's own desktop surface.
 *
 * The bridge binds loopback, so a page in the user's browser can still reach it —
 * `POST /api/config` in particular can point the bridge at another relay, which
 * would hand that relay the bridge token and every frame that follows. Two
 * independent checks, because either alone is bypassable:
 *
 * - The body must be `application/json`. That content type is not CORS-safelisted,
 *   so a cross-site request from a page the user opened always triggers a preflight,
 *   and the bridge answers no preflight — the browser blocks the request outright.
 * - The request must carry the per-process secret. The secret is handed out by
 *   `GET /api/session`, which only answers a caller whose own headers show it is
 *   the surface, so a hostile page can never obtain it.
 */
function isTrustedRequest(request, deps) {
  const contentType = request.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) return false;

  return hasSecret(request, deps);
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    // The surface answers JSON and nothing else, so the browser has no reason to
    // guess, and it has no reason to run anything either.
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

/**
 * Reads a JSON body.
 *
 * Returns `null` when the body is too large, so the caller can answer 413 instead
 * of silently treating an oversized body as an empty one.
 *
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<Record<string, unknown> | null>}
 */
async function readJson(request) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) return null;
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
