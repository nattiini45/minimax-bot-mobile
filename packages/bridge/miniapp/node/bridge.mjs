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
import { createFrame, newId } from './protocol/index.js';

const OP_DEDUPE_TTL_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 200;

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
        });
        if (online) this.replayPending();
      },
    });

    /** @type {Map<string, Array<object>>} chatId -> messages */
    this.history = new Map();
    /** @type {Map<string, Map<string, number>>} messageId -> emoji -> count */
    this.reactions = new Map();
    /** @type {Map<string, {result: unknown, expiresAt: number}>} */
    this.opCache = new Map();
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

  /** Re-emits held approvals and questions so a resuming phone sees them. */
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
    });
  }

  // -- inbound -------------------------------------------------------------

  async handleFrame(frame) {
    if (!frame || typeof frame.type !== 'string') return;
    if (!frame.type.startsWith('op.')) return;

    const opId = frame.opId ?? frame.id;

    const cached = this.opCache.get(opId);
    if (cached && cached.expiresAt > Date.now()) {
      this.reply(frame, cached.result);
      return;
    }

    try {
      const result = await this.dispatch(frame.type, frame.payload ?? {});
      this.opCache.set(opId, { result, expiresAt: Date.now() + OP_DEDUPE_TTL_MS });
      this.pruneCache();
      this.reply(frame, result);
    } catch (error) {
      this.replyError(frame, error);
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
      default: {
        const toolName = OP_TOOL[type];
        if (!toolName) {
          throw codedError('UNKNOWN_OP', `No handler for ${type}`);
        }
        return this.callTool(toolName, payload);
      }
    }
  }

  /**
   * Calls a team tool and normalises the result.
   *
   * The tool envelope differs per tool, so the raw result is returned alongside a best
   * effort structured view; the client renders the structured view and falls back to the
   * raw content when it cannot.
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
    });
    await this.ledger.persist();

    if (!result.ok) {
      throw codedError(result.code ?? 'TOOL_FAILED', `The ${toolName} tool did not complete.`, false);
    }
    if (result.isError === true) {
      throw codedError('TOOL_REPORTED_ERROR', 'The team tool reported an error.', false);
    }

    return {
      tool: toolName,
      content: result.content,
      structuredContent: result.structuredContent,
      data: extractData(result),
    };
  }

  /** Reads the team roster, preferring the tool's structured output. */
  async readTeam() {
    const result = await this.tools.call('list_team', {});
    const data = extractData(result) ?? {};
    return {
      bots: Array.isArray(data.bots) ? data.bots : [],
      groups: Array.isArray(data.groups) ? data.groups : [],
    };
  }

  diagnostics() {
    return {
      agentAvailable: this.runner.available,
      teamToolsAvailable: this.tools.available,
      toolCount: this.tools.catalog.length,
      partial: this.tools.partial,
      linkedAt: this.linkedAt,
      reason: this.tools.reason,
    };
  }

  async sendMessage(payload) {
    const { chatId, text, mentions } = payload;
    if (!chatId || !text) {
      throw codedError('INVALID_ARGUMENTS', 'chatId and text are required.');
    }

    const userMessage = {
      messageId: `msg_${newId('u')}`,
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
 * @returns {Error & {code: string, retryable: boolean}}
 */
function codedError(code, message, retryable = false) {
  const error = new Error(message);
  return Object.assign(error, { code, retryable });
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
