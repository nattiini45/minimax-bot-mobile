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
  botId: ['botId', 'bot_id', 'target_bot', 'to', 'target', 'targetBotId', 'bot'],
  botIds: ['botIds', 'bot_ids', 'bots', 'to', 'targets'],
  text: ['text', 'message', 'content', 'prompt'],
  prompt: ['prompt', 'text', 'message', 'task', 'content', 'instruction'],
  title: ['title', 'name', 'subject'],
  taskId: ['taskId', 'task_id', 'id'],
  helperId: ['helperId', 'helper_id', 'id'],
  scheduleId: ['scheduleId', 'schedule_id', 'id', 'schedule'],
  turnId: ['turnId', 'turn_id', 'id', 'sessionId'],
  task: ['task', 'prompt', 'message', 'content', 'instruction', 'description'],
  id: ['id', 'memoryId', 'entryId', 'scheduleId', 'groupId', 'botId'],
  groupId: ['groupId', 'group_id', 'group', 'id'],
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
  targetBotId: ['targetBotId', 'target_bot_id', 'target_bot', 'botId', 'bot_id', 'to'],
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

/**
 * Properties the team fills in itself.
 *
 * Every team tool advertises `caller_bot_id`, and some of them list it as required,
 * but the server is the one that knows which Bot is calling. The bridge never sends
 * it, so it is never treated as a missing argument.
 */
const SERVER_SUPPLIED = ['caller_bot_id'];

/**
 * Which team tool backs each operation.
 *
 * The table lives in the shared protocol package — the same one the client and the relay
 * read — so the three runtimes cannot drift apart. It is vendored into the plugin
 * artifact by `scripts/sync-protocol.mjs`, because a Mini App runs with no module
 * resolution.
 */
export { OP_TOOL } from './protocol/index.js';

export class ToolArgumentError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ToolArgumentError';
    this.code = 'INVALID_ARGUMENTS';
    this.details = details;
  }
}

/**
 * Whether a value fits a JSON Schema property.
 *
 * An unknown type keyword never blocks a call: the live schema may use constructs
 * this check does not model, and refusing on them would break working tools.
 */
function matchesType(value, schema) {
  if (!schema || typeof schema !== 'object') return true;

  const declared = schema.type;
  if (declared) {
    const types = Array.isArray(declared) ? declared : [declared];
    const ok = types.some((type) => {
      switch (type) {
        case 'string':
          return typeof value === 'string';
        case 'number':
          return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
          return Number.isInteger(value);
        case 'boolean':
          return typeof value === 'boolean';
        case 'array':
          return Array.isArray(value);
        case 'object':
          return value !== null && typeof value === 'object' && !Array.isArray(value);
        default:
          return true;
      }
    });
    if (!ok) return false;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;

  return true;
}

/**
 * Maps an operation payload onto a tool's input schema.
 *
 * When the schema is unknown the payload is passed through untouched, which is correct
 * for tools that take a single argument bag.
 *
 * A payload field is only ever written onto a property that accepts its type: the
 * alias list is walked in order and the first candidate whose type fits wins. If a
 * candidate exists but the value does not fit it, that is a real mismatch and is
 * reported — the field is never silently dropped, because a dropped field turns
 * into a tool call with the wrong arguments.
 */
export function buildToolArguments(payload, schema) {
  const properties = schema && typeof schema === 'object' ? schema.properties : undefined;
  if (!properties || typeof properties !== 'object') {
    return { ...payload };
  }

  const used = new Set();
  const args = {};
  const unmapped = [];

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    const candidates = ALIASES[key] ?? [key];
    const target = candidates.find(
      (candidate) =>
        candidate in properties && !used.has(candidate) && matchesType(value, properties[candidate]),
    );
    if (target) {
      args[target] = value;
      used.add(target);
      continue;
    }

    // A candidate exists but rejects the value's type. Say so instead of dropping it.
    const mismatched = candidates.find(
      (candidate) => candidate in properties && !used.has(candidate),
    );
    if (mismatched) {
      throw new ToolArgumentError(
        `"${key}" does not fit the type of "${mismatched}" (${describeType(properties[mismatched])}).`,
        {
          field: key,
          target: mismatched,
          expected: describeType(properties[mismatched]),
          missing: [],
          required: Array.isArray(schema.required) ? schema.required : [],
          properties: Object.keys(properties),
        },
      );
    }

    unmapped.push(key);
  }

  // Properties the schema wants but the payload did not carry are left out on purpose:
  // the tool decides whether they are required.

  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter(
    (property) => !(property in args) && !SERVER_SUPPLIED.includes(property),
  );
  if (missing.length > 0) {
    throw new ToolArgumentError(
      `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
      { missing, required, unmapped, properties: Object.keys(properties) },
    );
  }

  return args;
}

/** A short human description of a schema property, for error messages. */
function describeType(property) {
  if (!property || typeof property !== 'object') return 'unknown';
  const declared = property.type;
  if (Array.isArray(declared)) return declared.join(' | ');
  if (typeof declared === 'string') return declared;
  if (Array.isArray(property.enum)) return `one of ${property.enum.join(', ')}`;
  return 'unknown';
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
   * @returns {Promise<{ok: boolean, content?: unknown, structuredContent?: unknown, isError?: boolean, code?: string, disposition?: string, details?: unknown, message?: string}>}
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
        return {
          ok: false,
          code: error.code,
          disposition: 'not_dispatched',
          message: error.message,
          details: error.details,
        };
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
        message: result?.message,
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
