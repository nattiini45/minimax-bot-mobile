/**
 * The protocol's runtime values.
 *
 * The client imports values — not just types — from `@minimax-bot/protocol`, and the
 * package is consumed as its built `dist`. A build that bundles a stale `dist` gives
 * the app a module where those values are `undefined`, and the failure is a crash on
 * launch with nothing in the build log to explain it. This test reads the values the
 * app actually uses, so a stale protocol build fails here instead of on a phone.
 */
import { CLOSE_CODE, PROTOCOL_VERSION, createFrame, newId } from '@minimax-bot/protocol';

describe('the protocol the client bundles', () => {
  it('carries its version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('carries the close codes the relay uses', () => {
    expect(CLOSE_CODE).toBeDefined();
    expect(CLOSE_CODE.unauthorized).toBe(4001);
    expect(CLOSE_CODE.replaced).toBe(4000);
    expect(CLOSE_CODE.deviceRevoked).toBe(4003);
  });

  it('carries the frame helpers', () => {
    const frame = createFrame({
      type: 'evt.message_chunk',
      source: 'app',
      payload: { text: 'hello' },
    });
    expect(frame.v).toBe(PROTOCOL_VERSION);
    expect(frame.type).toBe('evt.message_chunk');
    expect(frame.source).toBe('app');
    expect(typeof frame.id).toBe('string');
    expect(typeof newId('t')).toBe('string');
  });
});
