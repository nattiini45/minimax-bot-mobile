import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolArgumentError, ToolGateway, buildToolArguments } from '../miniapp/node/tools.mjs';

test('passes the payload through when the schema is unknown', () => {
  const args = buildToolArguments({ botId: 'b1', text: 'hi' }, undefined);
  assert.deepEqual(args, { botId: 'b1', text: 'hi' });
});

test('maps operation fields onto schema property names', () => {
  const schema = {
    type: 'object',
    properties: { to: { type: 'string' }, message: { type: 'string' } },
    required: ['to', 'message'],
  };
  const args = buildToolArguments({ botId: 'b1', text: 'hello' }, schema);
  assert.deepEqual(args, { to: 'b1', message: 'hello' });
});

test('keeps a property whose name matches exactly', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } };
  const args = buildToolArguments({ title: 'Digest' }, schema);
  assert.deepEqual(args, { title: 'Digest' });
});

/*
 * The schemas below are the ones the real `@minimax-bot` team tools advertise. They
 * are copied from the tool catalogue rather than invented, because the whole point of
 * mapping the payload onto the live schema is that the two agree.
 */

test('a memory tool that names its target bot receives it', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
      scope: { type: 'string', enum: ['self', 'team', 'bot'] },
      target_bot: { type: 'string' },
    },
  };
  const args = buildToolArguments({ botId: 'bot_b1', query: 'changelog', limit: 5 }, schema);
  assert.deepEqual(args, { query: 'changelog', limit: 5, target_bot: 'bot_b1' });
});

test('a group tool that names its group receives it', () => {
  const schema = {
    type: 'object',
    properties: {
      group: { type: 'string' },
      name: { type: 'string' },
      members: { type: 'array', items: { type: 'string' } },
      reply_mode: { type: 'string', enum: ['admin', 'all'] },
    },
    required: ['group'],
  };
  const args = buildToolArguments(
    { groupId: 'grp_g1', name: 'Studio', memberIds: ['bot_b1'], replyMode: 'admin' },
    schema,
  );
  assert.deepEqual(args, {
    group: 'grp_g1',
    name: 'Studio',
    members: ['bot_b1'],
    reply_mode: 'admin',
  });
});

test('a bot tool that names its bot receives it', () => {
  const schema = {
    type: 'object',
    properties: { bot: { type: 'string' }, name: { type: 'string' }, main: { type: 'boolean' } },
    required: ['bot'],
  };
  const args = buildToolArguments({ botId: 'bot_b1', name: 'Writer', main: true }, schema);
  assert.deepEqual(args, { bot: 'bot_b1', name: 'Writer', main: true });
});

test('the caller the team fills in itself is never a missing argument', () => {
  const schema = {
    type: 'object',
    properties: {
      caller_bot_id: { type: 'string', minLength: 1 },
      task: { type: 'string' },
      title: { type: 'string' },
    },
    required: ['caller_bot_id', 'task'],
  };
  const args = buildToolArguments({ task: 'do the thing', title: 'Thing' }, schema);
  assert.deepEqual(args, { task: 'do the thing', title: 'Thing' });
});

test('a schedule tool receives the time its kind asks for', () => {
  const schema = {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      name: { type: 'string' },
      kind: { type: 'string', enum: ['daily', 'interval', 'once'] },
      time: { type: 'string' },
      every_minutes: { type: 'integer' },
      in_minutes: { type: 'integer' },
      target_bot: { type: 'string' },
    },
    required: ['prompt', 'kind'],
  };
  const args = buildToolArguments(
    { prompt: 'write the notes', name: 'Notes', kind: 'daily', spec: '09:00', targetBotId: 'bot_b1' },
    schema,
  );
  assert.deepEqual(args, {
    prompt: 'write the notes',
    name: 'Notes',
    kind: 'daily',
    time: '09:00',
    target_bot: 'bot_b1',
  });
});

