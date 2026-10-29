import { createFrame } from '@minimax-bot/protocol';

import { useAppStore } from '../src/state/store';

/**
 * Answering a permission request from the phone.
 *
 * The approval stays on screen until the desktop says it is resolved, so the phone has
 * to remember that it already answered it. Otherwise the approve control is still
 * there after the tap, and a second tap sends a second answer for the same request -
 * which the desktop refuses, because it claims the request before it tells the Host.
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
    reactions: {},
    tasks: [],
    tasksNote: null,
    helpers: [],
    schedules: [],
    approvals: [],
    decided: {},
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

describe('answering a permission request', () => {
  beforeEach(reset);

  it('remembers the decision, so the approve control can be disabled', () => {
    useAppStore.getState().applyFrame(
      event('evt.permission_requested', {
        request: { requestId: 'req-1', toolName: 'shell', reason: 'writes a file' },
      }),
    );

    useAppStore.getState().respondPermission('req-1', 'allowOnce');

    expect(useAppStore.getState().decided['req-1']).toBe('allowOnce');
  });

  it('does not send a second answer for the same request', () => {
    const sent: unknown[] = [];
    useAppStore.setState({
      request: ((type: string, payload: unknown) => {
        sent.push({ type, payload });
        return 'op-1';
      }) as never,
    });

    useAppStore.getState().respondPermission('req-1', 'allowOnce');
    useAppStore.getState().respondPermission('req-1', 'deny');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'op.respond_permission',
      payload: { requestId: 'req-1', decision: 'allowOnce' },
    });
  });

  it('forgets the decision when the desktop says it is resolved', () => {
    useAppStore.getState().applyFrame(
      event('evt.permission_requested', {
        request: { requestId: 'req-1', toolName: 'shell', reason: 'writes a file' },
      }),
    );
    useAppStore.getState().respondPermission('req-1', 'allowOnce');

    useAppStore.getState().applyFrame(event('evt.permission_resolved', { requestId: 'req-1' }));

    expect(useAppStore.getState().decided['req-1']).toBeUndefined();
    expect(useAppStore.getState().approvals).toHaveLength(0);
  });

  it('does not keep the decisions of approvals that are gone', () => {
    useAppStore.getState().applyFrame(
      event('evt.permission_requested', {
        request: { requestId: 'req-1', toolName: 'shell', reason: 'writes a file' },
      }),
    );
    useAppStore.getState().respondPermission('req-1', 'allowOnce');

    // A different approval arrives and the first one is no longer on screen.
    useAppStore.setState({ approvals: [] });
    useAppStore.getState().applyFrame(
      event('evt.permission_requested', {
        request: { requestId: 'req-2', toolName: 'shell', reason: 'writes a file' },
      }),
    );

    expect(useAppStore.getState().decided['req-1']).toBeUndefined();
  });
});
