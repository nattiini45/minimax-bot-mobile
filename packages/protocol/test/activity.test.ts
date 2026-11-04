import { describe, expect, it } from 'vitest';

import { MAX_ACTIVITY_CALLS, trimTurnActivity, turnOrderOf } from '../src/activity.js';

/**
 * The rule both the bridge and the phone keep the calls with.
 *
 * A turn that showed only some of its calls would say that the Bot used fewer tools
 * than it did, so a turn is kept whole — and the whole-turn rule is what keeps the
 * bridge and the phone agreeing about how many tools a turn used.
 */

interface Call {
  turnId: string;
  callId: string;
}

function calls(turnId: string, count: number): Call[] {
  return Array.from({ length: count }, (_, index) => ({ turnId, callId: `${turnId}#t${index}` }));
}

describe('the turns of a thread', () => {
  it('are the turns of its messages, in the order the messages come', () => {
    const order = turnOrderOf([
      { turnId: 'task_a' },
      { turnId: 'task_b' },
      { turnId: 'task_a' },
      {},
      { turnId: 'task_c' },
    ]);
    expect(order).toEqual(['task_a', 'task_b', 'task_c']);
  });

  it('are empty for a thread without turns', () => {
    expect(turnOrderOf([])).toEqual([]);
    expect(turnOrderOf([{}, { turnId: '' }])).toEqual([]);
  });
});

describe('keeping the calls of a conversation', () => {
  it('keeps everything that fits', () => {
    const list = [...calls('t1', 3), ...calls('t2', 4)];
    expect(trimTurnActivity(list, 10, ['t1', 't2'])).toHaveLength(7);
  });

  it('drops whole turns, the oldest first', () => {
    const list = [...calls('t1', 30), ...calls('t2', 30), ...calls('t3', 30)];
    const kept = trimTurnActivity(list, 60, ['t1', 't2', 't3']);
    // The oldest turn goes, and the dropping stops as soon as the rest fits.
    expect(kept.some((entry) => entry.turnId === 't1')).toBe(false);
    expect(kept).toHaveLength(60);
    expect(kept.some((entry) => entry.turnId === 't3')).toBe(true);
  });

  it('never splits a turn', () => {
    const list = [...calls('t1', 50), ...calls('t2', 50)];
    const kept = trimTurnActivity(list, 60, ['t1', 't2']);
    // The first turn does not fit, so it goes whole rather than in part.
    const ofT1 = kept.filter((entry) => entry.turnId === 't1');
    const ofT2 = kept.filter((entry) => entry.turnId === 't2');
    expect(ofT1).toHaveLength(0);
    expect(ofT2).toHaveLength(50);
  });

  it('keeps the newest turn whole even when it alone is larger than the limit', () => {
    // This is the case the desktop's own record produced: one turn used fifty-seven
    // tools, and a limit of forty would have dropped the turn entirely — so the phone
    // showed the answer and none of the work.
    const list = calls('t1', 57);
    const kept = trimTurnActivity(list, 40, ['t1']);
    expect(kept).toHaveLength(57);
  });

  it('keeps a turn that is pinned, whatever the limit says', () => {
    const list = [...calls('t1', 50), ...calls('t2', 50)];
    const kept = trimTurnActivity(list, 60, ['t1', 't2'], (turnId) => turnId === 't1');
    expect(kept.filter((entry) => entry.turnId === 't1')).toHaveLength(50);
  });

  it('orders the turns by the order it is given', () => {
    const list = [...calls('t2', 30), ...calls('t1', 30)];
    // The list arrives in one order and the turns are told in another; the order the
    // caller knows wins, because that is the order the thread shows.
    const kept = trimTurnActivity(list, 30, ['t1', 't2']);
    expect(kept.every((entry) => entry.turnId === 't2')).toBe(true);
  });

  it('keeps a turn it was not told about behind the ones it knows', () => {
    const list = [...calls('known', 30), ...calls('unknown', 30)];
    const kept = trimTurnActivity(list, 30, ['known']);
    expect(kept.every((entry) => entry.turnId === 'unknown')).toBe(true);
  });

  it('leaves a list that fits alone', () => {
    const list = calls('t1', 3);
    expect(trimTurnActivity(list, MAX_ACTIVITY_CALLS, ['t1'])).toEqual(list);
  });
});
