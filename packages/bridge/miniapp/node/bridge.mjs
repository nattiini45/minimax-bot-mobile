/**
 * The bridge.
 *
 * Owns the team connection, runs Bot turns, answers every operation the client can ask
 * for, and publishes the result as events. The desktop is the single writer of chat
 * state; the phone is a projection of it.
 */

import { AgentRunner, authorIdFor } from './agent.mjs';
import { Ledger } from './ledger.mjs';
import { PendingSet } from './pending.mjs';
import { RelayClient } from './relay-client.mjs';
import { OP_TOOL, ToolGateway } from './tools.mjs';
import { createFrame, isValidClientMessageId, newId } from './protocol/index.js';

const OP_DEDUPE_TTL_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 200;

/**
 * Maps one Bot from the team tool's shape to the protocol's shape.
 *
 * The team tool reports `bot_id` and `main`; the protocol the phone speaks uses
 * `botId` and `isMain`. The tool also reports the model as `provider/model`, which
 * is kept as it is: a phone that shows "custom_provider:ollama-cloud/muse-spark-open"
 * is telling the truth about which model the Bot runs on.
 *
 * @param {any} bot
 * @returns {{botId: string, name: string, role?: string, model?: string, isMain: boolean}}
 */
function mapBot(bot) {
  return {
    botId: String(bot?.bot_id ?? bot?.botId ?? ''),
    name: String(bot?.name ?? ''),
    role: bot?.role ? String(bot.role) : undefined,
    model: bot?.model ? String(bot.model) : undefined,
    isMain: bot?.main === true || bot?.isMain === true,
  };
}

/**
 * Maps one group from the team tool's shape to the protocol's shape.
 *
 * The tool reports the group's members and its admin by *name*, while the protocol
 * carries ids, so the names are resolved against the roster. A name that is not in
 * the roster is kept as it is rather than dropped, so a member is never lost.
 *
 * @param {any} group
 * @param {Map<string, string>} idByName Bot name to bot id.
 */
function mapGroup(group, idByName) {
  const members = Array.isArray(group?.members)
    ? group.members
    : Array.isArray(group?.memberIds)
      ? group.memberIds
      : [];
  const adminName = group?.admin ? String(group.admin) : '';
  return {
    groupId: String(group?.group_id ?? group?.groupId ?? ''),
    name: String(group?.name ?? ''),
    notice: group?.notice ? String(group.notice) : undefined,
    admin: idByName.get(adminName) ?? adminName,
    memberIds: members.map((member) => idByName.get(String(member)) ?? String(member)),
    replyMode: group?.reply_mode === 'all' || group?.replyMode === 'all' ? 'all' : 'admin',
  };
}

/**
 * The task list, in the protocol's shape.
 *
 * The team tool answers in snake_case (`task_id`, `bot_id`, `created_at`) and calls
 * the task's status `status`; the phone reads camelCase and calls it `state`. The
 * renaming happens here rather than in the tool's own vocabulary.
 *
 * @param {any} data
 */
function normaliseTasks(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.tasks)) return data;
  const batchId = data.batch_id ?? data.batchId;
  const requestId = data.request_id ?? data.requestId;
  return {
    ...data,
    ...(batchId ? { batchId } : {}),
    ...(requestId ? { requestId } : {}),
    tasks: data.tasks.map((task) => {
      if (!task || typeof task !== 'object') return task;
      const {
        task_id: taskId,
        bot_id: botId,
        status,
        created_at: createdAt,
        started_at: startedAt,
        ended_at: endedAt,
        result_message_id: resultMessageId,
        chat_id: chatId,
        ...rest
      } = task;
      const state = status ?? rest.state;
      return {
        ...rest,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(state !== undefined ? { state } : {}),
        ...(botId ? { botIds: [botId] } : {}),
        ...(createdAt !== undefined ? { createdAt } : {}),
        updatedAt: endedAt ?? startedAt ?? createdAt ?? 0,
        ...(resultMessageId ? { resultMessageId } : {}),
        ...(chatId ? { chatId } : {}),
      };
    }),
  };
}

/**
 * The helper list, in the protocol's shape.
 *
 * The team tool answers with a bare array of helpers, each with a `helper_id`, a
 * `status` and a duration in seconds. The phone reads an object with a `helpers`
 * list, so the array is wrapped and the fields are renamed.
 *
 * @param {any} data
 */
