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

/**
 * The team tools the bridge talks to.
 *
 * The schemas are the ones the real `@minimax-bot` team tools advertise, copied from
 * the tool catalogue rather than invented: the whole point of mapping an operation
 * payload onto the live schema is that the two agree.
 */
const TEAM_TOOLS = [
  { name: 'mcp__minimax-bot__list_team', server: 'minimax-bot', tool: 'list_team' },
  { name: 'mcp__minimax-bot__message_bot', server: 'minimax-bot', tool: 'message_bot' },
  {
    name: 'mcp__minimax-bot__dispatch_tasks',
    server: 'minimax-bot',
    tool: 'dispatch_tasks',
    inputSchema: {
      type: 'object',
      properties: {
        caller_bot_id: { type: 'string', minLength: 1 },
        request_id: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,128}$' },
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['to', 'message'],
            properties: {
              to: { type: 'string' },
              message: { type: 'string', minLength: 1, maxLength: 20000 },
              title: { type: 'string', maxLength: 80 },
            },
          },
        },
      },
      required: ['request_id', 'tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'mcp__minimax-bot__get_tasks',
    server: 'minimax-bot',
    tool: 'get_tasks',
    inputSchema: {
      type: 'object',
      properties: {
        caller_bot_id: { type: 'string', minLength: 1 },
        task_id: { type: 'string' },
        batch_id: { type: 'string' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 20000 },
        result_offset: { type: 'integer', minimum: 0 },
      },
      required: [],
      additionalProperties: false,
      oneOf: [{ required: ['task_id'] }, { required: ['batch_id'] }],
    },
  },
  {
    name: 'mcp__minimax-bot__remember',
    server: 'minimax-bot',
    tool: 'remember',
    inputSchema: {
      type: 'object',
      properties: {
        caller_bot_id: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1, maxLength: 1200 },
        key: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
        scope: { type: 'string', enum: ['self', 'team', 'bot'] },
        target_bot: { type: 'string' },
        replace_id: { type: 'string', pattern: '^[a-f0-9]{8}$' },
        expected_revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        pinned: { type: 'boolean' },
        source: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
      anyOf: [{ required: ['key'] }, { required: ['replace_id'] }],
    },
  },
  { name: 'mcp__minimax-bot__list_helpers', server: 'minimax-bot', tool: 'list_helpers' },
  { name: 'mcp__minimax-bot__list_schedules', server: 'minimax-bot', tool: 'list_schedules' },
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
      async call(name, args) {
        toolCalls.push({ name, arguments: args });
        if (name.endsWith('list_team')) {
          return {
            kind: 'mcp',
            isError: false,
            content: [
              {
                type: 'text',
                // The shape the real team tool answers in: `bot_id`, `main`, members
                // and admin by name, `reply_mode`.
                text: JSON.stringify({
                  bots: [
                    {
                      bot_id: 'bot_b1',
                      name: 'Writer',
                      role: 'Long-form drafting',
                      main: false,
                      model: 'minimax/MiniMax-M3.1-Flash',
                      effort: 'default',
                    },
                  ],
                  groups: [
                    {
                      group_id: 'grp_g1',
                      name: 'Team',
                      notice: 'The whole team.',
                      admin: 'Writer',
                      members: ['Writer'],
                      reply_mode: 'admin',
                    },
                  ],
                }),
              },
            ],
          };
        }
        if (name.endsWith('get_tasks')) {
          return {
            kind: 'mcp',
            isError: false,
            content: [],
            structuredContent: { tasks: [{ task_id: 't1', state: 'running' }] },
          };
        }
        return { kind: 'mcp', isError: false, content: [{ type: 'text', text: '{"ok":true}' }] };
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
  assert.equal(bridge.tools.catalog.length, TEAM_TOOLS.length);
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
  assert.equal(result.diagnostics.toolCount, TEAM_TOOLS.length);
  await dispose();
});

test('the roster is mapped into the shape the protocol speaks', async () => {
  const { bridge, dispose } = await makeBridge();
  const result = /** @type {TeamResult} */ (await bridge.dispatch('op.list_team', {}));

  // The team tool answers in its own shape; the phone must only ever see the
  // protocol's shape, whatever the tool said.
  assert.equal(result.bots[0].botId, 'bot_b1');
  assert.equal(result.bots[0].isMain, false);
  assert.equal(result.bots[0].role, 'Long-form drafting');
  assert.equal(result.bots[0].model, 'minimax/MiniMax-M3.1-Flash');

  assert.equal(result.groups[0].groupId, 'grp_g1');
  assert.equal(result.groups[0].notice, 'The whole team.');
  assert.equal(result.groups[0].replyMode, 'admin');
  // The tool names the admin and the members; the protocol carries ids.
  assert.equal(result.groups[0].admin, 'bot_b1');
  assert.deepEqual(result.groups[0].memberIds, ['bot_b1']);
  await dispose();
});

test('a main Bot is marked as the main one', async () => {
  const { bridge, dispose } = await makeBridge();
  bridge.tools.call = async () => ({
    ok: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          bots: [{ bot_id: 'bot_b1', name: 'Writer', main: true }],
          groups: [],
        }),
      },
    ],
  });

  const result = /** @type {TeamResult} */ (await bridge.dispatch('op.list_team', {}));
  assert.equal(result.bots[0].isMain, true);
  await dispose();
});

test('a member the roster does not know is kept rather than dropped', async () => {
  const { bridge, dispose } = await makeBridge();
  bridge.tools.call = async () => ({
    ok: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          bots: [{ bot_id: 'bot_b1', name: 'Writer' }],
          groups: [{ group_id: 'grp_g1', name: 'Team', admin: 'Ghost', members: ['Writer', 'Ghost'] }],
        }),
      },
    ],
  });

  const result = /** @type {TeamResult} */ (await bridge.dispatch('op.list_team', {}));
  assert.deepEqual(result.groups[0].memberIds, ['bot_b1', 'Ghost']);
  assert.equal(result.groups[0].admin, 'Ghost');
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

