import { MAX_ACTIVITY_CALLS, createFrame } from '@minimax-bot/protocol';

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
    activity: {},
    activeTurn: {},
    turnStartedAt: {},
    reactions: {},
    tasks: [],
    tasksNote: null,
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

  it.each([true, false])('retains refused text with the desktop retry policy (retryable=%s)', (retryable) => {
    useAppStore.getState().sendChatMessage('bot:b1', 'Hello there');
    const messageId = useAppStore.getState().messages['bot:b1']![0]!.messageId;
    const opId = useAppStore.getState().outbox[0]?.opId;
    expect(opId).toBeTruthy();
    expect(useAppStore.getState().optimisticByOp[opId!]).toEqual({ messageId, chatId: 'bot:b1' });

    useAppStore.getState().applyFrame(
      createFrame({
        type: 'err',
        payload: { opId, code: 'AGENT_UNAVAILABLE', message: 'The desktop is busy.', retryable },
        source: 'bridge',
      }),
    );

    expect(useAppStore.getState().messages['bot:b1']).toEqual([
      expect.objectContaining({
        messageId, text: 'Hello there', pending: false,
        deliveryError: 'The desktop is busy.', deliveryUncertain: false, retryable,
      }),
    ]);
    expect(useAppStore.getState().optimisticByOp).toEqual({});
    expect(useAppStore.getState().outbox.some(item => item.opId === opId)).toBe(false);
    if (!retryable) {
      expect(useAppStore.getState().retryMessage('bot:b1', messageId)).toBe(false);
      expect(useAppStore.getState().messages['bot:b1']![0]!.text).toBe('Hello there');
    }
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

describe('the live trace', () => {
  beforeEach(reset);

  it('remembers the turn a chat is running', () => {
    useAppStore.getState().applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't1' }));
    expect(useAppStore.getState().activeTurn['bot:b1']).toBe('t1');
  });

  it('records a tool call while it runs and closes it when it reports back', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't1' }));
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 't1', toolName: 'bash', callId: 'call_1' }),
    );

    let entry = useAppStore.getState().activity['bot:b1']?.[0];
    expect(entry?.toolName).toBe('bash');
    expect(entry?.status).toBe('running');
    expect(entry?.id).toBe('call_1');

    store.applyFrame(
      event('evt.tool_finished', {
        chatId: 'bot:b1',
        turnId: 't1',
        toolName: 'bash',
        callId: 'call_1',
        ok: true,
        usage: { durationMs: 489 },
      }),
    );

    entry = useAppStore.getState().activity['bot:b1']?.[0];
    expect(entry?.status).toBe('ok');
    expect(entry?.durationMs).toBe(489);
  });

  it('marks a failed tool as failed and keeps the reason', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 't1', toolName: 'bash', callId: 'call_1' }),
    );
    store.applyFrame(
      event('evt.tool_finished', {
        chatId: 'bot:b1',
        turnId: 't1',
        toolName: 'bash',
        callId: 'call_1',
        ok: false,
        error: 'permission denied',
      }),
    );

    const entry = useAppStore.getState().activity['bot:b1']?.[0];
    expect(entry?.status).toBe('failed');
    expect(entry?.error).toBe('permission denied');
  });

  it('closes the call the finish names, not the newest one', () => {
    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 't1', toolName: 'bash', callId: 'call_1' }),
    );
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 't1', toolName: 'bash', callId: 'call_2' }),
    );
    // The first call is the one that reports back.
    store.applyFrame(
      event('evt.tool_finished', {
        chatId: 'bot:b1',
        turnId: 't1',
        toolName: 'bash',
        callId: 'call_1',
        ok: true,
        usage: { durationMs: 100 },
      }),
    );

    const list = useAppStore.getState().activity['bot:b1'] ?? [];
    expect(list[0]?.status).toBe('ok');
    expect(list[0]?.durationMs).toBe(100);
    expect(list[1]?.status).toBe('running');
  });

  it('gives every call an id of its own', () => {
    const store = useAppStore.getState();
    for (let i = 0; i < 45; i += 1) {
      store.applyFrame(
        event('evt.tool_started', {
          chatId: 'bot:b1',
          turnId: 't1',
          toolName: 'bash',
          callId: `call_${i}`,
        }),
      );
    }

    const list = useAppStore.getState().activity['bot:b1'] ?? [];
    const ids = list.map((entry) => entry.id);
    // Duplicate ids would be duplicate React keys in the rail.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps a running call when the list is trimmed', () => {
    const store = useAppStore.getState();
    for (let i = 0; i < 45; i += 1) {
      store.applyFrame(
        event('evt.tool_started', {
          chatId: 'bot:b1',
          turnId: 't1',
          toolName: 'bash',
          callId: `call_${i}`,
        }),
      );
      store.applyFrame(
        event('evt.tool_finished', {
          chatId: 'bot:b1',
          turnId: 't1',
          toolName: 'bash',
          callId: `call_${i}`,
          ok: true,
        }),
      );
    }
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 't1', toolName: 'bash', callId: 'call_run' }),
    );

    const list = useAppStore.getState().activity['bot:b1'] ?? [];
    // A turn is kept whole, so the calls of the turn that is running are all there.
    expect(list.length).toBe(46);
    // The call that is still running is the truth about the team, so it is kept.
    expect(list.some((entry) => entry.id === 'call_run')).toBe(true);
  });

  it('drops the calls of the oldest turn, and never splits a turn', () => {
    const store = useAppStore.getState();
    // Two turns, and the older one is the one that goes.
    store.applyFrame(
      event('evt.message_committed', {
        message: { messageId: 'm1', chatId: 'bot:b1', role: 'assistant', text: 'First.', ts: 1, turnId: 't1' },
      }),
    );
    store.applyFrame(
      event('evt.message_committed', {
        message: { messageId: 'm2', chatId: 'bot:b1', role: 'assistant', text: 'Second.', ts: 2, turnId: 't2' },
      }),
    );
    // The calls are closed, so that the running turn is not the one that is kept.
    for (let i = 0; i < MAX_ACTIVITY_CALLS; i += 1) {
      store.applyFrame(
        event('evt.tool_started', {
          chatId: 'bot:b1',
          turnId: 't1',
          toolName: 'bash',
          callId: `old_${i}`,
        }),
      );
      store.applyFrame(
        event('evt.tool_finished', {
          chatId: 'bot:b1',
          turnId: 't1',
          toolName: 'bash',
          callId: `old_${i}`,
          ok: true,
        }),
      );
    }
    for (let i = 0; i < 100; i += 1) {
      store.applyFrame(
        event('evt.tool_started', {
          chatId: 'bot:b1',
          turnId: 't2',
          toolName: 'read',
          callId: `new_${i}`,
        }),
      );
      store.applyFrame(
        event('evt.tool_finished', {
          chatId: 'bot:b1',
          turnId: 't2',
          toolName: 'read',
          callId: `new_${i}`,
          ok: true,
        }),
      );
    }

    const list = useAppStore.getState().activity['bot:b1'] ?? [];
    // The older turn is gone whole; the newer one is whole as well.
    expect(list.some((entry) => entry.turnId === 't1')).toBe(false);
    expect(list.filter((entry) => entry.turnId === 't2')).toHaveLength(100);
  });

  it('forgets the running turn when it finishes', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't1' }));
    store.applyFrame(event('evt.turn_finished', { chatId: 'bot:b1', turnId: 't1', status: 'finished' }));

    expect(useAppStore.getState().activeTurn['bot:b1']).toBeUndefined();
  });

  it('keeps the new turn when an older one finishes late', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't1' }));
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't2' }));
    // The desktop can start the next turn before the previous one reports.
    store.applyFrame(event('evt.turn_finished', { chatId: 'bot:b1', turnId: 't1', status: 'finished' }));

    expect(useAppStore.getState().activeTurn['bot:b1']).toBe('t2');
  });

  it('closes a tool that never reported back when the turn ends', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't1' }));
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 't1', toolName: 'bash', callId: 'call_1' }),
    );
    store.applyFrame(event('evt.turn_finished', { chatId: 'bot:b1', turnId: 't1', status: 'aborted' }));

    const entry = useAppStore.getState().activity['bot:b1']?.[0];
    // No tool result was observed. Match the bridge's history without claiming
    // the tool failed merely because its containing turn was aborted.
    expect(entry?.status).toBe('unknown');
  });

  it('leaves another chat alone', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't1' }));
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b2', turnId: 't2' }));
    store.applyFrame(event('evt.turn_finished', { chatId: 'bot:b1', turnId: 't1', status: 'finished' }));

    expect(useAppStore.getState().activeTurn['bot:b2']).toBe('t2');
  });

  it('drops the trace when the relay says it lost frames', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.turn_started', { chatId: 'bot:b1', turnId: 't1' }));
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 't1', toolName: 'bash', callId: 'call_1' }),
    );
    store.applyFrame(
      createFrame({ type: 'hello.ok', payload: { bridgeOnline: true, truncated: true }, source: 'relay' }),
    );

    expect(useAppStore.getState().activeTurn['bot:b1']).toBeUndefined();
    expect(useAppStore.getState().activity['bot:b1']).toBeUndefined();
  });

  it('counts the rebuild, so an open conversation can be read again', () => {
    const before = useAppStore.getState().resyncCount;

    useAppStore.getState().applyFrame(
      createFrame({ type: 'hello.ok', payload: { bridgeOnline: true, truncated: true }, source: 'relay' }),
    );

    // The projection was dropped, so the screen showing a conversation has to
    // read the thread again. It cannot tell that from the messages alone - they
    // are simply gone - so the count is what tells it.
    expect(useAppStore.getState().resyncCount).toBe(before + 1);
  });

  it('does not count a rebuild when nothing was lost', () => {
    const before = useAppStore.getState().resyncCount;

    useAppStore.getState().applyFrame(
      createFrame({ type: 'hello.ok', payload: { bridgeOnline: true, truncated: false }, source: 'relay' }),
    );

    expect(useAppStore.getState().resyncCount).toBe(before);
  });
});

