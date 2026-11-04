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
  // Restore actions too: a request capture from the previous test is not the store.
  useAppStore.setState(useAppStore.getInitialState(), true);
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
        return `op-${sent.length}`;
      }) as never,
    });

    useAppStore.getState().applyFrame(
      createFrame({
        type: 'evt.permission_requested',
        payload: { request: { requestId: 'req-1', chatId: 'bot:b1', reason: 'write a file' } },
        source: 'bridge',
      }),
    );
    useAppStore.getState().respondPermission('req-1', 'allowOnce');
    useAppStore.getState().respondPermission('req-1', 'deny');

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'op.respond_permission',
      payload: { requestId: 'req-1', decision: 'allowOnce' },
    });
    expect(useAppStore.getState().decided['req-1']).toBe('allowOnce');
    expect(useAppStore.getState().decidedOps['req-1']).toBe('op-1');
    expect(useAppStore.getState().approvals.map(request => request.requestId)).toEqual(['req-1']);
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

  it('gives the decision back when the desktop refuses it', () => {
    const sent: unknown[] = [];
    useAppStore.setState({
      request: ((type: string, payload: unknown) => {
        sent.push({ type, payload });
        return `op-${sent.length}`;
      }) as never,
    });

    useAppStore.getState().applyFrame(
      event('evt.permission_requested', {
        request: { requestId: 'req-1', toolName: 'shell', reason: 'writes a file' },
      }),
    );
    useAppStore.getState().respondPermission('req-1', 'allowOnce');
    expect(useAppStore.getState().decided['req-1']).toBe('allowOnce');

    // The desktop refused the answer. The request is still waiting for one, so the
    // phone has to be able to give it again.
    useAppStore.getState().applyFrame(
      event('err', { opId: 'op-1', code: 'BUSY', message: 'Too many turns are already running.' }),
    );

    expect(useAppStore.getState().decided['req-1']).toBeUndefined();
    expect(useAppStore.getState().decidedOps['req-1']).toBeUndefined();
    expect(useAppStore.getState().approvals.map(request => request.requestId)).toEqual(['req-1']);
    expect(useAppStore.getState().lastError).toBe('Too many turns are already running.');

    // A fresh retry is allowed, but another tap while it is pending is not.
    useAppStore.getState().respondPermission('req-1', 'allowOnce');
    useAppStore.getState().respondPermission('req-1', 'deny');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ type: 'op.respond_permission', payload: { requestId: 'req-1', decision: 'allowOnce' } });
    expect(useAppStore.getState().decidedOps['req-1']).toBe('op-2');
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
