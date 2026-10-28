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
      throw new Error('AGENT_UNAVAILABLE');
    }
    if (this.activeRuns >= MAX_CONCURRENT_RUNS) {
      throw new Error('BUSY');
    }

    const { chatId, text } = input;
    const sessionId = this.sessions.get(chatId);
    const controller = new AbortController();
    this.activeRuns += 1;
    const startedAt = Date.now();

    const onEvent = (event) => this.handleAgentEvent(chatId, event, controller);

    let result;
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
    } finally {
      this.activeRuns -= 1;
      for (const [turnId, active] of this.aborts) {
        if (active === controller) this.aborts.delete(turnId);
      }
      this.onTurnFinished?.({ chatId, durationMs: Date.now() - startedAt, result });
    }
  }

  /** Answers a pending permission request. */
  async reply(requestId, decision) {
    const item = this.pending?.get(requestId);
    if (!item || item.kind !== 'permission') {
      throw new Error('REQUEST_NOT_FOUND');
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
      throw new Error('REQUEST_NOT_FOUND');
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
        this.onEvent('evt.tool_started', {
          chatId,
          turnId: event.turnId,
          toolName: event.name,
        });
        break;

      case 'tool.finished':
        this.onEvent('evt.tool_finished', {
          chatId,
          turnId: event.turnId,
          toolName: event.name,
          ok: event.ok === true,
        });
        break;

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
