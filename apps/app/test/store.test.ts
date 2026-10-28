import { createFrame } from '@minimax-bot/protocol';

import { useAppStore } from '../src/state/store';

/**
 * The store is the phone's projection of the desktop, so these tests drive it with the
 * frames the bridge actually sends.
 */

function reset() {
  useAppStore.setState({
    session: null,
    status: 'idle',
    lastError: null,
    bridgeOnline: false,
    bots: [],
    groups: [],
    tools: [],
    diagnostics: { agentAvailable: false, teamToolsAvailable: false, toolCount: 0, partial: false },
    messages: {},
    tasks: [],
    helpers: [],
    schedules: [],
    approvals: [],
    questions: [],
    usage: null,
    outbox: [],
    optimisticByOp: {},
    pendingOp: {},
  });
}

function event(type: string, payload: unknown) {
  return createFrame({ type, payload, source: 'bridge' });
}

describe('the team snapshot', () => {
  beforeEach(reset);

  it('fills the roster and the diagnostics', () => {
    useAppStore.getState().applyFrame(
      event('evt.team_snapshot', {
        bots: [{ botId: 'b1', name: 'Writer' }],
        groups: [{ groupId: 'g1', name: 'Team', memberIds: ['b1'] }],
        diagnostics: { agentAvailable: true, teamToolsAvailable: true, toolCount: 22, partial: false },
        tools: [{ name: 'mcp__minimax-bot__message_bot', server: 'minimax-bot', tool: 'message_bot' }],
      }),
    );

    const state = useAppStore.getState();
    expect(state.bots).toHaveLength(1);
    expect(state.groups[0]?.name).toBe('Team');
    expect(state.diagnostics.toolCount).toBe(22);
    expect(state.tools).toHaveLength(1);
  });

  it('does not let a group without members take the screen down', () => {
    useAppStore.getState().applyFrame(
      event('evt.team_snapshot', {
        bots: [{ botId: 'b1', name: 'Writer' }],
        groups: [{ groupId: 'g1', name: 'Team' }],
        diagnostics: { agentAvailable: true, teamToolsAvailable: true, toolCount: 1, partial: false },
        tools: [],
      }),
    );

    expect(useAppStore.getState().groups[0]?.memberIds).toEqual([]);
  });
});

describe('streaming a reply', () => {
  beforeEach(reset);

  it('accumulates chunks into one message', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.message_chunk', { chatId: 'bot:b1', turnId: 't1', messageId: 'msg_t1', text: 'Hel' }),
    );
    store.applyFrame(
      event('evt.message_chunk', { chatId: 'bot:b1', turnId: 't1', messageId: 'msg_t1', text: 'lo' }),
    );

    const messages = useAppStore.getState().messages['bot:b1'];
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.text).toBe('Hello');
    expect(messages?.[0]?.pending).toBe(true);
  });

  it('replaces the streamed message with the committed one', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.message_chunk', { chatId: 'bot:b1', turnId: 't1', messageId: 'msg_t1', text: 'Hello' }),
    );
    store.applyFrame(
      event('evt.message_committed', {
        message: {
          messageId: 'msg_t1',
          chatId: 'bot:b1',
          role: 'assistant',
          text: 'Hello',
          ts: 1000,
          authorId: 'b1',
        },
      }),
    );

    const messages = useAppStore.getState().messages['bot:b1'];
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.pending).toBe(false);
    expect(messages?.[0]?.authorId).toBe('b1');
  });

  it('clears the pending flag when the turn finishes', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.message_chunk', { chatId: 'bot:b1', turnId: 't1', messageId: 'msg_t1', text: 'Hi' }),
    );
    store.applyFrame(event('evt.turn_finished', { chatId: 'bot:b1', turnId: 't1', status: 'finished' }));

    expect(useAppStore.getState().messages['bot:b1']?.[0]?.pending).toBe(false);
  });

  it('keeps a user message and an assistant message apart', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.message_committed', {
        message: { messageId: 'm1', chatId: 'bot:b1', role: 'user', text: 'hi', ts: 1 },
      }),
    );
    store.applyFrame(
      event('evt.message_committed', {
        message: { messageId: 'm2', chatId: 'bot:b1', role: 'assistant', text: 'hello', ts: 2 },
      }),
    );

    expect(useAppStore.getState().messages['bot:b1']).toHaveLength(2);
  });
});