describe('reactions', () => {
  beforeEach(reset);

  it('counts the same emoji on one message', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.reaction_added', { reaction: { messageId: 'm1', emoji: '👍' } }));
    store.applyFrame(event('evt.reaction_added', { reaction: { messageId: 'm1', emoji: '👍' } }));

    const list = useAppStore.getState().reactions['m1'];
    expect(list).toHaveLength(1);
    expect(list?.[0]?.count).toBe(2);
  });

  it('keeps different emoji apart', () => {
    const store = useAppStore.getState();
    store.applyFrame(event('evt.reaction_added', { reaction: { messageId: 'm1', emoji: '👍' } }));
    store.applyFrame(event('evt.reaction_added', { reaction: { messageId: 'm1', emoji: '🎉' } }));

    expect(useAppStore.getState().reactions['m1']).toHaveLength(2);
  });

  it('asks the desktop, so the count is the desktop’s', () => {
    const request = jest.spyOn(useAppStore.getState(), 'request').mockReturnValue('op-1');
    useAppStore.getState().react('m1', '🔥');
    expect(request).toHaveBeenCalledWith('op.react', { messageId: 'm1', emoji: '🔥' });
    request.mockRestore();
  });

  it('reads the counts the desktop owns when the thread is loaded', () => {
    // `requestAsync` is the path a screen uses: it registers the operation and the
    // payload the answer is applied to, which is what the ack carries back.
    const pending = useAppStore.getState().requestAsync('op.list_history', { chatId: 'bot:b1' });
    const opId = Object.keys(useAppStore.getState().pendingOp)[0]!;
    useAppStore.getState().applyFrame(
      createFrame({
        type: 'ack',
        payload: {
          opId,
          result: {
            messages: [{ messageId: 'm1', chatId: 'bot:b1', role: 'assistant', text: 'hi', ts: 1 }],
            reactions: [{ messageId: 'm1', emoji: '👍', count: 3 }],
          },
        },
        source: 'relay',
      }),
    );
    void pending;

    expect(useAppStore.getState().reactions['m1']?.[0]?.count).toBe(3);
  });
});

