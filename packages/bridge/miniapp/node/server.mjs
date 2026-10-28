/**
 * Mini App entry point.
 *
 * `start(context)` is the contract the Host requires. The bridge listens on the address
 * the Host assigns (always loopback) and serves the small `/api` surface the desktop
 * surface uses to show a pairing code and manage paired phones.
 */

import { createServer } from 'node:http';

import { Bridge } from './bridge.mjs';
import { loadConfig, saveConfig } from './config.mjs';

const MAX_BODY = 256 * 1024;

export async function start(context) {
  const logger = context.logger;
  let config = await loadConfig(context.dataDir);

  const bridge = new Bridge(context, { config, logger });
  await bridge.start();

  const server = createServer((request, response) => {
    handle(request, response, { bridge, context, getConfig: () => config, setConfig: async (next) => {
      config = next;
      await saveConfig(context.dataDir, next);
      bridge.config = next;
      bridge.relay.url = next.relayUrl;
      bridge.relay.accountId = next.accountId;
      bridge.relay.token = next.bridgeToken;
      bridge.relay.name = next.bridgeName;
      bridge.relay.start();
    } }).catch((error) => {
      logger.error(`request failed: ${error instanceof Error ? error.message : error}`);
      json(response, 500, { error: 'internal' });
    });
  });

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

async function handle(request, response, deps) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (request.method === 'GET' && path === '/api/health') {
    return json(response, 200, { ok: true });
  }

  if (request.method === 'GET' && path === '/api/status') {
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

  if (request.method === 'GET' && path === '/api/devices') {
    const { bridge } = deps;
    return json(response, 200, { devices: await bridge.relay.listDevices() });
  }

  if (request.method === 'DELETE' && path.startsWith('/api/devices/')) {
    const { bridge } = deps;
    const deviceId = decodeURIComponent(path.slice('/api/devices/'.length));
    const revoked = await bridge.relay.revokeDevice(deviceId);
    return json(response, revoked ? 200 : 404, { revoked });
  }

  if (request.method === 'GET' && path === '/api/snapshot') {
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
    const { getConfig, setConfig } = deps;
    const current = getConfig();
    const next = {
      ...current,
      relayUrl: typeof body.relayUrl === 'string' ? body.relayUrl : current.relayUrl,
      accountId: typeof body.accountId === 'string' ? body.accountId : current.accountId,
      bridgeName: typeof body.bridgeName === 'string' ? body.bridgeName : current.bridgeName,
    };
    await setConfig(next);
    return json(response, 200, { ok: true, config: { ...next, bridgeToken: undefined } });
  }

  return json(response, 404, { error: 'not_found' });
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request) {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error('body too large');
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
