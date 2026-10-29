import { describe, expect, it } from 'vitest';

import { SeqRing } from '../src/ring.js';

/**
 * The replay buffer.
 *
 * It holds frames so that a phone that reconnects can resume where it stopped. The
 * entry count says how many frames it holds; it says nothing about how much memory
 * those frames take, because a frame is whatever the sender produced.
 */

describe('the replay buffer', () => {
  it('keeps at most its entry count', () => {
    const ring = new SeqRing(3);
    ring.push(1, 'a');
    ring.push(2, 'b');
    ring.push(3, 'c');
    ring.push(4, 'd');

    expect(ring.size).toBe(3);
    expect(ring.since(0).entries.map((entry) => entry.data)).toEqual(['b', 'c', 'd']);
  });

  it('keeps at most its byte count', () => {
    // Four entries of ten bytes each, and a limit of twenty five bytes.
    const ring = new SeqRing(100, 25);
    ring.push(1, 'x'.repeat(10));
    ring.push(2, 'x'.repeat(10));
    ring.push(3, 'x'.repeat(10));

    // The oldest went, because three entries of ten bytes are over the limit.
    expect(ring.byteSize).toBeLessThanOrEqual(25);
    expect(ring.size).toBe(2);
    expect(ring.since(0).entries.map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it('counts the bytes a frame really takes, not the characters in it', () => {
    const ring = new SeqRing(100, 40);
    // Ten characters, but thirty bytes: these are not ASCII.
    ring.push(1, '\u4f60\u597d\u4e16\u754c\u4f60\u597d\u4e16\u754c\u4f60\u597d');

    expect(ring.byteSize).toBe(30);
    expect(ring.size).toBe(1);
  });

  it('keeps the newest frame even when it is on its own over the limit', () => {
    const ring = new SeqRing(100, 10);
    ring.push(1, 'x'.repeat(50));

    // The buffer would be empty otherwise, and a buffer with no last frame cannot say
    // what the newest sequence number was.
    expect(ring.size).toBe(1);
    expect(ring.latest()?.seq).toBe(1);
  });

  it('forgets the bytes it has evicted', () => {
    const ring = new SeqRing(2);
    ring.push(1, 'x'.repeat(100));
    ring.push(2, 'y'.repeat(100));
    expect(ring.byteSize).toBe(200);

    // The oldest entry went, and its bytes with it.
    ring.push(3, 'z'.repeat(100));
    expect(ring.byteSize).toBe(200);
    expect(ring.size).toBe(2);

    ring.clear();
    expect(ring.byteSize).toBe(0);
  });
});
