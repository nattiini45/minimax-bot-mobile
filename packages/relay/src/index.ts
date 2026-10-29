/**
 * Worker entry.
 *
 * The Worker is a thin router: it validates the request shape, picks the Durable Object
 * for the account and forwards. All relay behaviour lives in the Durable Object's
 * {@link RelaySession}.
 */

import { describeRelayError, verifyToken, type RelayErrorCode } from '@minimax-bot/protocol';

import { accountIdFromPath } from './account-path.js';
import { isBridgeTokenForAccount } from './authorize.js';
import { Relay, type RelayEnv } from './relay.js';
import { isCleartextRequestRefused } from './transport.js';

// The Durable Object must be exported from the entrypoint so Wrangler can bind it.
export { Relay };

export interface WorkerEnv extends RelayEnv {
  RELAY: DurableObjectNamespace<Relay>;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  // The relay is reached over the internet in production and it carries
  // long-lived tokens, so the browser should refuse to talk to it in the clear
  // even after the first visit.
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
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

    // The relay carries long-lived tokens, so a request that arrived in the
    // clear is refused rather than answered. A client that asks for `http://`
    // then fails loudly instead of sending a pairing code or a device token
    // across the network in the clear.
    //
    // The loopback exception is the relay a developer runs on their own machine:
    // that traffic never leaves the machine, and it is how the bridge is
    // developed against.
    if (isCleartextRequestRefused(url.protocol, url.hostname)) {
      return json(
        {
          error: 'https_required',
          message: 'The relay only answers over https. Use an https:// or wss:// address.',
        },
        400,
      );
    }

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
        // The WebSocket upgrade has to carry the peer's credential, and the
        // browser WebSocket API cannot set a header - so it travels in the query
        // string, which is the part of a request that proxies and log pipelines
        // keep. A peer that has shown its credential elsewhere asks for a ticket
        // first, and the ticket is what rides in the URL: it is good for one
        // connection and for half a minute.
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
        const credential = url.searchParams.get('ticket') ?? url.searchParams.get('token') ?? '';
        const payload = await verifyToken(credential, env.RELAY_SECRET);
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

      // A peer asks for a ticket for its next connection.
      //
      // The peer shows its credential here, over an ordinary request that can
      // carry a header, and gets back something that may travel in a URL.
      if (rest[0] === 'ws-ticket' && request.method === 'POST') {
        const token = bearer(request);
        const payload = await verifyToken(token, env.RELAY_SECRET);
        if (!payload) {
          return relayError('UNAUTHORIZED', 'The token is not valid.', 401);
        }
        // The room decides whether the credential is one it accepts.
        const result = await stub.issueTicket(payload.sub, payload.role, token, accountId);
        if (!result) {
          return relayError('UNAUTHORIZED', 'The token is not valid.', 401);
        }
        return json({ ok: true, ticket: result.ticket, expiresAt: result.expiresAt }, 200);
      }

      if (rest[0] === 'pair' && rest[1] === 'code' && request.method === 'POST') {
        const body = await readJson(request);
        const bridgeId = typeof body.bridgeId === 'string' ? body.bridgeId : '';
        const bridgeName = typeof body.bridgeName === 'string' ? body.bridgeName : 'Desktop';
        const token = bearer(request);
        if (!bridgeId || !token) {
          return relayError('BAD_REQUEST', 'bridgeId and a bearer token are required', 400);
        }
        const verified = await verifyBridge(token, bridgeId, accountId, stub, env.RELAY_SECRET);
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

      // A bridge rotates its own token, or gives it up.
      //
      // The bridge token is long-lived and lives on the desktop's disk, so it needs
      // both a way to be replaced and a way to be killed. Rotating issues a fresh
      // token and kills every older one; revoking kills all of them and leaves the
      // bridge with nothing, which is the point of a kill switch.
      if (rest[0] === 'bridge' && rest[1] === 'token') {
        const token = bearer(request);
        const payload = await verifyToken(token, env.RELAY_SECRET);
        if (!isBridgeTokenForAccount(payload, accountId)) {
          return relayError('UNAUTHORIZED', 'The bridge token is not valid.', 401);
        }
        if (await stub.isBridgeTokenRevoked(payload)) {
          return relayError('UNAUTHORIZED', 'The bridge token is not valid.', 401);
        }
        const owner = await stub.ownerBridgeId();
        if (owner !== null && owner !== payload.sub) {
          return relayError('UNAUTHORIZED', 'The bridge token is not valid.', 401);
        }
        if (request.method === 'POST') {
          const rotated = await stub.rotateBridgeToken(payload.sub, accountId);
          return json({ ok: true, token: rotated.token, expiresAt: rotated.expiresAt }, 200);
        }
        if (request.method === 'DELETE') {
          await stub.revokeBridgeTokensBefore(Date.now());
          return json({ ok: true, revoked: true }, 200);
        }
        return json({ error: 'bad_request', message: 'Expected POST or DELETE.' }, 400);
      }

      if (rest[0] === 'devices' && request.method === 'GET') {
        // The device list carries credentials, so it is bridge-only. The phone never
        // needs it; the desktop is the one that shows the paired devices.
        const authorized = await authorizeBridge(request, stub, accountId, env.RELAY_SECRET);
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

      // A phone releases its own credential.
      //
      // Unpairing on the phone has to reach the relay: a phone that only forgets
      // its own token leaves a working credential behind, and the owner believes
      // the device is gone.
      //
      // The token names the device, so there is nothing else to check - a device
      // may only revoke itself.
      if (rest[0] === 'devices' && rest[1] === 'me' && request.method === 'DELETE') {
        const token = bearer(request);
        const payload = await verifyToken(token, env.RELAY_SECRET);
        if (!payload || payload.role !== 'device') {
          return relayError('UNAUTHORIZED', 'The device token is not valid.', 401);
        }
        const released = await stub.releaseDevice(payload.sub, token);
        if (!released) {
          return relayError('UNAUTHORIZED', 'The device token is not valid.', 401);
        }
        return json({ ok: true, released: true }, 200);
      }

      if (rest[0] === 'devices' && rest[1] && request.method === 'DELETE') {
        // Revocation is a privileged action: without this check anyone who guessed
        // the account id could unpair a phone.
        const authorized = await authorizeBridge(request, stub, accountId, env.RELAY_SECRET);
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

async function verifyBridge(
  token: string,
  bridgeId: string,
  accountId: string,
  stub: DurableObjectStub<Relay>,
  secret: string,
): Promise<boolean> {
  const payload = await verifyToken(token, secret);
  if (!isBridgeTokenForAccount(payload, accountId)) return false;
  if (await stub.isBridgeTokenRevoked(payload)) return false;
  return payload.sub === bridgeId;
}

/**
 * Authorises a privileged, account-scoped action (listing or revoking devices).
 *
 * The token must be a valid bridge token bound to *this* account, and it must
 * name the bridge that owns the account — otherwise a desktop of one account
 * could unpair the phones of another. An account that no bridge has claimed yet
 * has nothing to protect, so the owner check passes for any bridge token; the
 * account check does not, because the token still has to be for this account.
 */
async function authorizeBridge(
  request: Request,
  stub: DurableObjectStub<Relay>,
  accountId: string,
  secret: string,
): Promise<boolean> {
  const token = bearer(request);
  if (!token) return false;
  const payload = await verifyToken(token, secret);
  if (!isBridgeTokenForAccount(payload, accountId)) return false;
  if (await stub.isBridgeTokenRevoked(payload)) return false;
  const owner = await stub.ownerBridgeId();
  return owner === null || payload.sub === owner;
}