function normaliseHelpers(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.helpers)
      ? data.helpers
      : [];
  const rest = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    ...rest,
    helpers: list.map((helper) => {
      if (!helper || typeof helper !== 'object') return helper;
      const { helper_id: helperId, status, seconds, report, error, ...fields } = helper;
      return {
        ...fields,
        ...(helperId !== undefined ? { helperId } : {}),
        ...(status ? { state: status } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(report ?? error ? { detail: report ?? error } : {}),
      };
    }),
  };
}

/**
 * The schedule list, in the protocol's shape.
 *
 * The team tool answers with a bare array of schedules. Its `next_run` and
 * `last_run` are ISO timestamps and the trigger is either a `time` or an
 * `every_minutes`, while the protocol carries epoch milliseconds and one `spec`.
 *
 * @param {any} data
 */
function normaliseSchedules(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.schedules)
      ? data.schedules
      : [];
  const rest = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  return {
    ...rest,
    schedules: list.map((schedule) => {
      if (!schedule || typeof schedule !== 'object') return schedule;
      const {
        schedule_id: scheduleId,
        bot_id: botId,
        time,
        every_minutes: everyMinutes,
        next_run: nextRun,
        last_run: lastRun,
        ...fields
      } = schedule;
      const spec = time ?? (everyMinutes === undefined ? undefined : String(everyMinutes));
      return {
        ...fields,
        ...(scheduleId !== undefined ? { scheduleId } : {}),
        ...(botId ? { targetBotId: botId } : {}),
        ...(spec !== undefined ? { spec } : {}),
        ...(nextRun ? { nextRunAt: toEpoch(nextRun) } : {}),
        ...(lastRun ? { lastRunAt: toEpoch(lastRun) } : {}),
      };
    }),
  };
}

/**
 * Normalises a tool's answer into the protocol's shape.
 *
 * Each tool answers in its own way: the task tools answer with an object, the
 * helper and schedule tools with a bare array. The phone only ever sees one shape.
 *
 * @param {string} toolName
 * @param {any} data
 */
function normaliseResult(toolName, data) {
  switch (toolName) {
    case 'dispatch_tasks':
    case 'get_tasks':
    case 'cancel_tasks':
      return normaliseTasks(data);
    case 'list_helpers':
      return normaliseHelpers(data);
    case 'list_schedules':
      return normaliseSchedules(data);
    default:
      return data;
  }
}

/**
 * An ISO timestamp as epoch milliseconds, or the value itself when it already is one.
 *
 * @param {unknown} value
 */
