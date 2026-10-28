import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Bridge } from '../miniapp/node/bridge.mjs';

/**
 * `Bridge.dispatch` returns whatever the matching operation produces, so the inferred type
 * is the union of every branch. Each call site narrows it to the shape it asserts on.
 *
 * @typedef {{bots: any[], groups: any[], diagnostics: any}} TeamResult
 * @typedef {{messageId: string, turnId?: string, sessionId: string}} SendResult
 * @typedef {{messages: any[]}} HistoryResult
 * @typedef {{buckets: any[], byBot: any[], totals: {turns: number, chars: number, tools: number, durationMs: number, errors: number}}} UsageResult
 */

const TEAM_TOOLS = [
  { name: 'mcp__minimax-bot__list_team', server: 'minimax-bot', tool: 'list_team' },
  { name: 'mcp__minimax-bot__message_bot', server: 'minimax-bot', tool: 'message_bot' },
  { name: 'mcp__minimax-bot__get_tasks', server: 'minimax-bot', tool: 'get_tasks' },
];

async function makeBridge({ tools = TEAM_TOOLS, agent = true } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'bridge-test-'));
  const sent = [];
  const toolCalls = [];
  const agentRuns = [];
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
        return { tools, partial: false };
      },
      async call(input) {
        toolCalls.push(input);
        if (input.name.endsWith('list_team')) {
          return {
            ok: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  bots: [{ botId: 'b1', name: 'Writer' }],
                  groups: [{ groupId: 'g1', name: 'Team', memberIds: ['b1'] }],
                }),
              },
            ],
          };
        }
        if (input.name.endsWith('get_tasks')) {
          return {
            ok: true,
            structuredContent: { tasks: [{ taskId: 't1', state: 'running' }] },
          };
        }
        return { ok: true, content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
  };

  if (agent) {
    context.agent = {
      async run(input, options) {
        agentRuns.push(input);
        options?.onEvent?.({
          type: 'turn.started',
          sessionId: 'sess-1',
          turnId: 'turn-1',
        });
        options?.onEvent?.({
          type: 'text.delta',
          sessionId: 'sess-1',
          turnId: 'turn-1',
          text: 'Hello',
        });
        options?.onEvent?.({
          type: 'message.committed',
          sessionId: 'sess-1',
          turnId: 'turn-1',
          text: 'Hello',
        });
        options?.onEvent?.({
          type: 'turn.finished',
          sessionId: 'sess-1',
          turnId: 'turn-1',
          status: 'finished',
          text: 'Hello',
        });
        return { sessionId: 'sess-1', turnId: 'turn-1', status: 'finished', text: 'Hello' };
      },
      async reply(input) {
        agentReplies.push(input);
      },
      async answer() {
        return { sessionId: 'sess-1', status: 'finished' };
      },
    };
  }

  const bridge = new Bridge(context, {
    config: { bridgeId: 'bridge-1', accountId: 'default', bridgeToken: '', relayUrl: '', bridgeName: 'Desk' },
    logger: context.logger,
  });
  bridge.relay.send = (frame) => {
    sent.push(frame);
    return true;
  };

  await bridge.start();

  return {
    bridge,
    sent,
    toolCalls,
    agentRuns,
    agentReplies,
    async dispose() {
      bridge.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('the bridge links the team on start', async () => {
  const { bridge, dispose } = await makeBridge();
  assert.equal(bridge.tools.available, true);
  assert.equal(bridge.tools.catalog.length, 3);
  assert.equal(bridge.diagnostics().teamToolsAvailable, true);
  assert.equal(bridge.diagnostics().agentAvailable, true);
  await dispose();
});

test('list_team returns the roster and the diagnostics', async () => {
  const { bridge, dispose } = await makeBridge();
  const result = /** @type {TeamResult} */ (await bridge.dispatch('op.list_team', {}));

  assert.equal(result.bots.length, 1);
  assert.equal(result.bots[0].name, 'Writer');
  assert.equal(result.groups.length, 1);
  assert.equal(result.diagnostics.toolCount, 3);
  await dispose();
});

test('send_message runs a turn and commits the user message', async () => {
  const { bridge, sent, agentRuns, dispose } = await makeBridge();
  const result = /** @type {SendResult} */ (await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'Hi there' }));

  assert.equal(agentRuns.length, 1);
  assert.equal(agentRuns[0].text, 'Hi there');
  assert.ok(result.messageId);
  assert.equal(result.turnId, 'turn-1');

  const committed = sent.filter(
    (frame) => frame.type === 'evt.message_committed' && frame.payload.message.role === 'user',
  );
  assert.equal(committed.length, 1);
  assert.equal(committed[0].payload.message.text, 'Hi there');
  await dispose();
});

test('send_message mentions are prefixed to the prompt', async () => {
  const { bridge, agentRuns, dispose } = await makeBridge();
  await bridge.dispatch('op.send_message', { chatId: 'group:g1', text: 'go', mentions: ['b1', 'b2'] });

  assert.equal(agentRuns[0].text, '@b1 @b2\ngo');
  await dispose();
});

test('send_message keeps the id the phone chose, so the bubble is replaced in place', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  const result = /** @type {SendResult} */ (
    await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'Hi there', clientMessageId: 'local_abc' })
  );

  assert.equal(result.messageId, 'local_abc');
  const committed = sent.find(
    (frame) => frame.type === 'evt.message_committed' && frame.payload.message.role === 'user',
  );
  assert.equal(committed.payload.message.messageId, 'local_abc');
  await dispose();
});

