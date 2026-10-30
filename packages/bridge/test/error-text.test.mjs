import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Bridge } from '../miniapp/node/bridge.mjs';

/**
 * What the room is told when something goes wrong.
 *
 * The diagnostics travel with the team snapshot to every phone in the account. The
 * Host's own error text can name internal paths, tool identifiers and host-side detail
 * that the phone's users did not need to see, so the room gets a fixed sentence and the
 * desktop keeps the detail.
 */

const SECRET = '/Users/caspar/.minimax/plugins/minimax-bot-bridge/tools.json';

/**
 * @param {{toolList?: () => Promise<unknown>, toolCall?: () => Promise<unknown>}} options
 */
async function makeBridge({ toolList, toolCall } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bridge-errors-'));
  const sent = [];
  const logged = [];

  const context = {
    pluginId: 'minimax-bot-bridge',
    pluginRoot: '.',
    dataDir,
    listen: { host: '127.0.0.1', port: 0 },
    signal: new AbortController().signal,
    logger: {
      info() {},
      warn(message, detail) {
        logged.push({ message, detail });
      },
      error() {},
      debug() {},
    },
    tool: {
      async list() {
        if (toolList) return toolList();
        return { tools: [], partial: false };
      },
      async call() {
        if (toolCall) return toolCall();
        return { kind: 'mcp', isError: false, content: [] };
      },
    },
    agent: {
      async run() {
        return { sessionId: 'sess-1', turnId: 'turn-1', status: 'finished' };
      },
      async reply() {},
      async answer() {
        return { sessionId: 'sess-1', status: 'finished' };
      },
    },
  };

  const bridge = new Bridge(context, {
    config: { bridgeId: 'bridge-1', accountId: 'default', bridgeToken: '', relayUrl: '', bridgeName: 'Desk' },
    logger: context.logger,
  });
  bridge.relay.send = (frame) => {
    sent.push(frame);
    return true;
  };

  await bridge.start();
  sent.length = 0;

  return {
    bridge,
    sent,
    logged,
    async dispose() {
      bridge.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Every piece of text in a frame, as one string. */
function frameText(frame) {
  return JSON.stringify(frame);
}

test('the room is told a sentence, not the Host error text', async () => {
  const { bridge, sent, logged, dispose } = await makeBridge({
    toolList: async () => {
      throw new Error(`cannot read ${SECRET}: mcp__minimax-bot__message_bot is not registered`);
    },
  });
  try {
    await bridge.tools.refresh();

    // The room's diagnostics carry a sentence.
    const reason = bridge.diagnostics().reason;
    assert.ok(reason);
    assert.equal(reason.includes('mcp__minimax-bot'), false);
    assert.equal(reason.includes(SECRET), false);

    // The desktop keeps the detail.
    assert.equal(bridge.desktopDiagnostics().detail.includes(SECRET), true);
    // And it was written down on the desktop.
    assert.ok(logged.some((entry) => JSON.stringify(entry).includes(SECRET)));

    // And nothing that goes to the room carries it.
    for (const frame of sent) {
      assert.equal(frameText(frame).includes(SECRET), false);
      assert.equal(frameText(frame).includes('mcp__minimax-bot'), false);
    }
  } finally {
    await dispose();
  }
});

test('a roster that cannot be read is a sentence to the room as well', async () => {
  const { bridge, sent, logged, dispose } = await makeBridge();
  try {
    // The roster cannot be read.
    bridge.readTeam = async () => {
      throw new Error(`team tool failed: ${SECRET} is not readable`);
    };

    await bridge.publishTeamSnapshot();

    const reason = bridge.diagnostics().reason;
    assert.ok(reason);
    assert.equal(reason.includes(SECRET), false);

    assert.equal(bridge.desktopDiagnostics().detail.includes(SECRET), true);
    assert.ok(logged.some((entry) => JSON.stringify(entry).includes(SECRET)));

    for (const frame of sent) {
      assert.equal(frameText(frame).includes(SECRET), false);
    }
  } finally {
    await dispose();
  }
});

test('the answer to a list_team request carries the sentence, not the text', async () => {
  const { bridge, dispose } = await makeBridge({
    toolList: async () => {
      throw new Error(`cannot read ${SECRET}`);
    },
  });
  try {
    const answer = await bridge.dispatch('op.list_team', {});
    const text = JSON.stringify(answer);
    assert.equal(text.includes(SECRET), false);
    assert.equal(answer.diagnostics.reason.includes(SECRET), false);
  } finally {
    await dispose();
  }
});
