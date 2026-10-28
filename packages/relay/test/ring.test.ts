import { describe, expect, it } from 'vitest';

import { SeqRing } from '../src/ring.js';

describe('SeqRing', () => {
  it('starts empty', () => {
    const ring = new SeqRing(4);
    expect(ring.size).toBe(0);
    expect(ring.lastSeq).toBe(0);
  });

  it('returns entries after the cursor in order', () => {
    const ring = new SeqRing(8);
    ring.push(1, 'a');
    ring.push(2, 'b');
    ring.push(3, 'c');

    const { entries, truncated } = ring.since(1);
    expect(truncated).toBe(false);
    expect(entries.map((entry) => entry.data)).toEqual(['b', 'c']);
  });

  it('returns nothing when the cursor is at the head', () => {
    const ring = new SeqRing(8);
    ring.push(1, 'a');
    expect(ring.since(1).entries).toEqual([]);
  });

  it('evicts the oldest entry when full', () => {
    const ring = new SeqRing(3);
    ring.push(1, 'a');
    ring.push(2, 'b');
    ring.push(3, 'c');
    ring.push(4, 'd');

    expect(ring.size).toBe(3);
    expect(ring.lastSeq).toBe(4);
    expect(ring.since(0).entries.map((entry) => entry.seq)).toEqual([2, 3, 4]);
  });

  it('flags truncation when the client fell behind the buffer', () => {
    const ring = new SeqRing(2);
    ring.push(1, 'a');
    ring.push(2, 'b');
    ring.push(3, 'c');

    // The client wants seq 1, but the buffer only starts at seq 2.
    const { entries, truncated } = ring.since(0);
    expect(truncated).toBe(true);
    expect(entries.map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it('does not flag truncation when the cursor is exactly at the eviction boundary', () => {
    const ring = new SeqRing(2);
    ring.push(1, 'a');
    ring.push(2, 'b');
    ring.push(3, 'c');

    // The client's next expected frame is 2, which the buffer still holds.
    expect(ring.since(1).truncated).toBe(false);
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new SeqRing(0)).toThrow(RangeError);
    expect(() => new SeqRing(-1)).toThrow(RangeError);
  });

  it('exposes the latest entry', () => {
    const ring = new SeqRing(4);
    expect(ring.latest()).toBeUndefined();
    ring.push(1, 'a');
    expect(ring.latest()?.data).toBe('a');
  });
});
