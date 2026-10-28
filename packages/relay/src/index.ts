/**
 * Worker entry.
 *
 * The Worker is a thin router: it validates the request shape, picks the Durable Object
 * for the account and forwards. All relay behaviour lives in the Durable Object's
 * {@link RelaySession}.
 */

import { describeRelayError, type RelayErrorCode } from '@minimax-bot/protocol';

import { Relay, type RelayEnv } from './relay.js';

// The Durable Object must be exported from the entrypoint so Wrangler can bind it.
export { Relay };

export interface WorkerEnv extends RelayEnv {
  RELAY: DurableObjectNamespace<Relay>;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter(Boolean);

    // /r/:accountId/...
    if (segments[0] !== 'r' || !segments[1]) {
      return json({ error: 'bad_request', message: 'Expected /r/:accountId/...' }, 400);
    }
    const accountId = segments[1];
    const rest = segments.slice(2);
    const stub = env.RELAY.getByName(accountId);

    try {
      if (rest[0] === 'ws') {
        // The WebSocket upgrade must carry its own auth in the query string, because the
        // browser WebSocket API cannot set headers.
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
        const result = await stub.createPairingCode(bridgeId, bridgeName);
        return json(result, 200);
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
        return json({ devices: await stub.listDevices() }, 200);
      }

      if (rest[0] === 'devices' && rest[1] && request.method === 'DELETE') {
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
  const { verifyToken } = await import('./auth.js');
  const payload = await verifyToken(token, secret);
  return payload !== null && payload.role === 'bridge' && payload.sub === bridgeId;
}
