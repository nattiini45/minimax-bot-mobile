/**
 * Runs Bot turns through the Host's agent capability.
 *
 * The Host owns the conversation, so the bridge keeps a session id per chat and simply
 * relays what it observes. A turn survives the phone disconnecting: it belongs to the
 * desktop, and its result is replayed to whichever phone resumes.
 */

/** Mirrors the Host's agent concurrency ceiling. */
export const MAX_CONCURRENT_RUNS = 32;

export class AgentRunner {
  /**
   * @param {object} context the Mini App context
   * @param {object} options
   */
  constructor(context, { pending, onEvent, onTurnFinished } = {}) {
    this.context = context;
    this.pending = pending;
    this.onEvent = onEvent ?? (() => {});
    this.onTurnFinished = onTurnFinished ?? (() => {});
    /** @type {Map<string, string>} chatId -> sessionId */
    this.sessions = new Map();
    /** @type {Map<string, AbortController>} turnId -> controller */
    this.aborts = new Map();
    /** @type {Map<string, number>} `turnId:tool` -> the moment the tool started */
    this.toolStarts = new Map();
    this.activeRuns = 0;
  }

  get available() {
    return Boolean(this.context.agent);
  }

  sessionFor(chatId) {
    return this.sessions.get(chatId);
  }

  /**
   * Runs a turn for a chat.
   *
   * @param {{chatId: string, text: string, mentions?: string[]}} input
   */
  async run(input) {
    if (!this.context.agent) {
      throw codedError('AGENT_UNAVAILABLE', 'The desktop is not running an agent right now.', true);
    }
    if (this.activeRuns >= MAX_CONCURRENT_RUNS) {
      throw codedError('BUSY', 'Too many turns are already running.', true);
    }

    const { chatId, text } = input;
    const sessionId = this.sessions.get(chatId);
    const controller = new AbortController();
    this.activeRuns += 1;
    const startedAt = Date.now();

    const onEvent = (event) => this.handleAgentEvent(chatId, event, controller);

    let result;
    let failure;
    try {
      result = await this.context.agent.run(
        sessionId ? { text, sessionId } : { text },
        { signal: controller.signal, onEvent },
      );

      if (result.sessionId) {
        this.sessions.set(chatId, result.sessionId);
      }

      // A run can end waiting on a questionnaire without an event having fired.
      if (result.pendingQuestion) {
        const request = {
          requestId: result.pendingQuestion.requestId,
          sessionId: result.sessionId,
          turnId: result.pendingQuestion.turnId,
          mode: result.pendingQuestion.mode,
          title: result.pendingQuestion.request.title,
          steps: result.pendingQuestion.request.steps,
        };
        this.pending?.add('question', request, result.sessionId);
        this.onEvent('evt.question_requested', { request });
      }

      return result;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      this.activeRuns -= 1;
      for (const [turnId, active] of this.aborts) {
        if (active === controller) this.aborts.delete(turnId);
      }
      // A turn that failed still has to be reported, or the phone is left waiting on a
      // reply that will never come.
      if (failure) {
        this.onEvent('evt.turn_finished', {
          chatId,
          turnId: result?.turnId,
          status: 'error',
          reason: failure instanceof Error ? failure.message : String(failure),
          error: failure instanceof Error ? failure.message : String(failure),
        });
      }
      this.onTurnFinished?.({
        chatId,
        durationMs: Date.now() - startedAt,
        result,
        error: failure,
      });
    }
  }

  /** Answers a pending permission request. */
  async reply(requestId, decision) {
    // The agent API accepts exactly two decisions. Anything else — including
    // `allowAlways` — is refused here rather than forwarded to the Host.
    if (decision !== 'allowOnce' && decision !== 'deny') {
      throw codedError('INVALID_ARGUMENTS', 'A decision must be either allowOnce or deny.', false);
    }
    const item = this.pending?.get(requestId);
    if (!item || item.kind !== 'permission') {
      throw codedError('REQUEST_NOT_FOUND', 'That request is no longer waiting for an answer.', false);
    }
    await this.context.agent.reply({
      sessionId: item.sessionId,
      requestId,
      decision,
    });
    this.pending.resolve(requestId);
    this.onEvent('evt.permission_resolved', { requestId, decision });
  }

  /** Answers a pending questionnaire and observes the continuation turn. */
  async answer(requestId, answers) {
    const item = this.pending?.get(requestId);
    if (!item || item.kind !== 'question') {
      throw codedError('REQUEST_NOT_FOUND', 'That request is no longer waiting for an answer.', false);
    }
    const chatId = this.chatIdForSession(item.sessionId);
    const controller = new AbortController();
    const result = await this.context.agent.answer(
      { sessionId: item.sessionId, requestId, answers },
      { signal: controller.signal, onEvent: (event) => this.handleAgentEvent(chatId, event, controller) },
    );
    this.pending.resolve(requestId);
    this.onEvent('evt.question_answered', { requestId });
    return result;
  }

