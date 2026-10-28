#!/usr/bin/env node
/**
 * Mints the bridge token the desktop needs to talk to the relay.
 *
 * The relay holds a shared secret and signs the tokens it issues. A device gets its
 * token by pairing with a code the bridge asks for; the bridge has no such path, so
 * its token has to be minted by whoever holds the secret. Without this, the desktop
 * cannot even ask the relay for a pairing code.
 *
 * Usage:
 *   node scripts/mint-bridge-token.mjs --secret <RELAY_SECRET> --bridge-id <id> [--account default] [--days 30]
 *
 * It prints the bridge configuration to paste into the bridge, and the token on its
 * own line so it can be piped.
 */

import { issueToken } from '@minimax-bot/protocol';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = { secret: '', bridgeId: '', bridgeName: 'Desktop', accountId: 'default', days: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}.`);
    }
    i += 1;
    switch (key) {
      case '--secret':
        options.secret = value;
        break;
      case '--bridge-id':
        options.bridgeId = value;
        break;
      case '--bridge-name':
        options.bridgeName = value;
        break;
      case '--account':
        options.accountId = value;
        break;
      case '--days':
        options.days = Number(value);
        break;
      default:
        throw new Error(`Unknown option ${key}.`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(
      'Usage: node scripts/mint-bridge-token.mjs --secret <RELAY_SECRET> --bridge-id <id> [--account default] [--days 30]',
    );
    process.exit(2);
  }

  if (!options.secret) {
    console.error('The relay secret is required: --secret <RELAY_SECRET>.');
    process.exit(2);
  }
  if (!options.bridgeId) {
    console.error('The bridge id is required: --bridge-id <id>.');
    process.exit(2);
  }
  if (!Number.isFinite(options.days) || options.days <= 0) {
    console.error('The lifetime in days must be a positive number.');
    process.exit(2);
  }

  const ttlMs = Math.round(options.days * DAY_MS);
  const { token, expiresAt } = await issueToken(options.bridgeId, 'bridge', ttlMs, options.secret);

  const config = {
    relayUrl: process.env.RELAY_URL ?? 'http://127.0.0.1:8787',
    accountId: options.accountId,
    bridgeId: options.bridgeId,
    bridgeToken: token,
  };

  console.log(`# bridge token for ${options.bridgeId}, valid until ${new Date(expiresAt).toISOString()}`);
  console.log(token);
  console.log('');
  console.log('# bridge configuration');
  console.log(JSON.stringify(config, null, 2));
}

await main();
