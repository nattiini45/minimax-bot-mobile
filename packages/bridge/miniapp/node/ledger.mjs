/**
 * Usage and execution ledger.
 *
 * The MiniMax Bot Mini App serves usage from its own store, which a bridge cannot read.
 * The receipts the team tools return do carry token usage, so the bridge reconstructs the
 * same numbers from the calls it makes and the turns it runs.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writePrivateFile } from './private-file.mjs';

const LEDGER_FILE = 'ledger.json';
const MAX_ENTRIES = 5000;
/** How many dispatched batches are remembered for the task list. */
const MAX_BATCHES = 50;

export class Ledger {
  constructor(dataDir, { maxEntries = MAX_ENTRIES } = {}) {
    this.dataDir = dataDir;
    this.maxEntries = maxEntries;
    /** @type {Array<object>} */
    this.entries = [];
    /**
     * The batches the bridge has dispatched.
     *
     * The team's task tool answers for one batch at a time and has no "list
     * everything" call, so the batch ids are what make a task list possible at all.
     * They are kept across restarts for the same reason.
     *
     * @type {string[]}
     */
    this.batchIds = [];
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(join(this.dataDir, LEDGER_FILE), 'utf8'));
      if (Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.slice(-this.maxEntries);
      }
      if (Array.isArray(parsed.batchIds)) {
        this.batchIds = parsed.batchIds.slice(-MAX_BATCHES);
      }
    } catch {
      this.entries = [];
      this.batchIds = [];
    }
    return this;
  }

  async persist() {
    await mkdir(this.dataDir, { recursive: true });
    // The ledger holds the conversation, so it is written for its owner only.
    await writePrivateFile(
      join(this.dataDir, LEDGER_FILE),
      `${JSON.stringify({ entries: this.entries, batchIds: this.batchIds }, null, 2)}\n`,
    );
  }

  /** Remembers a dispatched batch, so its tasks can be read back later. */
  rememberBatch(batchId) {
    if (!batchId || this.batchIds.includes(batchId)) return;
    this.batchIds.push(batchId);
    if (this.batchIds.length > MAX_BATCHES) {
      this.batchIds = this.batchIds.slice(-MAX_BATCHES);
    }
  }

  /** The remembered batch ids, oldest first. */
  batches() {
    return [...this.batchIds];
  }

  /** Records a completed turn. */
  recordTurn({ botId, botName, chars = 0, durationMs = 0, error = false }) {
    this.push({
      ts: Date.now(),
      kind: 'turn',
      botId,
      botName,
      chars,
      durationMs,
      error,
    });
  }

  /** Records a completed tool call. */
  recordTool({ botId, toolName, ok = true, durationMs = 0, tokens = 0, error = false }) {
    this.push({
      ts: Date.now(),
      kind: 'tool',
      botId,
      toolName,
      ok,
      tokens,
      durationMs,
      error,
    });
  }

  push(entry) {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  /**
   * Builds a usage report.
   *
   * A span of one day or less is bucketed by hour, anything longer by day, matching how
   * the MiniMax Bot usage panel reads.
   */
  report({ days = 7, botNames = {} } = {}) {
    const hourly = days <= 1;
    // Hourly mode always spans a full day; day mode spans the requested window.
    const span = hourly ? 24 : Math.max(1, Math.min(90, days));
    const now = new Date();
    const start = new Date(now);
    if (hourly) {
      start.setMinutes(0, 0, 0);
      start.setHours(start.getHours() - 23);
    } else {
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (span - 1));
    }
    const startMs = start.getTime();

    const buckets = new Map();
    for (let i = 0; i < span; i += 1) {
      const cursor = new Date(start);
      if (hourly) cursor.setHours(start.getHours() + i);
      else cursor.setDate(start.getDate() + i);
      const key = bucketKey(cursor, hourly);
      buckets.set(key, {
        key,
        label: hourly ? `${String(cursor.getHours()).padStart(2, '0')}:00` : `${cursor.getMonth() + 1}/${cursor.getDate()}`,
        turns: 0,
        chars: 0,
        tools: 0,
        durationMs: 0,
        errors: 0,
      });
    }

    const byBot = new Map();
    const totals = { turns: 0, chars: 0, tools: 0, durationMs: 0, errors: 0 };

    for (const entry of this.entries) {
      if (entry.ts < startMs) continue;
      const bucket = buckets.get(bucketKey(new Date(entry.ts), hourly));
      if (!bucket) continue;

      const botId = entry.botId ?? 'unknown';
      const bot = byBot.get(botId) ?? {
        botId,
        name: entry.botName ?? botNames[botId] ?? botId,
        turns: 0,
        chars: 0,
        tools: 0,
      };

      if (entry.kind === 'turn') {
        bucket.turns += 1;
        bucket.chars += entry.chars ?? 0;
        bucket.durationMs += entry.durationMs ?? 0;
        totals.turns += 1;
        totals.chars += entry.chars ?? 0;
        totals.durationMs += entry.durationMs ?? 0;
        bot.turns += 1;
        bot.chars += entry.chars ?? 0;
      } else {
        bucket.tools += 1;
        totals.tools += 1;
        bot.tools += 1;
      }

      if (entry.error) {
        bucket.errors += 1;
        totals.errors += 1;
      }

      byBot.set(botId, bot);
    }

    return {
      buckets: [...buckets.values()],
      byBot: [...byBot.values()].sort((a, b) => b.turns - a.turns),
      totals,
    };
  }

  /** The most recent calls, newest first. Drives the execution-records view. */
  recent(limit = 50) {
    return this.entries.slice(-limit).reverse();
  }
}

function bucketKey(date, hourly) {
  const pad = (value) => String(value).padStart(2, '0');
  if (hourly) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