test('a task list without a selector covers the batches the bridge knows', async () => {
  const { bridge, toolCalls, dispose } = await makeBridge();
  bridge.ledger.rememberBatch('batch_1');

  const result = /** @type {any} */ (await bridge.dispatch('op.list_tasks', {}));

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].taskId, 't1');
  assert.deepEqual(result.batchIds, ['batch_1']);
  // The team's task tool answers for one batch at a time, so the list is never
  // complete, and the answer says so rather than pretending otherwise.
  assert.equal(result.partial, true);
  assert.equal(toolCalls[0].arguments.batch_id, 'batch_1');
  await dispose();
});

test('a task list without a selector and without a batch is empty', async () => {
  const { bridge, sent, dispose } = await makeBridge();
  await bridge.handleFrame({ v: 1, id: 'f1', ts: 1, type: 'op.list_tasks', source: 'app', payload: {} });

  const ack = sent.find((frame) => frame.type === 'ack');
  assert.ok(ack);
  assert.deepEqual(ack.payload.result.tasks, []);
  assert.equal(ack.payload.result.partial, true);
  await dispose();
});

test('a task list that names a batch asks the team about that batch', async () => {
  const { bridge, toolCalls, dispose } = await makeBridge();
  const result = /** @type {any} */ (await bridge.dispatch('op.list_tasks', { batchId: 'batch_9' }));

  assert.equal(result.tool, 'get_tasks');
  assert.equal(toolCalls[0].arguments.batch_id, 'batch_9');
  await dispose();
});

test('a dispatched batch is remembered, so the task list can be rebuilt', async () => {
  const { bridge, dispose } = await makeBridge();
  bridge.context.tool.call = async (name, args) => ({
    kind: 'mcp',
    isError: false,
    content: [],
    structuredContent: {
      batch_id: 'batch_7',
      request_id: 'phone-1',
      complete: false,
      tasks: [{ task_id: 't7', kind: 'bot', bot_id: 'bot_b1', status: 'queued', created_at: 10 }],
    },
  });

  const result = /** @type {any} */ (await bridge.dispatch('op.dispatch', { botIds: ['bot_b1'], prompt: 'go' }));

  assert.equal(result.batchId, 'batch_7');
  assert.deepEqual(bridge.ledger.batches(), ['batch_7']);
  // The task list is in the protocol's shape, not the tool's.
  assert.equal(result.tasks[0].taskId, 't7');
  assert.equal(result.tasks[0].state, 'queued');
  assert.deepEqual(result.tasks[0].botIds, ['bot_b1']);
  assert.equal(result.tasks[0].createdAt, 10);
  await dispose();
});

test('the helper list is in the shape the protocol speaks', async () => {
  const { bridge, dispose } = await makeBridge();
  bridge.tools.call = async () => ({
    ok: true,
    content: [],
    // The real team tool answers with a bare array of helpers.
    structuredContent: [
      { helper_id: 'hlp_1', bot: 'Writer', title: 'Research', status: 'done', seconds: 42, report: 'done' },
    ],
  });

  const result = /** @type {any} */ (await bridge.dispatch('op.list_helpers', {}));

  assert.equal(result.helpers.length, 1);
  assert.equal(result.helpers[0].helperId, 'hlp_1');
  assert.equal(result.helpers[0].state, 'done');
  assert.equal(result.helpers[0].seconds, 42);
  assert.equal(result.helpers[0].detail, 'done');
  await dispose();
});

test('the schedule list is in the shape the protocol speaks', async () => {
  const { bridge, dispose } = await makeBridge();
  bridge.tools.call = async () => ({
    ok: true,
    content: [],
    // The real team tool answers with a bare array of schedules.
    structuredContent: [
      {
        schedule_id: 'sch_1',
        name: 'Standup',
        bot_id: 'bot_b1',
        kind: 'daily',
        time: '09:00',
        prompt: 'summarise',
        enabled: true,
        next_run: '2026-10-29T09:00:00.000Z',
        last_run: null,
      },
    ],
  });

  const result = /** @type {any} */ (await bridge.dispatch('op.list_schedules', {}));

  assert.equal(result.schedules.length, 1);
  assert.equal(result.schedules[0].scheduleId, 'sch_1');
  assert.equal(result.schedules[0].spec, '09:00');
  assert.equal(result.schedules[0].targetBotId, 'bot_b1');
  assert.equal(result.schedules[0].nextRunAt, Date.parse('2026-10-29T09:00:00.000Z'));
  await dispose();
});

test('a memory the phone asks for is filed under a topic of its own', async () => {
  const { bridge, toolCalls, dispose } = await makeBridge();

  const result = /** @type {any} */ (await bridge.dispatch('op.remember', { botId: 'bot_b1', text: 'note' }));

  // The team's memory tool refuses a memory with neither a topic nor an entry to
  // replace, so the bridge gives the note a topic.
  assert.match(result.key, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.equal(toolCalls[0].arguments.key, result.key);
  assert.equal(toolCalls[0].arguments.target_bot, 'bot_b1');
  assert.equal(toolCalls[0].arguments.text, 'note');
  await dispose();
});

test('a memory the phone files under a topic keeps that topic', async () => {
  const { bridge, toolCalls, dispose } = await makeBridge();

  await bridge.dispatch('op.remember', { botId: 'bot_b1', text: 'note', key: 'launch.date' });

  assert.equal(toolCalls[0].arguments.key, 'launch.date');
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