function toEpoch(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * A topic key for a memory the client did not file under one.
 *
 * The team's memory tool insists on a topic: a memory is either filed under a topic
 * or replaces an existing entry. The key has to match the tool's own pattern — a
 * lowercase word, then lowercase letters, digits, dots, dashes and underscores — and
 * it has to be unique, because writing the same topic twice without the entry's
 * revision is a conflict.
 */
function generateTopicKey() {
  return `phone.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
}

/** How many batches the bridge asks about when it rebuilds the task list. */
const MAX_BATCHES = 20;

/** How often the team snapshot is retried while the Host prepares the generation. */
const SNAPSHOT_RETRIES = 12;
/** The gap between two snapshot attempts. */
const SNAPSHOT_RETRY_MS = 1500;

export class Bridge {
  /**
   * @param {any} context The Mini App context the Host supplies.
   * @param {{config?: import('./config.mjs').BridgeConfig, logger?: import('./relay-client.mjs').RelayLogger}} [options]
   */
  constructor(context, { config, logger } = {}) {
    this.context = context;
    this.config = config;
    this.logger = logger ?? context.logger;
    this.ledger = new Ledger(context.dataDir);
    this.tools = new ToolGateway(context);
    this.pending = new PendingSet();
    this.runner = new AgentRunner(context, {
      pending: this.pending,
      onEvent: (type, payload) => this.emit(type, payload),
      onTurnFinished: (info) => this.onTurnFinished(info),
    });
    this.relay = new RelayClient({
      url: config?.relayUrl,
      accountId: config?.accountId,
      bridgeId: config?.bridgeId,
      token: config?.bridgeToken,
      name: config?.bridgeName,
      logger: this.logger,
      onFrame: (frame) => {
        this.handleFrame(frame).catch((error) => {
          this.logger.error(`frame handling failed: ${error instanceof Error ? error.message : error}`);
        });
      },
      onStatus: (online) => {
        this.emit('evt.bridge_status', {
          desktopOnline: true,
          agentAvailable: this.runner.available,
          teamToolsAvailable: this.tools.available,
          linkedAt: this.linkedAt,
          // The live catalogue travels with the status, so a client can show which
          // team tools this desktop can reach without a second round trip.
          tools: this.tools.catalog,
        });
        if (online) this.replayPending();
      },
    });

    /** @type {Map<string, Array<object>>} chatId -> messages */
    this.history = new Map();
    /** @type {Map<string, Map<string, number>>} messageId -> emoji -> count */
    this.reactions = new Map();
    /** @type {Map<string, {promise: Promise<{ok: boolean, value?: unknown, error?: unknown}>, expiresAt: number}>} */
    this.opCache = new Map();
    /** @type {string | undefined} */
    this.snapshotError = undefined;
    /** @type {number} */
    this.snapshotAttempts = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.snapshotTimer = undefined;
    this.linkedAt = Date.now();
  }

  async start() {
    await this.ledger.init();
    await this.tools.refresh();
    this.relay.start();
    this.logger.info('bridge started', {
      bridgeId: this.config?.bridgeId,
      teamTools: this.tools.catalog.length,
      agent: this.runner.available,
    });
  }

  stop() {
    this.relay.stop();
  }

  // -- outbound ------------------------------------------------------------

  emit(type, payload) {
    this.relay.send(createFrame({ type, payload, source: 'bridge' }));
  }

  /**
   * Re-emits held approvals and questions so a resuming phone sees them.
   *
   * The team snapshot goes out with it: a phone that (re)connects has no roster of its
   * own, and this is the one event that carries the whole team.
   */
  replayPending() {
    for (const item of this.pending.list()) {
      if (item.kind === 'permission') {
        this.emit('evt.permission_requested', { request: item.request });
      } else {
        this.emit('evt.question_requested', { request: item.request });
      }
    }
    this.emit('evt.bridge_status', {
      desktopOnline: true,
      agentAvailable: this.runner.available,
      teamToolsAvailable: this.tools.available,
      linkedAt: this.linkedAt,
      tools: this.tools.catalog,
    });
    void this.publishTeamSnapshot();
  }

  /** Publishes the current team roster to the phones. */
  async publishTeamSnapshot() {
    try {
      const team = await this.readTeam();
      this.snapshotError = undefined;
      this.snapshotAttempts = 0;
      this.emit('evt.team_snapshot', {
        ...team,
        diagnostics: this.diagnostics(),
        tools: this.tools.catalog,
      });
      return true;
    } catch (error) {
      // The reason travels with the diagnostics, so the phone can say what is wrong
      // instead of showing an empty team with no explanation.
      this.snapshotError = error instanceof Error ? error.message : String(error);
      this.logger.warn('team snapshot failed', { message: this.snapshotError });
      this.emit('evt.bridge_status', {
        desktopOnline: true,
        agentAvailable: this.runner.available,
        teamToolsAvailable: this.tools.available,
        linkedAt: this.linkedAt,
        tools: this.tools.catalog,
        diagnostics: this.diagnostics(),
      });
      this.scheduleSnapshotRetry();
      return false;
    }
  }

  /**
   * Retries the team snapshot while the Host is still preparing this generation.
   *
   * The Host activates a Mini App's MCP server and binds its tools to the current
   * generation; until that has happened a tool call is refused as unavailable. The
   * bridge therefore keeps trying for a short while instead of leaving the phone
   * with an empty team.
   */
  scheduleSnapshotRetry() {
    this.snapshotAttempts += 1;
    if (this.snapshotAttempts > SNAPSHOT_RETRIES) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      void this.publishTeamSnapshot();
    }, SNAPSHOT_RETRY_MS);
    this.snapshotTimer.unref?.();
  }

  // -- inbound -------------------------------------------------------------

  async handleFrame(frame) {
    if (!frame || typeof frame.type !== 'string') return;
    if (!frame.type.startsWith('op.')) return;

    const opId = frame.opId ?? frame.id;
    // The cache key includes the operation type: two different operations must never
    // share a result, even if they arrive with the same opId.
    const cacheKey = `${frame.type}:${opId}`;

    const cached = this.opCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      // The in-flight promise is shared, so a duplicate that arrives while the first
      // call is still running waits for it instead of running the operation twice.
      const outcome = await cached.promise;
      if (outcome.ok) {
        this.reply(frame, outcome.value);
      } else {
        this.replyError(frame, outcome.error);
      }
      return;
    }

    // Claim the slot before awaiting, so a concurrent duplicate cannot slip past.
    /** @type {Promise<{ok: boolean, value?: unknown, error?: unknown}>} */
    const promise = this.dispatch(frame.type, frame.payload ?? {}).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    this.opCache.set(cacheKey, { promise, expiresAt: Date.now() + OP_DEDUPE_TTL_MS });
    this.pruneCache();

    const outcome = await promise;
    if (outcome.ok) {
      this.reply(frame, outcome.value);
    } else {
      this.replyError(frame, outcome.error);
    }
  }

  reply(frame, result) {
    this.relay.send(
      createFrame({
        type: 'ack',
        payload: { opId: frame.opId ?? frame.id, result },
        source: 'bridge',
        in_reply_to: frame.id,
      }),
    );
  }

  replyError(frame, error) {
    const code = typeof error?.code === 'string' ? error.code : 'INTERNAL';
    const retryable = code === 'BUSY' || code === 'AGENT_UNAVAILABLE' || code === 'TOOL_NOT_AVAILABLE';
    this.relay.send(
      createFrame({
        type: 'err',
        payload: {
          opId: frame.opId ?? frame.id,
          code,
          message: error instanceof Error ? error.message : String(error),
          retryable,
          // `INVALID_ARGUMENTS` carries the tool's live schema and the properties that
          // are missing, so the client can ask for the exact field instead of guessing.
          ...(error && error.details ? { details: error.details } : {}),
        },
        source: 'bridge',
        in_reply_to: frame.id,
      }),
    );
  }

  pruneCache() {
    const now = Date.now();
    for (const [key, entry] of this.opCache) {
      if (entry.expiresAt <= now) this.opCache.delete(key);
    }
  }

  // -- dispatch ------------------------------------------------------------

  async dispatch(type, payload) {
    switch (type) {
      case 'op.send_message':
        return this.sendMessage(payload);
      case 'op.abort_turn':
        return { aborted: this.runner.abort(payload.turnId) };
      case 'op.respond_permission':
        await this.runner.reply(payload.requestId, payload.decision);
        return { requestId: payload.requestId, decision: payload.decision };
      case 'op.answer_question':
        await this.runner.answer(payload.requestId, payload.answers ?? []);
        return { requestId: payload.requestId };
      case 'op.list_history':
        return { messages: this.history.get(payload.chatId) ?? [] };
      case 'op.get_usage':
        return this.ledger.report({ days: payload.days ?? 7 });
      case 'op.react':
        return this.react(payload);
      case 'op.list_team': {
        await this.tools.refresh();
        const team = await this.readTeam();
        return { ...team, diagnostics: this.diagnostics() };
      }
      case 'op.list_tasks': {
        // The team's task tool answers for one batch or one task at a time — there is
        // no "list everything" call. A client that names one gets that one; a client
        // that names neither gets every batch the bridge has seen.
        if (payload.taskId || payload.batchId) return this.callTool('get_tasks', payload);
        return this.listKnownTasks();
      }
      case 'op.remember': {
        // A memory is filed under a topic or replaces an entry; the team refuses one
        // with neither. A note the phone asks to remember gets its own topic.
        const request = { ...payload };
        if (!request.key && !request.replaceId) request.key = generateTopicKey();
        const result = await this.callTool('remember', request);
        return { ...result, key: request.key ?? result.key };
      }
      default: {
        const toolName = OP_TOOL[type];
        if (!toolName) {
          throw codedError('UNKNOWN_OP', `No handler for ${type}`);
        }
        const result = await this.callTool(toolName, payload);
        await this.publishMutation(type, result);
        return result;
      }
    }
  }

  /**
   * Publishes the event that carries a mutation's result to the phones.
   *
   * The phone never polls for these: it renders what the bridge tells it. A mutation
   * that is not published leaves the phone's list stale until the next full refresh.
   */
  async publishMutation(type, result) {
    const data = result?.data && typeof result.data === 'object' ? result.data : {};
    switch (type) {
      case 'op.create_bot':
      case 'op.update_bot':
      case 'op.delete_bot':
      case 'op.create_group':
      case 'op.update_group':
      case 'op.delete_group':
        await this.publishTeamSnapshot();
        return;
      case 'op.dispatch':
      case 'op.cancel_task':
        this.emit('evt.task_updated', { task: data.task ?? data });
        return;
      case 'op.start_helper':
      case 'op.stop_helper':
        this.emit('evt.helper_updated', { helper: data.helper ?? data });
        return;
      case 'op.create_schedule':
      case 'op.delete_schedule':
        this.emit('evt.schedule_updated', { schedule: data.schedule ?? data });
        return;
      default:
        return;
    }
  }

  /**
   * Calls a team tool and normalises the result.
   *
   * The tool envelope differs per tool, so the raw result is returned alongside a best
   * effort structured view; the client renders the structured view and falls back to the
   * raw content when it cannot. The tool's own fields are also spread at the top level,
   * so the protocol's declared result shapes (`entries`, `tasks`, `bots`, …) are present
   * exactly where the client reads them.
   */
  async callTool(toolName, payload) {
    const startedAt = Date.now();
    const result = await this.tools.call(toolName, payload);
    this.ledger.recordTool({
      botId: payload.botId ?? payload.targetBotId ?? 'unknown',
      toolName,
      ok: result.ok === true && result.isError !== true,
      durationMs: Date.now() - startedAt,
      tokens: extractTokens(result),
      error: result.ok === true && result.isError !== true ? undefined : true,
    });

    if (!result.ok) {
      throw codedError(
        result.code ?? 'TOOL_FAILED',
        result.message ?? `The ${toolName} tool did not complete.`,
        false,
        result.details,
      );
    }
    if (result.isError === true) {
      // The tool ran and failed; its own wording is kept, because that is what tells
      // the user what went wrong.
      throw codedError(
        'TOOL_REPORTED_ERROR',
        result.message ?? `The ${toolName} tool reported an error.`,
        false,
        { tool: toolName },
      );
    }

    const data = extractData(result);
    const normalised = normaliseResult(toolName, data);
    // A batch the team reported is remembered, so the task list can be rebuilt later.
    const batchId = normalised?.batchId ?? normalised?.batch_id;
    if (batchId) this.ledger.rememberBatch(String(batchId));

    await this.ledger.persist();

    return {
      tool: toolName,
      content: result.content,
      structuredContent: result.structuredContent,
      data: normalised,
      ...(normalised && typeof normalised === 'object' && !Array.isArray(normalised) ? normalised : {}),
    };
  }

  /**
   * Rebuilds the task list from the batches the bridge knows.
   *
   * The team's task tool answers for one batch at a time, so a list is assembled by
   * asking about each batch in turn. The list is therefore never complete: a task
   * the team dispatched without the bridge is invisible to the phone, and the answer
   * says so.
   */
  async listKnownTasks() {
    const batches = this.ledger.batches();
    if (batches.length === 0) {
      return {
        tasks: [],
        batchIds: [],
        partial: true,
        note: 'The team tool answers for one batch at a time, so the list only covers the work the bridge dispatched.',
      };
    }

    /** @type {any[]} */
    const tasks = [];
    const seen = new Set();
    for (const batchId of batches.slice(-MAX_BATCHES)) {
      try {
        const result = await this.callTool('get_tasks', { batchId });
        for (const task of result.tasks ?? []) {
          const id = task?.taskId ?? task?.task_id;
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          tasks.push(task);
        }
      } catch (error) {
        // One batch the team no longer knows must not hide the others.
        this.logger.warn('batch query failed', {
          batchId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      tasks,
      batchIds: batches,
      partial: true,
      note: 'The team tool answers for one batch at a time, so the list only covers the work the bridge dispatched.',
    };
  }

  /**
   * Reads the team roster, preferring the tool's structured output.
   *
   * The team tool reports the roster in its own shape; the mapping into the
   * protocol's shape happens here, so the phone only ever sees one shape.
   */
  async readTeam() {    const result = await this.tools.call('list_team', {});
    const data = extractData(result) ?? {};
    const bots = Array.isArray(data.bots) ? data.bots.map(mapBot) : [];
    const idByName = new Map(bots.map((bot) => [bot.name, bot.botId]));
    const groups = Array.isArray(data.groups) ? data.groups.map((group) => mapGroup(group, idByName)) : [];
    return { bots, groups };
  }

  diagnostics() {
    return {
      agentAvailable: this.runner.available,
      teamToolsAvailable: this.tools.available,
      toolCount: this.tools.catalog.length,
      partial: this.tools.partial,
      linkedAt: this.linkedAt,
      reason: this.snapshotError ?? this.tools.reason,
    };
  }

  async sendMessage(payload) {
    const { chatId, text, mentions } = payload;
    if (!chatId || !text) {
      throw codedError('INVALID_ARGUMENTS', 'chatId and text are required.');
    }

    // The client may choose the id so its optimistic bubble can be replaced in place
    // when this message is committed. An id the client may not choose is ignored.
    const messageId = isValidClientMessageId(payload.clientMessageId)
      ? payload.clientMessageId
      : `msg_${newId('u')}`;
    const userMessage = {
      messageId,
      chatId,
      role: 'user',
      text,
      ts: Date.now(),
      pending: false,
    };
    this.pushHistory(chatId, userMessage);
    this.emit('evt.message_committed', { message: userMessage });

    const prompt = mentions?.length ? `${mentions.map((id) => `@${id}`).join(' ')}\n${text}` : text;

    const result = await this.runner.run({ chatId, text: prompt, mentions });

    return {
      messageId: userMessage.messageId,
      turnId: result?.turnId,
      sessionId: result?.sessionId ?? this.runner.sessionFor(chatId),
    };
  }

  react(payload) {
    const { messageId, emoji } = payload;
    if (!messageId || !emoji) {
      throw codedError('INVALID_ARGUMENTS', 'messageId and emoji are required.');
    }
    const bucket = this.reactions.get(messageId) ?? new Map();
    bucket.set(emoji, (bucket.get(emoji) ?? 0) + 1);
    this.reactions.set(messageId, bucket);
    const reaction = { messageId, emoji };
    this.emit('evt.reaction_added', { reaction });
    return { reaction };
  }

  pushHistory(chatId, message) {
    const list = this.history.get(chatId) ?? [];
    list.push(message);
    if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
    this.history.set(chatId, list);
  }

  onTurnFinished({ chatId, durationMs, result }) {
    const author = authorIdFor(chatId);
    this.ledger.recordTurn({
      botId: author ?? 'unknown',
      botName: author,
      chars: result?.text?.length ?? 0,
      durationMs,
      error: result?.status === 'error',
    });
    this.ledger.persist().catch(() => {});
  }

  // -- local views ---------------------------------------------------------

  teamSnapshot() {
    return {
      bots: [],
      groups: [],
      diagnostics: this.diagnostics(),
      tools: this.tools.catalog,
    };
  }
}

/**
 * Builds an error that carries the protocol's error code.
 *
 * @param {string} code
 * @param {string} message
 * @param {boolean} [retryable]
 * @param {unknown} [details] extra context, e.g. the tool's live schema
 * @returns {Error & {code: string, retryable: boolean, details?: unknown}}
 */
function codedError(code, message, retryable = false, details) {
  const error = new Error(message);
  return Object.assign(error, { code, retryable, ...(details ? { details } : {}) });
}

/** Pulls a JSON object out of a tool result, whatever envelope it arrived in. */
export function extractData(result) {
  if (!result) return undefined;
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    const structured = result.structuredContent;
    if ('data' in structured && structured.data && typeof structured.data === 'object') {
      return structured.data;
    }
    if (Array.isArray(structured)) return structured;
    return structured;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          /* not JSON; keep looking */
        }
      }
      if (block && block.type === 'text' && typeof block.text === 'string') {
        return { text: block.text };
      }
    }
  }
  if (typeof content === 'string') {
    try {
      return JSON.parse(content);
    } catch {
      return { text: content };
    }
  }
  return undefined;
}

/** Reads token usage out of a tool receipt, when the receipt carries it. */
export function extractTokens(result) {
  const data = extractData(result);
  if (!data || typeof data !== 'object') return 0;
  const usage = data.usage ?? data.tokenUsage ?? data.tokens;
  if (typeof usage === 'number') return usage;
  if (usage && typeof usage === 'object') {
    const total = usage.total ?? usage.totalTokens;
    return typeof total === 'number' ? total : 0;
  }
  return 0;
}
