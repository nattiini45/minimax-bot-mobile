/**
 * Worker entry.
 *
 * The Worker is a thin router: it validates the request shape, picks the Durable Object
 * for the account and forwards. All relay behaviour lives in the Durable Object's
 * {@link RelaySession}.
 */

import { describeRelayError, verifyToken, type RelayErrorCode } from '@minimax-bot/protocol';

import { accountIdFromPath } from './account-path.js';
import { Relay, type RelayEnv } from './relay.js';

// The Durable Object must be exported from the entrypoint so Wrangler can bind it.
export { Relay };

export interface WorkerEnv extends RelayEnv {
  RELAY: DurableObjectNamespace<Relay>;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  // The PWA is always a different origin from the relay (the app is a static export
  // served from somewhere else), and `POST` with a JSON body triggers a CORS
  // preflight. Without these headers the web client can never pair.
  //
  // `*` is safe here: every route is authenticated by a bearer token or a pairing
  // code, never by a cookie, so there is no ambient authority to leak.
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-max-age': '600',
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    // Preflight: answer it before anything else so the browser lets the real
    // request through.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    // /r/:accountId/...
    if (segments[0] !== 'r' || !segments[1]) {
      return json({ error: 'bad_request', message: 'Expected /r/:accountId/...' }, 400);
    }
    const accountId = accountIdFromPath(url.pathname);
    const rest = segments.slice(2);
    const stub = env.RELAY.getByName(accountId);

    try {
      if (rest[0] === 'ws') {
        // The WebSocket upgrade must carry its own auth in the query string, because the
        // browser WebSocket API cannot set headers.
        //
        // The token is checked here as well as in the Durable Object. This is the cheap
        // check: it refuses a bridge token that was minted for another account before
        // the request ever reaches the room that holds the conversation. The Durable
        // Object repeats it, and that is the one that counts — the Worker is a front
        // door, the object owns the room.
        //
        // A device token carries no account claim. The relay scopes a device by the
        // device registry of the account's own object, and that check lives there.
        const requestedRole = url.searchParams.get('role');
        const payload = await verifyToken(url.searchParams.get('token') ?? '', env.RELAY_SECRET);
        if (!payload || payload.role !== requestedRole) {
          return json({ error: 'unauthorized', message: 'The token is not valid.' }, 401);
        }
        if (payload.role === 'bridge' && payload.acc !== accountId) {
          return json(
            { error: 'unauthorized', message: 'The bridge token is not valid for this account.' },
            401,
          );
        }
        const upgraded = await stub.fetch(request);
        return upgraded;
      }

      if (rest[0] === 'pair' && rest[1] === 'code' && request.method === 'POST') {
        const body = await readJson(request);
        const bridgeId = typeof body.bridgeId === 'string' ? body.bridgeId : '';
        const bridgeName = typeof body.bridgeName === 'string' ? body.bridgeName : 'Desktop';
        const token = bearer(request);
        if (!bridgeId || !token) {
          return relayError('BAD_REQUEST', 'bridgeId and a bearer token are required', 400);
        }
        const verified = await verifyBridge(token, bridgeId, env.RELAY_SECRET);
        if (!verified) {
          return relayError('UNAUTHORIZED', 'The bridge token is not valid.', 401);
        }
        try {
          const result = await stub.createPairingCode(bridgeId, bridgeName);
          return json(result, 200);
        } catch (error) {
          // Another desktop already owns this account. It must not be able to take it
          // over: it would mint a device token inside someone else's account.
          if (error instanceof Error && error.message === 'ACCOUNT_OWNED') {
            return relayError('ACCOUNT_OWNED', 'This account already belongs to another desktop.', 409);
          }
          throw error;
        }
      }

      if (rest[0] === 'pair' && request.method === 'POST') {
        const body = await readJson(request);
        const code = typeof body.code === 'string' ? body.code : '';
        const deviceId = typeof body.deviceId === 'string' ? body.deviceId : '';
        const deviceName = typeof body.deviceName === 'string' ? body.deviceName : 'Phone';
        const clientVersion = typeof body.clientVersion === 'string' ? body.clientVersion : 'unknown';
        if (!code || !deviceId) {
          return relayError('BAD_REQUEST', 'code and deviceId are required', 400);
        }
        const result = await stub.pairDevice(code, deviceId, deviceName, clientVersion);
        return json(result, result.ok ? 200 : 400);
      }

      if (rest[0] === 'status' && request.method === 'GET') {
        return json(await stub.status(), 200);
      }

      if (rest[0] === 'devices' && rest[1] && request.method === 'GET') {
        // The device list carries credentials, so it is bridge-only. The phone never
        // needs it; the desktop is the one that shows the paired devices.
        const authorized = await authorizeBridge(request, stub, env.RELAY_SECRET);
        if (!authorized) {
          return relayError('UNAUTHORIZED', 'The bridge token is not valid.', 401);
        }
        // Never hand the device tokens back, not even to the bridge.
        const devices = (await stub.listDevices()).map((device) => {
          const { token: _token, ...rest } = device as { token?: string };
          return rest;
        });
        return json({ devices }, 200);
      }

      if (rest[0] === 'devices' && rest[1] && request.method === 'DELETE') {
        // Revocation is a privileged action: without this check anyone who guessed
        // the account id could unpair a phone.
        const authorized = await authorizeBridge(request, stub, env.RELAY_SECRET);
        if (!authorized) {
          return relayError('UNAUTHORIZED', 'The bridge token is not valid.', 401);
        }
        const revoked = await stub.revokeDevice(rest[1]);
        return json({ revoked }, revoked ? 200 : 404);
      }

      return json({ error: 'not_found', message: 'Unknown route.' }, 404);
    } catch (error) {
      return json(
        { error: 'internal', message: error instanceof Error ? error.message : 'unexpected error' },
        500,
      );
    }
  },
};

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function relayError(code: RelayErrorCode, message: string, status: number): Response {
  return json({ ok: false, code, message: message || describeRelayError(code) }, status);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

async function verifyBridge(token: string, bridgeId: string, secret: string): Promise<boolean> {
  const payload = await verifyToken(token, secret);
  return payload !== null && payload.role === 'bridge' && payload.sub === bridgeId;
}

/**
 * Authorises a privileged, account-scoped action (listing or revoking devices).
 *
 * The token must be a valid bridge token, and it must name the bridge that owns this
 * account — otherwise a desktop of one account could unpair the phones of another.
 * An account that no bridge has claimed yet has nothing to protect, so any valid
 * bridge token is accepted there.
 */
async function authorizeBridge(
  request: Request,
  stub: DurableObjectStub<Relay>,
  secret: string,
): Promise<boolean> {
  const token = bearer(request);
  if (!token) return false;
  const payload = await verifyToken(token, secret);
  if (!payload || payload.role !== 'bridge') return false;
  const owner = await stub.ownerBridgeId();
  return owner === null || payload.sub === owner;
}