test('send_message ignores an id the phone may not choose', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  const result = /** @type {SendResult} */ (
    await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'Hi', clientMessageId: 'has space' })
  );

  assert.notEqual(result.messageId, 'has space');
  assert.ok(result.messageId.startsWith('msg_'));
  const committed = sent.find(
    (frame) => frame.type === 'evt.message_committed' && frame.payload.message.role === 'user',
  );
  assert.equal(committed.payload.message.messageId, result.messageId);
  await dispose();
});

test('a streamed reply is published as chunks and a commit', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'Hi' });

  const chunks = sent.filter((frame) => frame.type === 'evt.message_chunk');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].payload.text, 'Hello');

  const assistant = sent.filter(
    (frame) => frame.type === 'evt.message_committed' && frame.payload.message.role === 'assistant',
  );
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].payload.message.authorId, 'b1');
  await dispose();
});

test('the turn lifecycle is published', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'Hi' });

  assert.ok(sent.some((frame) => frame.type === 'evt.turn_started'));
  const finished = sent.find((frame) => frame.type === 'evt.turn_finished');
  assert.equal(finished.payload.status, 'finished');
  await dispose();
});

test('the same opId is executed once', async () => {
  const { bridge, agentRuns, dispose } = await makeBridge();
  const frame = { v: 1, id: 'f1', ts: 1, type: 'op.send_message', source: 'app', payload: { chatId: 'bot:b1', text: 'Hi' }, opId: 'op-1' };

  await bridge.handleFrame(frame);
  await bridge.handleFrame(frame);

  assert.equal(agentRuns.length, 1);
  await dispose();
});

test('an unknown operation is refused', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  await bridge.handleFrame({ v: 1, id: 'f1', ts: 1, type: 'op.nope', source: 'app', payload: {} });

  const error = sent.find((frame) => frame.type === 'err');
  assert.ok(error);
  assert.equal(error.payload.code, 'UNKNOWN_OP');
  await dispose();
});

test('an operation the team cannot serve is refused', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  await bridge.handleFrame({ v: 1, id: 'f1', ts: 1, type: 'op.list_tasks', source: 'app', payload: {} });

  const ack = sent.find((frame) => frame.type === 'ack');
  assert.ok(ack);
  assert.equal(ack.payload.result.tool, 'get_tasks');
  assert.equal(ack.payload.result.data.tasks[0].taskId, 't1');
  await dispose();
});

test('history accumulates the messages of a chat', async () => {
  const { bridge, dispose } = await makeBridge();
  await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'one' });
  await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'two' });

  const history = /** @type {HistoryResult} */ (await bridge.dispatch('op.list_history', { chatId: 'bot:b1' }));
  assert.equal(history.messages.length, 2);
  assert.equal(history.messages[0].text, 'one');
  await dispose();
});

test('reactions are counted per message', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  await bridge.dispatch('op.react', { messageId: 'm1', emoji: '🔥' });
  await bridge.dispatch('op.react', { messageId: 'm1', emoji: '🔥' });

  assert.ok(sent.some((frame) => frame.type === 'evt.reaction_added'));
  assert.equal(bridge.reactions.get('m1').get('🔥'), 2);
  await dispose();
});

test('usage is reported from the ledger', async () => {
  const { bridge, dispose } = await makeBridge();
  await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'Hi' });

  const usage = /** @type {UsageResult} */ (await bridge.dispatch('op.get_usage', { days: 7 }));
  assert.ok(usage.buckets.length > 0);
  assert.ok(usage.totals.turns >= 1);
  await dispose();
});

test('a permission request is held and can be answered', async () => {
  const { bridge, sent, agentReplies, dispose } = await makeBridge();
  const context = bridge.context;

  context.agent.run = async (input, options) => {
    options?.onEvent?.({
      type: 'permission.requested',
      sessionId: 'sess-1',
      requestId: 'req-1',
      toolName: 'shell',
      reason: 'writes a file',
    });
    return { sessionId: 'sess-1', turnId: 'turn-1', status: 'finished' };
  };

  await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'do it' });

  const asked = sent.find((frame) => frame.type === 'evt.permission_requested');
  assert.ok(asked);
  assert.equal(asked.payload.request.requestId, 'req-1');
  assert.equal(bridge.pending.size, 1);

  await bridge.dispatch('op.respond_permission', { requestId: 'req-1', decision: 'allowOnce' });
  assert.equal(agentReplies.length, 1);
  assert.equal(agentReplies[0].decision, 'allowOnce');
  assert.equal(bridge.pending.size, 0);
  assert.ok(sent.some((frame) => frame.type === 'evt.permission_resolved'));
  await dispose();
});

test('a pending approval is replayed when a phone resumes', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  bridge.context.agent.run = async (input, options) => {
    options?.onEvent?.({
      type: 'permission.requested',
      sessionId: 'sess-1',
      requestId: 'req-2',
      toolName: 'shell',
      reason: 'writes a file',
    });
    return { sessionId: 'sess-1', status: 'finished' };
  };

  await bridge.dispatch('op.send_message', { chatId: 'bot:b1', text: 'do it' });
  sent.length = 0;

  bridge.replayPending();
  const replayed = sent.find((frame) => frame.type === 'evt.permission_requested');
  assert.ok(replayed);
  assert.equal(replayed.payload.request.requestId, 'req-2');
  await dispose();
});

test('the bridge reports an unavailable team instead of failing to start', async () => {
  const { bridge, dispose } = await makeBridge({ tools: [] });
  assert.equal(bridge.tools.available, false);
  assert.equal(bridge.diagnostics().teamToolsAvailable, false);
  assert.ok(bridge.diagnostics().reason);
  await dispose();
});