describe('sending a message', () => {
  beforeEach(reset);

  it('shows the message right away, before the desktop confirms it', () => {
    useAppStore.getState().sendChatMessage('bot:b1', 'Hello there');

    const messages = useAppStore.getState().messages['bot:b1'];
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.role).toBe('user');
    expect(messages?.[0]?.text).toBe('Hello there');
    expect(messages?.[0]?.pending).toBe(true);
  });

  it('replaces the pending bubble with the committed message instead of adding one', () => {
    useAppStore.getState().sendChatMessage('bot:b1', 'Hello there');
    const pending = useAppStore.getState().messages['bot:b1']?.[0];
    expect(pending?.messageId).toBeTruthy();

    useAppStore.getState().applyFrame(
      event('evt.message_committed', {
        message: {
          messageId: pending!.messageId,
          chatId: 'bot:b1',
          role: 'user',
          text: 'Hello there',
          ts: 5,
        },
      }),
    );

    const messages = useAppStore.getState().messages['bot:b1'];
    expect(messages).toHaveLength(1);
    expect(messages?.[0]?.pending).toBe(false);
    expect(messages?.[0]?.text).toBe('Hello there');
  });

  it('takes the bubble back out when the desktop refuses the send', () => {
    useAppStore.getState().sendChatMessage('bot:b1', 'Hello there');
    const opId = useAppStore.getState().outbox[0]?.opId;
    expect(opId).toBeTruthy();

    useAppStore.getState().applyFrame(
      createFrame({
        type: 'err',
        payload: { opId, code: 'AGENT_UNAVAILABLE', message: 'The desktop is busy.', retryable: true },
        source: 'bridge',
      }),
    );

    expect(useAppStore.getState().messages['bot:b1']).toHaveLength(0);
    expect(useAppStore.getState().optimisticByOp).toEqual({});
  });

  it('sends the message id it chose, so the desktop can echo it back', () => {
    useAppStore.getState().sendChatMessage('bot:b1', 'Hello there');

    const queued = useAppStore.getState().outbox[0];
    const payload = queued?.payload as { clientMessageId?: string };
    expect(payload.clientMessageId).toBeTruthy();
    expect(payload.clientMessageId).toBe(useAppStore.getState().messages['bot:b1']?.[0]?.messageId);
  });
});

describe('approvals', () => {
  beforeEach(reset);

  it('holds a permission request until it is resolved', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.permission_requested', {
        request: { requestId: 'r1', sessionId: 's1', toolName: 'shell', reason: 'writes a file' },
      }),
    );
    expect(useAppStore.getState().approvals).toHaveLength(1);

    store.applyFrame(event('evt.permission_resolved', { requestId: 'r1', decision: 'allowOnce' }));
    expect(useAppStore.getState().approvals).toHaveLength(0);
  });

  it('holds a questionnaire', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.question_requested', {
        request: { requestId: 'q1', sessionId: 's1', steps: [] },
      }),
    );
    expect(useAppStore.getState().questions).toHaveLength(1);

    store.applyFrame(event('evt.question_answered', { requestId: 'q1' }));
    expect(useAppStore.getState().questions).toHaveLength(0);
  });
});

describe('bridge status', () => {
  beforeEach(reset);

  it('tracks whether the desktop is online', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.bridge_status', {
        desktopOnline: true,
        agentAvailable: true,
        teamToolsAvailable: true,
      }),
    );

    expect(useAppStore.getState().bridgeOnline).toBe(true);
    expect(useAppStore.getState().diagnostics.agentAvailable).toBe(true);
  });

  it('reports the relay as connected on hello', () => {
    useAppStore.getState().applyFrame(
      createFrame({ type: 'hello.ok', payload: { seq: 4, bridgeOnline: true }, source: 'relay' }),
    );
    expect(useAppStore.getState().bridgeOnline).toBe(true);
  });
});

describe('errors', () => {
  beforeEach(reset);

  it('records the message of a failed request', () => {
    useAppStore.getState().applyFrame(
      createFrame({
        type: 'err',
        payload: { code: 'TOOL_NOT_AVAILABLE', message: 'The team is not running.', retryable: true },
        source: 'bridge',
      }),
    );

    expect(useAppStore.getState().lastError).toBe('The team is not running.');
  });
});
