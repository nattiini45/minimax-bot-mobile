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
 *   node scripts/mint-bridge-token.mjs --bridge-id <id> [--account default] [--hours 24]
 *
 * The relay secret is read from the environment (RELAY_SECRET) or from the file
 * named by --secret-file. It is not accepted as a command-line argument: an
 * argument lands in the shell history and in the process table, where anything
 * running on the machine can read it, and the secret is worth more than every
 * token this script can mint.
 *
 * The account is the room the token can reach. It is baked into the signed token,
 * so the relay refuses the token against any other account.
 *
 * The token is short-lived on purpose: a bridge token lives on a disk, and a short
 * life is what keeps a leaked one from being a month-long problem. The bridge
 * replaces its own token before this one runs out, and replacing it kills the old
 * one.
 *
 * It prints the bridge configuration to paste into the bridge, and the token on its
 * own line so it can be piped.
 */

import { readFileSync } from 'node:fs';

import { issueToken } from '@minimax-bot/protocol';

const HOUR_MS = 60 * 60 * 1000;

function parseArgs(argv) {
  const options = {
    secretFile: '',
    bridgeId: '',
    bridgeName: 'Desktop',
    accountId: 'default',
    hours: 24,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}.`);
    }
    i += 1;
    switch (key) {
      case '--secret-file':
        options.secretFile = value;
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
      case '--hours':
        options.hours = Number(value);
        break;
      case '--days':
        // Kept for the scripts that grew up with it; days are just hours.
        options.hours = Number(value) * 24;
        break;
      default:
        throw new Error(`Unknown option ${key}.`);
    }
  }
  return options;
}

/**
 * Reads the relay secret once, from the first source that has it.
 *
 * The secret is not echoed anywhere: only the bridge token is printed, and that
 * one is meant to be copied into the desktop.
 */
function readSecret(options) {
  if (options.secretFile) {
    try {
      const fromFile = readFileSync(options.secretFile, 'utf8').trim();
      if (fromFile) return fromFile;
    } catch (error) {
      throw new Error(`Could not read the secret file: ${error.message}`);
    }
  }
  const fromEnv = process.env.RELAY_SECRET;
  if (fromEnv) {
    // Read once: a child process should not inherit the master secret.
    delete process.env.RELAY_SECRET;
    return fromEnv;
  }
  return '';
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(
      'Usage: node scripts/mint-bridge-token.mjs --bridge-id <id> [--account default] [--hours 24]',
    );
    console.error('The secret comes from RELAY_SECRET, or from --secret-file <path>.');
    process.exit(2);
  }

  const secret = readSecret(options);
  if (!secret) {
    console.error(
      'The relay secret is required: set RELAY_SECRET, or pass --secret-file <path>. It is not read from the command line.',
    );
    process.exit(2);
  }
  if (!options.bridgeId) {
    console.error('The bridge id is required: --bridge-id <id>.');
    process.exit(2);
  }
  if (!options.accountId) {
    console.error('The account id is required: --account <accountId>.');
    process.exit(2);
  }
  if (!Number.isFinite(options.hours) || options.hours <= 0) {
    console.error('The lifetime in hours must be a positive number.');
    process.exit(2);
  }

  const ttlMs = Math.round(options.hours * HOUR_MS);
  const { token, expiresAt } = await issueToken(options.bridgeId, 'bridge', ttlMs, secret, {
    accountId: options.accountId,
  });

  const config = {
    relayUrl: process.env.RELAY_URL ?? 'http://127.0.0.1:8787',
    accountId: options.accountId,
    bridgeId: options.bridgeId,
    bridgeToken: token,
  };

  console.log(
    `# bridge token for ${options.bridgeId} on account ${options.accountId}, valid until ${new Date(expiresAt).toISOString()}`,
  );
  console.log(token);
  console.log('');
  console.log('# bridge configuration');
  console.log(JSON.stringify(config, null, 2));
}

await main();