  /** Aborts a running turn. */
  abort(turnId) {
    const controller = this.aborts.get(turnId);
    if (!controller) return false;
    controller.abort();
    this.aborts.delete(turnId);
    return true;
  }

  chatIdForSession(sessionId) {
    for (const [chatId, value] of this.sessions) {
      if (value === sessionId) return chatId;
    }
    return 'unknown';
  }

  handleAgentEvent(chatId, event, controller) {
    switch (event.type) {
      case 'turn.started':
        this.aborts.set(event.turnId, controller);
        this.onEvent('evt.turn_started', { chatId, turnId: event.turnId });
        break;

      case 'text.delta':
        this.onEvent('evt.message_chunk', {
          chatId,
          turnId: event.turnId,
          messageId: messageIdFor(chatId, event.turnId),
          text: event.text,
        });
        break;

      case 'message.committed':
        this.onEvent('evt.message_committed', {
          message: {
            messageId: messageIdFor(chatId, event.turnId),
            chatId,
            role: 'assistant',
            text: event.text,
            ts: Date.now(),
            authorId: authorIdFor(chatId),
          },
        });
        break;

      case 'tool.started':
        this.toolStarts.set(toolKey(event.turnId, event.name), Date.now());
        this.onEvent('evt.tool_started', {
          chatId,
          turnId: event.turnId,
          toolName: event.name,
          ...(describeInput(event) === undefined ? {} : { toolInput: describeInput(event) }),
        });
        break;

      case 'tool.finished': {
        const key = toolKey(event.turnId, event.name);
        const startedAt = this.toolStarts.get(key);
        this.toolStarts.delete(key);
        // The host does not always report how long a tool took, so the bridge times it
        // itself: the phone shows a real duration rather than a blank.
        const reported = event.usage && typeof event.usage.durationMs === 'number' ? event.usage.durationMs : undefined;
        const durationMs = startedAt === undefined ? reported : Date.now() - startedAt;
        this.onEvent('evt.tool_finished', {
          chatId,
          turnId: event.turnId,
          toolName: event.name,
          ok: event.ok === true,
          ...(durationMs === undefined ? {} : { usage: { durationMs } }),
          ...(event.error ? { error: String(event.error) } : {}),
        });
        break;
      }

      case 'permission.requested': {
        const request = {
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          toolName: event.toolName,
          toolInput: event.toolInput,
          reason: event.reason,
        };
        this.pending?.add('permission', request, event.sessionId);
        this.onEvent('evt.permission_requested', { request });
        break;
      }

      case 'question.requested': {
        const request = {
          requestId: event.requestId,
          sessionId: event.sessionId,
          turnId: event.turnId,
          mode: event.mode,
          title: event.request.title,
          steps: event.request.steps,
        };
        this.pending?.add('question', request, event.sessionId);
        this.onEvent('evt.question_requested', { request });
        break;
      }

      case 'turn.finished':
        // A tool that never reported back would otherwise keep its start time forever.
        for (const key of [...this.toolStarts.keys()]) {
          if (key.startsWith(`${event.turnId ?? 'unknown'}:`)) this.toolStarts.delete(key);
        }
        this.onEvent('evt.turn_finished', {
          chatId,
          turnId: event.turnId,
          status: event.status,
          reason: event.status === 'error' ? 'error' : event.status === 'aborted' ? 'cancelled' : undefined,
          text: event.text,
          error: event.error,
        });
        break;

      default:
        break;
    }
  }
}

export function messageIdFor(chatId, turnId) {
  return `msg_${turnId ?? chatId}`;
}

export function authorIdFor(chatId) {
  return chatId.startsWith('bot:') ? chatId.slice(4) : undefined;
}

/**
 * Key for a running tool.
 *
 * The same tool can run twice in one turn, so the turn is part of the key.
 */
function toolKey(turnId, toolName) {
  return `${turnId ?? 'unknown'}:${toolName ?? 'unknown'}`;
}

/**
 * Describes a tool call's input for the phone.
 *
 * The host is not consistent about the field it uses, so every known spelling is
 * accepted. An input that is not text is rendered as JSON, and an input that is
 * missing entirely is left out rather than shown as an empty string.
 */
function describeInput(event) {
  const raw = event.input ?? event.args ?? event.arguments ?? event.toolInput;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
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
