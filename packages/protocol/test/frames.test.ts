import { describe, expect, it } from 'vitest';

import {
  FrameError,
  PROTOCOL_VERSION,
  assertFrame,
  createFrame,
  decodeFrame,
  encodeFrame,
  isEvent,
  isRequest,
  newId,
} from '../src/index.js';

describe('frame envelope', () => {
  it('creates a valid frame with all required fields', () => {
    const frame = createFrame({ type: 'op.list_team', source: 'app', payload: { bots: [] } });

    expect(frame.v).toBe(PROTOCOL_VERSION);
    expect(frame.id).toMatch(/^f_/);
    expect(frame.ts).toBeTypeOf('number');
    expect(frame.source).toBe('app');
    expect(frame.payload).toEqual({ bots: [] });
  });

  it('round-trips through encode/decode', () => {
    const frame = createFrame({ type: 'evt.team_snapshot', source: 'bridge', payload: { bots: [] }, seq: 12 });
    const decoded = decodeFrame(encodeFrame(frame));

    expect(decoded).toEqual(frame);
  });

  it('preserves opId and in_reply_to', () => {
    const frame = createFrame({
      type: 'op.send_message',
      source: 'app',
      payload: {},
      opId: 'op-1',
      in_reply_to: 'f_abc',
    });

    expect(decodeFrame(encodeFrame(frame)).opId).toBe('op-1');
    expect(decodeFrame(encodeFrame(frame)).in_reply_to).toBe('f_abc');
  });

  it('omits optional fields rather than emitting undefined', () => {
    const frame = createFrame({ type: 'op.list_team', source: 'app' });

    expect('seq' in frame).toBe(false);
    expect('opId' in frame).toBe(false);
    expect('in_reply_to' in frame).toBe(false);
  });
});

describe('frame validation', () => {
  const base = { v: 1, id: 'f_1', ts: 1, type: 'op.list_team', source: 'app', payload: {} };

  it('rejects malformed JSON', () => {
    expect(() => decodeFrame('{nope')).toThrow(FrameError);
  });

  it('rejects a non-object', () => {
    expect(() => assertFrame('hello')).toThrow(FrameError);
  });

  it('rejects an unsupported protocol version', () => {
    expect(() => assertFrame({ ...base, v: 99 })).toThrow(/unsupported protocol version/i);
  });

  it('rejects a missing id', () => {
    expect(() => assertFrame({ ...base, id: '' })).toThrow(/frame.id/);
  });

  it('rejects a missing type', () => {
    expect(() => assertFrame({ ...base, type: '' })).toThrow(/frame.type/);
  });

  it('rejects an unknown source role', () => {
    expect(() => assertFrame({ ...base, source: 'nobody' })).toThrow(/frame.source/);
  });

  it('rejects a non-finite timestamp', () => {
    expect(() => assertFrame({ ...base, ts: Number.NaN })).toThrow(/frame.ts/);
  });

  it('rejects a missing payload', () => {
    const { payload, ...withoutPayload } = base;
    expect(payload).toBeDefined();
    expect(() => assertFrame(withoutPayload)).toThrow(/frame.payload/);
  });

  it('rejects a non-integer seq', () => {
    expect(() => assertFrame({ ...base, seq: 1.5 })).toThrow(/frame.seq/);
  });

  it('rejects a non-string opId', () => {
    expect(() => assertFrame({ ...base, opId: 7 })).toThrow(/frame.opId/);
  });
});

describe('frame classification', () => {
  it('classifies requests and events', () => {
    expect(isRequest(createFrame({ type: 'op.list_team', source: 'app' }))).toBe(true);
    expect(isEvent(createFrame({ type: 'evt.team_snapshot', source: 'bridge' }))).toBe(true);
    expect(isRequest(createFrame({ type: 'ack', source: 'bridge' }))).toBe(false);
    expect(isEvent(createFrame({ type: 'ack', source: 'bridge' }))).toBe(false);
  });
});

describe('ids', () => {
  it('never repeats within a burst', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
  });
});
