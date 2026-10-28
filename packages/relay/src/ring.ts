/**
 * Bounded event buffer with monotonic sequence numbers.
 *
 * The relay stamps every bridge event with a `seq` and keeps the tail of the stream so a
 * phone that reconnects can resume exactly where it stopped instead of refetching
 * everything. This is the same shape as MiniMax's own Remote Control `last_event_id`
 * replay, with a client-visible buffer instead of a fixed event cache.
 */
export interface RingEntry {
  seq: number;
  data: string;
}

export class SeqRing {
  private readonly entries: RingEntry[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('SeqRing capacity must be a positive integer');
    }
  }

  /** The highest sequence number handed out so far. */
  get lastSeq(): number {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]!.seq : 0;
  }

  /** Number of buffered entries. */
  get size(): number {
    return this.entries.length;
  }

  /** Appends an entry, evicting the oldest when the buffer is full. */
  push(seq: number, data: string): void {
    this.entries.push({ seq, data });
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /**
   * Returns every entry with `seq > afterSeq`, oldest first.
   *
   * `truncated` is true when the requested range had already been evicted, which tells the
   * client its view has a gap and it must resynchronise from a full snapshot.
   */
  since(afterSeq: number): { entries: RingEntry[]; truncated: boolean } {
    if (this.entries.length === 0) {
      return { entries: [], truncated: false };
    }
    const oldest = this.entries[0]!.seq;
    const newest = this.entries[this.entries.length - 1]!.seq;
    // The client's next expected frame is afterSeq + 1; if that is older than the buffer,
    // part of the range is gone.
    let truncated = afterSeq + 1 < oldest;
    // The client is ahead of the relay — its cursor cannot be served. That happens after
    // the relay restarts and its sequence counter resets, and it must be reported as a
    // gap, not as "you are up to date".
    if (afterSeq > newest) {
      truncated = true;
    }
    const entries = this.entries.filter((entry) => entry.seq > afterSeq);
    return { entries, truncated };
  }

  /** The most recent entry, or undefined when empty. */
  latest(): RingEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  clear(): void {
    this.entries.length = 0;
  }
}
