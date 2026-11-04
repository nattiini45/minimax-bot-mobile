import { buildThread } from '../src/state/thread';
import type { AppActivity, AppMessage } from '../src/state/store';

/**
 * The thread as the reader sees it.
 *
 * A turn the desktop's own engine runs is one record on the desktop that holds the
 * whole exchange, so it reaches the phone as several messages and the tool calls it
 * made. The calls belong with the turn they came from, so that the phone shows the
 * same work the desktop shows, where it happened.
 */

function message(messageId: string, turnId?: string, ts = 1): AppMessage {
  return {
    messageId,
    chatId: 'bot:bot_b1',
    role: 'assistant',
    text: messageId,
    ts,
    ...(turnId ? { turnId } : {}),
  };
}

function call(id: string, turnId: string): AppActivity {
  return {
    id,
    chatId: 'bot:bot_b1',
    turnId,
    toolName: 'bash',
    status: 'ok',
  };
}

test('the calls of a turn go under the last message of that turn', () => {
  const items = buildThread(
    [message('m1', 'turn-1', 1), message('m2', 'turn-1', 2), message('m3', 'turn-2', 3)],
    [call('c1', 'turn-1'), call('c2', 'turn-2')],
  );

  expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'turnActivity', 'message', 'turnActivity']);
  const group = items[2];
  expect(group.kind).toBe('turnActivity');
  expect(group.kind === 'turnActivity' ? group.entries.map((entry) => entry.id) : []).toEqual(['c1']);
});

test('a turn of several messages keeps them together', () => {
  const items = buildThread(
    [message('m1', 'turn-1', 1), message('m2', 'turn-1', 2), message('m3', 'turn-1', 3)],
    [call('c1', 'turn-1'), call('c2', 'turn-1')],
  );

  expect(items.map((item) => item.kind)).toEqual(['message', 'message', 'message', 'turnActivity']);
  const group = items[3];
  expect(group.kind === 'turnActivity' ? group.entries.length : 0).toBe(2);
});

test('a turn whose messages never arrived still shows its calls', () => {
  const items = buildThread([message('m1', 'turn-1', 1)], [call('c1', 'turn-2')]);

  expect(items.map((item) => item.kind)).toEqual(['message', 'turnActivity']);
  const group = items[1];
  expect(group.kind === 'turnActivity' ? group.entries.map((entry) => entry.id) : []).toEqual(['c1']);
});

test('a message without a turn does not collect the calls of one', () => {
  const items = buildThread([message('m1', undefined, 1)], [call('c1', 'turn-1')]);

  expect(items.map((item) => item.kind)).toEqual(['message', 'turnActivity']);
});

test('a thread with no calls is only its messages', () => {
  const items = buildThread([message('m1', 'turn-1', 1), message('m2', 'turn-1', 2)], []);

  expect(items.map((item) => item.kind)).toEqual(['message', 'message']);
});

test('each speaker is identified when a group turn changes author', () => {
  const items = buildThread([
    { ...message('m1', 'task_group', 1), authorId: 'bot_writer' },
    { ...message('m2', 'task_group', 2), authorId: 'bot_writer' },
    { ...message('m3', 'task_group', 3), authorId: 'bot_reviewer' },
    { ...message('m4', 'task_group', 4), authorId: 'bot_writer' },
  ]);

  expect(items.map((item) => item.kind === 'message' && item.showAuthor)).toEqual([true, false, true, true]);
});

test('a user message sharing a task does not hide the responding Bot', () => {
  const items = buildThread([
    { ...message('request', 'task_group', 1), role: 'user', authorId: 'phone' },
    { ...message('answer', 'task_group', 2), authorId: 'bot_writer' },
  ]);

  expect(items.map((item) => item.kind === 'message' && item.showAuthor)).toEqual([true, true]);
});

test('the face of a Bot belongs to the first message of its turn', () => {
  const items = buildThread(
    [message('m1', 'turn-1', 1), message('m2', 'turn-1', 2), message('m3', 'turn-2', 3)],
    [],
  );

  const shown = items.map((item) => (item.kind === 'message' ? item.showAuthor : null));
  // The desktop shows the face once for the whole of a turn, not once per bubble.
  expect(shown).toEqual([true, false, true]);
});
