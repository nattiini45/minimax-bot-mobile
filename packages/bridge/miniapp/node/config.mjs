import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CONFIG_FILE = 'bridge-config.json';

/**
 * @typedef {object} BridgeConfig
 * @property {string} relayUrl Public base URL of the relay, e.g. `wss://relay.example.workers.dev`.
 * @property {string} accountId Room the bridge and its phones share.
 * @property {string} bridgeId Stable id of this desktop.
 * @property {string} bridgeToken HMAC token the relay accepts for this bridge.
 * @property {string} bridgeName Display name shown on the phone.
 */

/**
 * Loads the bridge configuration.
 *
 * The bridge id is generated once and persisted, because the relay pairs a phone against
 * a specific desktop and the phone must be able to find it again after a restart.
 *
 * @param {string} dataDir
 * @param {Partial<BridgeConfig>} [overrides]
 * @returns {Promise<BridgeConfig>}
 */
export async function loadConfig(dataDir, overrides = {}) {
  await mkdir(dataDir, { recursive: true });
  const file = join(dataDir, CONFIG_FILE);

  let stored = {};
  try {
    stored = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    stored = {};
  }

  const config = {
    relayUrl: overrides.relayUrl ?? stored.relayUrl ?? '',
    accountId: overrides.accountId ?? stored.accountId ?? 'default',
    bridgeId: overrides.bridgeId ?? stored.bridgeId ?? '',
    bridgeToken: overrides.bridgeToken ?? stored.bridgeToken ?? '',
    bridgeName: overrides.bridgeName ?? stored.bridgeName ?? 'Desktop',
  };

  if (!config.bridgeId) {
    config.bridgeId = `bridge_${randomId()}`;
    await saveConfig(dataDir, config);
  }

  return config;
}

/**
 * @param {string} dataDir
 * @param {BridgeConfig} config
 * @returns {Promise<void>}
 */
export async function saveConfig(dataDir, config) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function randomId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID().replace(/-/g, '').slice(0, 16);
  }
  return Math.floor(Math.random() * 0xffffffffffff).toString(16);
}
