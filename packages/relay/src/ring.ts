/**
 * Bounded event buffer with monotonic sequence numbers.
 *
 * The relay stamps every bridge event with a `seq` and keeps the tail of the stream so a
 * phone that reconnects can resume exactly where it stopped instead of refetching
 * everything. This is the same shape as MiniMax's own Remote Control `last_event_id`
 * replay, with a client-visible buffer instead of a fixed event cache.
 */

/** How many entries the buffer keeps when nothing else is said. */
export const DEFAULT_RING_CAPACITY = 512;

/**
 * How many bytes the buffer keeps when nothing else is said.
 *
 * The entry count alone does not bound the memory: one entry holds a frame of whatever
 * length the sender produced, so a buffer of five hundred entries can be five hundred
 * large frames. The byte bound is what makes the buffer's memory a known quantity.
 */
export const DEFAULT_RING_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The number of bytes a string takes when it is sent.
 *
 * A string's length counts UTF-16 code units, which is fewer than the bytes it becomes
 * on the wire for anything outside ASCII, so the length alone would let a frame past a
 * byte cap.
 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface RingEntry {
  seq: number;
  data: string;
}

export class SeqRing {
  private readonly entries: RingEntry[] = [];
  /** The bytes the buffered entries take up. */
  private bytes = 0;

  constructor(
    private readonly capacity: number,
    private readonly maxBytes: number = DEFAULT_RING_MAX_BYTES,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('SeqRing capacity must be a positive integer');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError('SeqRing byte limit must be a positive integer');
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

  /** The bytes the buffered entries take up. */
  get byteSize(): number {
    return this.bytes;
  }

  /**
   * Appends an entry, evicting the oldest when the buffer is full.
   *
   * The oldest entry goes when the buffer is over its entry count or over its byte
   * count, whichever happens first.
   */
  push(seq: number, data: string): void {
    const size = byteLength(data);
    this.entries.push({ seq, data });
    this.bytes += size;
    while (this.entries.length > this.capacity || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      const evicted = this.entries.shift();
      if (!evicted) break;
      this.bytes -= byteLength(evicted.data);
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
    this.bytes = 0;
  }
}
