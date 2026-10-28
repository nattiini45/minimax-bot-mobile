/**
 * Access to the team's MCP tools.
 *
 * The bridge never hardcodes a tool's parameter names: it reads the live catalogue from
 * the Host (`context.tool.list()`), which reports each tool's `inputSchema`, and maps the
 * operation payload onto that schema. When a required property cannot be satisfied the
 * bridge refuses with `INVALID_ARGUMENTS` and returns the schema so the client can ask
 * for exactly the missing field instead of guessing.
 */

const TEAM_SERVER_HINT = 'minimax-bot';

/** Candidate property names for each operation field, most likely first. */
const ALIASES = {
  botId: ['botId', 'bot_id', 'to', 'target', 'targetBotId', 'bot'],
  botIds: ['botIds', 'bot_ids', 'bots', 'to', 'targets'],
  text: ['text', 'message', 'content', 'prompt'],
  prompt: ['prompt', 'text', 'message', 'task', 'content', 'instruction'],
  title: ['title', 'name', 'subject'],
  taskId: ['taskId', 'task_id', 'id'],
  helperId: ['helperId', 'helper_id', 'id'],
  id: ['id', 'memoryId', 'entryId', 'scheduleId', 'groupId', 'botId'],
  groupId: ['groupId', 'group_id', 'id'],
  query: ['query', 'q', 'search', 'text'],
  limit: ['limit', 'count', 'max', 'top'],
  days: ['days', 'span', 'range'],
  name: ['name', 'title'],
  memberIds: ['memberIds', 'member_ids', 'members', 'bots'],
  admin: ['admin', 'adminBotId', 'admin_bot_id'],
  notice: ['notice', 'description'],
  replyMode: ['replyMode', 'reply_mode', 'mode'],
  skin: ['skin', 'look', 'avatar'],
  color: ['color', 'colour'],
  model: ['model', 'modelId', 'model_id'],
  role: ['role', 'title', 'description'],
  instructions: ['instructions', 'prompt', 'systemPrompt', 'persona'],
  main: ['main', 'isMain', 'is_main'],
  kind: ['kind', 'type', 'scheduleKind', 'schedule_kind'],
  spec: ['spec', 'time', 'at', 'everyMinutes', 'every_minutes', 'cron', 'schedule'],
  targetBotId: ['targetBotId', 'target_bot_id', 'botId', 'bot_id', 'to'],
  enabled: ['enabled', 'active'],
  chatId: ['chatId', 'chat_id'],
  mentions: ['mentions', 'mentionIds', 'at'],
  attachments: ['attachments', 'files'],
  requestId: ['requestId', 'request_id', 'id'],
  decision: ['decision', 'action'],
  answers: ['answers', 'answer'],
  messageId: ['messageId', 'message_id', 'id'],
  emoji: ['emoji', 'reaction'],
  role_: ['role', 'title'],
};

/** Which team tool backs each operation. */
export const OP_TOOL = {
  'op.list_team': 'list_team',
  'op.dispatch': 'dispatch_tasks',
  'op.list_tasks': 'get_tasks',
  'op.cancel_task': 'cancel_tasks',
  'op.list_helpers': 'list_helpers',
  'op.start_helper': 'start_helper',
  'op.stop_helper': 'stop_helper',
  'op.recall': 'recall',
  'op.remember': 'remember',
  'op.forget': 'forget',
  'op.create_bot': 'create_bot',
  'op.update_bot': 'update_bot',
  'op.delete_bot': 'delete_bot',
  'op.create_group': 'create_group',
  'op.update_group': 'update_group',
  'op.delete_group': 'delete_group',
  'op.list_schedules': 'list_schedules',
  'op.create_schedule': 'create_schedule',
  'op.delete_schedule': 'delete_schedule',
};

export class ToolArgumentError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ToolArgumentError';
    this.code = 'INVALID_ARGUMENTS';
    this.details = details;
  }
}

/**
 * Maps an operation payload onto a tool's input schema.
 *
 * When the schema is unknown the payload is passed through untouched, which is correct
 * for tools that take a single argument bag.
 */
export function buildToolArguments(payload, schema) {
  const properties = schema && typeof schema === 'object' ? schema.properties : undefined;
  if (!properties || typeof properties !== 'object') {
    return { ...payload };
  }

  const used = new Set();
  const args = {};

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const candidates = ALIASES[key] ?? [key];
    const target = candidates.find((candidate) => candidate in properties && !used.has(candidate));
    if (target) {
      args[target] = value;
      used.add(target);
    }
  }

  // Properties the schema wants but the payload did not carry are left out on purpose:
  // the tool decides whether they are required.

  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((property) => !(property in args));
  if (missing.length > 0) {
    throw new ToolArgumentError(
      `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      { missing, required, properties: Object.keys(properties) },
    );
  }

  return args;
}

export class ToolGateway {
  /**
   * @param {object} context the Mini App context
   */
  constructor(context) {
    this.context = context;
    /** @type {Array<{name: string, server: string, tool: string, description?: string, inputSchema?: unknown}>} */
    this.catalog = [];
    this.partial = false;
    this.available = false;
    this.reason = undefined;
  }

  /** Reads the live tool catalogue. Never throws: an unavailable team is a state, not a crash. */
  async refresh() {
    const tool = this.context.tool;
    if (!tool || typeof tool.list !== 'function') {
      this.available = false;
      this.reason = 'This Mini App was not granted tool access.';
      this.catalog = [];
      return this;
    }
    try {
      const result = await tool.list();
      this.catalog = (result.tools ?? []).filter((entry) => this.isTeamTool(entry));
      this.partial = result.partial === true;
      this.available = this.catalog.length > 0;
      this.reason = this.available
        ? undefined
        : 'The @minimax-bot team is not running. Open MiniMax Bot on this desktop to link it.';
    } catch (error) {
      this.available = false;
      this.catalog = [];
      this.reason = error instanceof Error ? error.message : 'The team tool catalogue could not be read.';
    }
    return this;
  }

  isTeamTool(entry) {
    const server = String(entry.server ?? '').toLowerCase();
    const name = String(entry.name ?? '').toLowerCase();
    return server.includes(TEAM_SERVER_HINT) || name.includes(TEAM_SERVER_HINT);
  }

  /** Finds a tool by its short name, e.g. `message_bot`. */
  find(toolName) {
    return this.catalog.find((entry) => entry.tool === toolName);
  }

  /**
   * Calls a team tool by its short name.
   *
   * @returns {Promise<{ok: boolean, content?: unknown, structuredContent?: unknown, isError?: boolean, code?: string, disposition?: string, details?: unknown}>}
   */
  async call(toolName, payload, options = {}) {
    const descriptor = this.find(toolName);
    if (!descriptor) {
      return { ok: false, code: 'TOOL_NOT_AVAILABLE', disposition: 'not_dispatched' };
    }

    let args;
    try {
      args = buildToolArguments(payload, descriptor.inputSchema);
    } catch (error) {
      if (error instanceof ToolArgumentError) {
        return { ok: false, code: error.code, disposition: 'not_dispatched', details: error.details };
      }
      throw error;
    }

    const result = await this.context.tool.call({
      name: descriptor.name,
      arguments: args,
      signal: options.signal,
    });

    if (!result || result.ok !== true) {
      return {
        ok: false,
        code: result?.code ?? 'MCP_TOOL_FAILED',
        disposition: result?.disposition ?? 'unknown_after_dispatch',
      };
    }

    return {
      ok: true,
      isError: result.isError === true,
      content: result.content,
      structuredContent: result.structuredContent,
    };
  }
}