test('refuses when a required property cannot be satisfied', () => {
  const schema = {
    type: 'object',
    properties: { to: { type: 'string' }, message: { type: 'string' } },
    required: ['to', 'message'],
  };
  assert.throws(
    () => buildToolArguments({ text: 'hello' }, schema),
    (error) => {
      assert.ok(error instanceof ToolArgumentError);
      assert.equal(error.code, 'INVALID_ARGUMENTS');
      // `text` satisfies `message`; only the recipient is missing.
      assert.deepEqual(error.details.missing, ['to']);
      return true;
    },
  );
});

test('drops payload fields the schema does not know', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } };
  const args = buildToolArguments({ title: 'Digest', extra: 'ignored' }, schema);
  assert.deepEqual(args, { title: 'Digest' });
});

test('the gateway only exposes the team tools', async () => {
  const context = {
    tool: {
      async list() {
        return {
          tools: [
            { name: 'mcp__minimax-bot__message_bot', server: 'minimax-bot', tool: 'message_bot' },
            { name: 'mcp__other-server__thing', server: 'other-server', tool: 'thing' },
          ],
          partial: false,
        };
      },
      async call() {
        return { ok: true, content: [] };
      },
    },
  };
  const gateway = new ToolGateway(context);
  await gateway.refresh();

  assert.equal(gateway.available, true);
  assert.equal(gateway.catalog.length, 1);
  assert.equal(gateway.find('message_bot')?.name, 'mcp__minimax-bot__message_bot');
  assert.equal(gateway.find('thing'), undefined);
});

test('the gateway reports an unavailable team instead of throwing', async () => {
  const gateway = new ToolGateway({
    tool: {
      async list() {
        throw new Error('MCP_SERVER_LIST_FAILED');
      },
    },
  });
  await gateway.refresh();

  assert.equal(gateway.available, false);
  assert.equal(gateway.catalog.length, 0);
  assert.match(gateway.reason, /MCP_SERVER_LIST_FAILED/);
});

test('the gateway reports a missing tool grant', async () => {
  const gateway = new ToolGateway({});
  await gateway.refresh();

  assert.equal(gateway.available, false);
  assert.match(gateway.reason, /tool access/i);
});

test('calling an unavailable tool is refused, not dispatched', async () => {
  const gateway = new ToolGateway({});
  await gateway.refresh();

  const result = await gateway.call('message_bot', { botId: 'b1' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TOOL_NOT_AVAILABLE');
  assert.equal(result.disposition, 'not_dispatched');
});

test('calling a tool forwards the mapped arguments', async () => {
  const seen = [];
  const gateway = new ToolGateway({
    tool: {
      async list() {
        return {
          tools: [
            {
              name: 'mcp__minimax-bot__message_bot',
              server: 'minimax-bot',
              tool: 'message_bot',
              inputSchema: {
                type: 'object',
                properties: { to: { type: 'string' }, message: { type: 'string' } },
                required: ['to', 'message'],
              },
            },
          ],
          partial: false,
        };
      },
      async call(input) {
        seen.push(input);
        return { ok: true, content: [{ type: 'text', text: '{"ok":true}' }] };
      },
    },
  });
  await gateway.refresh();

  const result = await gateway.call('message_bot', { botId: 'b1', text: 'hello' });
  assert.equal(result.ok, true);
  assert.deepEqual(seen[0].arguments, { to: 'b1', message: 'hello' });
  assert.equal(seen[0].name, 'mcp__minimax-bot__message_bot');
});

test('a tool that reports an error is surfaced as a failure', async () => {
  const gateway = new ToolGateway({
    tool: {
      async list() {
        return {
          tools: [{ name: 'mcp__minimax-bot__list_team', server: 'minimax-bot', tool: 'list_team' }],
          partial: false,
        };
      },
      async call() {
        return { ok: true, isError: true, content: [] };
      },
    },
  });
  await gateway.refresh();

  const result = await gateway.call('list_team', {});
  assert.equal(result.ok, true);
  assert.equal(result.isError, true);
});