describe('the exchange of a turn the team ran', () => {
  beforeEach(reset);

  it('does not duplicate a repeated tool start', () => {
    const payload = { chatId: 'bot:b1', turnId: 'task_1', toolName: 'bash', callId: 'call_1' };
    const store = useAppStore.getState();
    store.applyFrame(event('evt.tool_started', payload));
    store.applyFrame(event('evt.tool_started', payload));

    expect(useAppStore.getState().activity['bot:b1']).toHaveLength(1);
  });

  it('does not turn a successful history call into a duplicate failure during replay', async () => {
    const pending = useAppStore.getState().requestAsync('op.list_history', { chatId: 'bot:b1' });
    const opId = Object.keys(useAppStore.getState().pendingOp)[0]!;
    useAppStore.getState().applyFrame(createFrame({
      type: 'ack', source: 'relay', payload: { opId, result: {
        messages: [{ messageId: 'msg_1', chatId: 'bot:b1', role: 'assistant', text: 'Done', ts: 1, turnId: 'task_1' }],
        activity: [{ turnId: 'task_1', callId: 'call_1', toolName: 'bash', status: 'ok', durationMs: 12 }],
      } },
    }));
    await pending;

    const store = useAppStore.getState();
    const payload = { chatId: 'bot:b1', turnId: 'task_1', toolName: 'bash', callId: 'call_1' };
    store.applyFrame(event('evt.tool_started', payload));
    expect(useAppStore.getState().activity['bot:b1']).toEqual([
      expect.objectContaining({ id: 'call_1', status: 'ok', durationMs: 12 }),
    ]);
    store.applyFrame(event('evt.tool_finished', { ...payload, ok: true }));
    store.applyFrame(event('evt.turn_finished', { chatId: 'bot:b1', turnId: 'task_1', status: 'finished' }));

    expect(useAppStore.getState().activity['bot:b1']).toEqual([
      expect.objectContaining({ id: 'call_1', status: 'ok', durationMs: 12 }),
    ]);
  });

  it('keeps the turn a message belongs to', () => {
    useAppStore.getState().applyFrame(
      event('evt.message_committed', {
        message: {
          messageId: 'msg_1#p0',
          chatId: 'bot:b1',
          role: 'assistant',
          text: 'Working on it.',
          ts: 1,
          turnId: 'task_1',
        },
      }),
    );

    expect(useAppStore.getState().messages['bot:b1']?.[0]?.turnId).toBe('task_1');
  });

  it('marks a message that was written on the desktop', () => {
    useAppStore.getState().applyFrame(
      event('evt.message_committed', {
        message: {
          messageId: 'msg_typed',
          chatId: 'bot:b1',
          role: 'user',
          text: 'Typed on the desktop',
          ts: 1,
          origin: 'desktop',
        },
      }),
    );

    expect(useAppStore.getState().messages['bot:b1']?.[0]?.origin).toBe('desktop');
  });

  it('reads the turn and the calls back with the thread', () => {
    const pending = useAppStore.getState().requestAsync('op.list_history', { chatId: 'bot:b1' });
    const opId = Object.keys(useAppStore.getState().pendingOp)[0]!;
    useAppStore.getState().applyFrame(
      createFrame({
        type: 'ack',
        payload: {
          opId,
          result: {
            messages: [
              { messageId: 'msg_1#p0', chatId: 'bot:b1', role: 'assistant', text: 'Working on it.', ts: 1, turnId: 'task_1' },
              { messageId: 'msg_typed', chatId: 'bot:b1', role: 'user', text: 'Hello', ts: 2, origin: 'desktop' },
            ],
            activity: [{ turnId: 'task_1', callId: 'msg_1#t1', toolName: 'bash', status: 'ok' }],
          },
        },
        source: 'relay',
      }),
    );
    void pending;

    const state = useAppStore.getState();
    expect(state.messages['bot:b1']?.[0]?.turnId).toBe('task_1');
    expect(state.messages['bot:b1']?.[1]?.origin).toBe('desktop');
    expect(state.activity['bot:b1']).toHaveLength(1);
    expect(state.activity['bot:b1']?.[0]?.toolName).toBe('bash');
  });

  it('keeps a turn whole when the list grows too long', () => {
    // A turn can use dozens of tools. Showing some of them would say that the Bot used
    // fewer tools than it did, so the calls of a turn go together and an older turn is
    // the one that is dropped.
    const calls = Array.from({ length: MAX_ACTIVITY_CALLS + 100 }, (_, index) => ({
      id: `c${index}`,
      chatId: 'bot:b1',
      turnId: 'task_new',
      toolName: 'bash',
      status: 'ok' as const,
    }));
    useAppStore.setState({
      activity: {
        'bot:b1': [
          ...calls.map((entry) => ({ ...entry, id: `old_${entry.id}`, turnId: 'task_old' })),
          ...calls,
        ],
      },
    });

    const store = useAppStore.getState();
    store.applyFrame(
      event('evt.tool_started', { chatId: 'bot:b1', turnId: 'task_new', toolName: 'bash', callId: 'c_new' }),
    );

    const kept = useAppStore.getState().activity['bot:b1'] ?? [];
    const turns = new Set(kept.map((entry) => entry.turnId));
    // The old turn is gone as a whole, and the new one is complete.
    expect(turns.has('task_old')).toBe(false);
    expect(kept.filter((entry) => entry.turnId === 'task_new')).toHaveLength(MAX_ACTIVITY_CALLS + 101);
  });

  it('keeps every call of a turn the thread reads back', () => {
    // The turn of the desktop's own record used fifty-seven tools. A limit that counts
    // calls rather than turns dropped the turn itself, and the phone showed the answer
    // with none of the work behind it.
    const pending = useAppStore.getState().requestAsync('op.list_history', { chatId: 'bot:b1' });
    const opId = Object.keys(useAppStore.getState().pendingOp)[0]!;
    const activity = Array.from({ length: 57 }, (_, index) => ({
      turnId: 'task_1',
      callId: `msg_1#t${index}`,
      toolName: 'bash',
      status: 'ok',
    }));
    useAppStore.getState().applyFrame(
      createFrame({
        type: 'ack',
        payload: {
          opId,
          result: {
            messages: [
              { messageId: 'msg_1', chatId: 'bot:b1', role: 'assistant', text: 'Done.', ts: 1, turnId: 'task_1' },
            ],
            activity,
          },
        },
        source: 'relay',
      }),
    );
    void pending;

    const list = useAppStore.getState().activity['bot:b1'] ?? [];
    expect(list).toHaveLength(57);
    expect(list.every((entry) => entry.turnId === 'task_1')).toBe(true);
  });

  it('says when a turn began, so the phone can show how long it runs', () => {
    useAppStore.getState().applyFrame(
      event('evt.turn_started', { chatId: 'bot:b1', turnId: 'task_1', startedAt: 1234 }),
    );

    expect(useAppStore.getState().turnStartedAt['bot:b1']).toBe(1234);
    expect(useAppStore.getState().activeTurn['bot:b1']).toBe('task_1');
  });

  it('forgets the time of a turn when the turn ends', () => {
    useAppStore.getState().applyFrame(
      event('evt.turn_started', { chatId: 'bot:b1', turnId: 'task_1', startedAt: 1234 }),
    );
    useAppStore.getState().applyFrame(
      event('evt.turn_finished', { chatId: 'bot:b1', turnId: 'task_1', status: 'finished' }),
    );

    expect(useAppStore.getState().turnStartedAt['bot:b1']).toBeUndefined();
    expect(useAppStore.getState().activeTurn['bot:b1']).toBeUndefined();
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
