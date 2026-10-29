import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Bridge } from '../miniapp/node/bridge.mjs';
import { MAX_CONCURRENT_RUNS } from '../miniapp/node/agent.mjs';

/**
 * Answering a request that is waiting.
 *
 * A turn that stops for a permission check is held by the desktop, and the phone
 * answers it later. The answer is Host work on a privileged action, so it must reach
 * the Host once and only once: two answers to the same request would be two replies
 * about the same action.
 */

async function makeBridge() {
  const dataDir = await mkdtemp(join(tmpdir(), 'bridge-approval-'));
  /** The answers the Host was given. */
  const agentReplies = [];
  const context = {
    pluginId: 'minimax-bot-bridge',
    pluginRoot: '.',
    dataDir,
    listen: { host: '127.0.0.1', port: 0 },
    signal: new AbortController().signal,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tool: {
      async list() {
        return { tools: [], partial: false };
      },
      async call() {
        return { kind: 'mcp', isError: false, content: [] };
      },
    },
    agent: {
      async run(input, options) {
        options?.onEvent?.({
          type: 'permission.requested',
          sessionId: 'sess-1',
          requestId: 'req-1',
          toolName: 'shell',
          reason: 'writes a file',
        });
        return { sessionId: 'sess-1', turnId: 'turn-1', status: 'finished' };
      },
      async reply(payload) {
        agentReplies.push(payload);
      },
      async answer() {
        return { sessionId: 'sess-1', status: 'finished' };
      },
    },
  };

  const bridge = new Bridge(context, {
    config: { bridgeId: 'bridge-1', accountId: 'default', bridgeToken: '', relayUrl: '', bridgeName: 'Desk' },
    logger: context.logger,
  });
  bridge.relay.send = () => true;

  await bridge.start();

  return {
    bridge,
    agentReplies,
    async dispose() {
      bridge.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs a promise against a deadline.
 *
 * A test that waits forever is a test that hangs the suite, so every wait here has
 * one.
 */
async function within(promise, ms = 2_000) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the promise did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test('a double-tapped approve button reaches the Host once', async () => {
  const { bridge, agentReplies, dispose } = await makeBridge();
  try {
    await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'do it' });
    assert.equal(bridge.pending.size, 1);

    // The Host is slow, so the second tap arrives while the first answer is still in
    // flight. That is what a double tap produces.
    let release = () => {};
    const held = new Promise((resolve) => {
      release = () => resolve();
    });
    bridge.context.agent.reply = async (payload) => {
      agentReplies.push(payload);
      await held;
    };

    const first = bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'allowOnce' });
    const second = bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'deny' });

    // The second answer is refused straight away, without waiting for the Host.
    await assert.rejects(
      () => within(second),
      (error) => {
        assert.equal(/** @type {{code?: string}} */ (error).code, 'REQUEST_NOT_FOUND');
        return true;
      },
    );

    release();
    await within(first);

    assert.equal(agentReplies.length, 1);
    assert.equal(agentReplies[0].decision, 'allowOnce');
  } finally {
    await dispose();
  }
});

test('a second answer to a request that is already answered is refused', async () => {
  const { bridge, agentReplies, dispose } = await makeBridge();
  try {
    await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'do it' });

    await bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'allowOnce' });
    assert.equal(agentReplies.length, 1);

    await assert.rejects(
      () => bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'allowOnce' }),
      (error) => {
        assert.equal(/** @type {{code?: string}} */ (error).code, 'REQUEST_NOT_FOUND');
        return true;
      },
    );
    assert.equal(agentReplies.length, 1);
  } finally {
    await dispose();
  }
});

test('a request is given back when the Host does not take the answer', async () => {
  const { bridge, dispose } = await makeBridge();
  try {
    await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'do it' });

    bridge.context.agent.reply = async () => {
      throw new Error('the host is not there');
    };
    await assert.rejects(() => bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'deny' }));

    // The request is still waiting for an answer, so the phone may give one.
    assert.equal(bridge.pending.size, 1);

    const answers = [];
    bridge.context.agent.reply = async (payload) => {
      answers.push(payload);
    };
    await bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'deny' });
    assert.equal(answers.length, 1);
    assert.equal(bridge.pending.size, 0);
  } finally {
    await dispose();
  }
});

test('answering counts towards the run ceiling', async () => {
  const { bridge, agentReplies, dispose } = await makeBridge();
  try {
    await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'do it' });

    // The runner is busy with as many turns as it allows.
    bridge.runner.activeRuns = MAX_CONCURRENT_RUNS;

    await assert.rejects(
      () => within(bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'allowOnce' })),
      (error) => {
        assert.equal(/** @type {{code?: string}} */ (error).code, 'BUSY');
        return true;
      },
    );
    assert.equal(agentReplies.length, 0);

    // The request was given back, so it is still waiting.
    assert.equal(bridge.pending.size, 1);

    bridge.runner.activeRuns = 0;
    await bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'allowOnce' });
    assert.equal(agentReplies.length, 1);
  } finally {
    await dispose();
  }
});
