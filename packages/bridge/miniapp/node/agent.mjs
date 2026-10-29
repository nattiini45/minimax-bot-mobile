/**
 * Runs Bot turns through the Host's agent capability.
 *
 * The Host owns the conversation, so the bridge keeps a session id per chat and simply
 * relays what it observes. A turn survives the phone disconnecting: it belongs to the
 * desktop, and its result is replayed to whichever phone resumes.
 */

/** Mirrors the Host's agent concurrency ceiling. */
export const MAX_CONCURRENT_RUNS = 32;

/**
 * How many Host conversations the runner keeps open at once.
 *
 * A conversation is keyed by the chat id a client chose, so without a ceiling a client
 * that keeps inventing chats makes the desktop hold a Host session for each of them.
 */
export const MAX_HOST_SESSIONS = 50;

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
    /**
     * The tool calls that are still running.
     *
     * @type {Map<string, {startedAt: number; callId: string}[]>} `turnId:tool` -> the calls,
     *   oldest first. The host emits one event per call and does not name two calls of the
     *   same tool apart, so the calls are queued and a finish takes the oldest one.
     */
    this.toolCalls = new Map();
    /** @type {number} the bridge's own counter, used to name a call */
    this.callCounter = 0;
    this.activeRuns = 0;
  }

  get available() {
    return Boolean(this.context.agent);
  }

  sessionFor(chatId) {
    return this.sessions.get(chatId);
  }

  /** Records the start of a tool call and gives it an id of its own. */
  startTool(turnId, toolName) {
    const key = toolKey(turnId, toolName);
    const queue = this.toolCalls.get(key) ?? [];
    const callId = `call_${(this.callCounter += 1)}`;
    queue.push({ startedAt: Date.now(), callId });
    this.toolCalls.set(key, queue);
    return callId;
  }

  /**
   * Takes the call a finish belongs to.
   *
   * Two calls of the same tool in one turn are indistinguishable by name, so the oldest
   * unfinished call is the one that reports back. That is the call whose duration was
   * measured, and the id it carries is the one the phone matches on.
   */
  finishTool(turnId, toolName) {
    const key = toolKey(turnId, toolName);
    const queue = this.toolCalls.get(key);
    if (!queue || queue.length === 0) return undefined;
    const call = queue.shift();
    if (queue.length === 0) this.toolCalls.delete(key);
    return call;
  }

  /** Forgets the calls of a turn, so a turn that ends badly leaves nothing behind. */
  clearTools(turnId) {
    if (turnId === undefined || turnId === null) return;
    for (const key of [...this.toolCalls.keys()]) {
      if (key.startsWith(`${turnId}:`)) this.toolCalls.delete(key);
    }
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

    const onEvent = (event) => {
      // The turn id is only known from the events, and it is what the tool bookkeeping
      // is keyed by, so it is remembered as the run goes.
      if (event && typeof event.turnId === 'string') currentTurnId = event.turnId;
      this.handleAgentEvent(chatId, event, controller);
    };

    let result;
    let failure;
    let currentTurnId;
    try {
      result = await this.context.agent.run(
        sessionId ? { text, sessionId } : { text },
        { signal: controller.signal, onEvent },
      );

      if (result.sessionId) {
        this.sessions.set(chatId, result.sessionId);
        // The chat id is chosen by the client, so the number of Host conversations the
        // desktop keeps open is a ceiling and not a promise. The least recently used one
        // is forgotten: a chat that comes back starts a new conversation.
        while (this.sessions.size > MAX_HOST_SESSIONS) {
          const oldest = this.sessions.keys().next();
          if (oldest.done) break;
          this.sessions.delete(oldest.value);
        }
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
      // A turn that ended without a `turn.finished` — a steered run, an abort — would
      // otherwise keep its unfinished tool calls for the rest of the session.
      this.clearTools(currentTurnId);
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

      case 'tool.started': {
        const callId = this.startTool(event.turnId, event.name);
        this.onEvent('evt.tool_started', {
          chatId,
          turnId: event.turnId,
          toolName: event.name,
          callId,
        });
        break;
      }

      case 'tool.finished': {
        const call = this.finishTool(event.turnId, event.name);
        // The host does not report how long a tool took, so the bridge times it itself:
        // the phone shows a real duration rather than a blank.
        const measured = call === undefined ? undefined : Date.now() - call.startedAt;
        const durationMs = measured === undefined ? undefined : Math.max(0, measured);
        this.onEvent('evt.tool_finished', {
          chatId,
          turnId: event.turnId,
          toolName: event.name,
          callId: call?.callId ?? `call_${(this.callCounter += 1)}`,
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
        this.clearTools(event.turnId);
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
