/**
 * Wire contract for the MiniMax Bot mobile client.
 *
 * Three roles sit on this protocol:
 *  - `app`    — the Expo client (phone / tablet / PWA).
 *  - `bridge` — the MiniMax Code Mini App plugin that owns the team.
 *  - `relay`  — the Cloudflare Worker + Durable Object that pipes frames between them.
 *
 * The relay never interprets a payload. It stamps a monotonic `seq` on every event it
 * forwards from the bridge and replays from a ring buffer when a client resumes, so the
 * phone is always a projection of bridge-owned truth.
 */

export const PROTOCOL_VERSION = 1 as const;

/** Who produced a frame. */
export type Role = 'app' | 'bridge' | 'relay';

/** Frame envelope. `seq` is assigned by the relay; everything else is set by the sender. */
export interface Frame<TPayload = unknown> {
  /** Protocol version. */
  v: typeof PROTOCOL_VERSION;
  /** Unique frame id. */
  id: string;
  /** Epoch milliseconds. */
  ts: number;
  /** `op.*` (request), `evt.*` (notification), `ack`, `err`, `hello`, `hello.ok`. */
  type: string;
  /** Role that produced the frame. */
  source: Role;
  /** Body. Shape depends on `type`. */
  payload: TPayload;
  /** Monotonic per-bridge sequence number; set by the relay on forwarded events. */
  seq?: number;
  /** Frame id this frame answers. */
  in_reply_to?: string;
  /** Idempotency key. Repeating an op with the same `opId` must not repeat its effect. */
  opId?: string;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A member of the team, as `list_team` reports it. */
export interface Bot {
  botId: string;
  name: string;
  role?: string;
  /** MiniMax octopus skin id, e.g. `fuzzy`. Presentation only. */
  skin?: string;
  /** MiniMax look id, e.g. `ocean`. Presentation only. */
  color?: string;
  description?: string;
  model?: string;
  /** True for a main Bot (has management rights). */
  isMain?: boolean;
  /** Memory scope, usually the bot id. */
  memoryScope?: string;
}

export interface Group {
  groupId: string;
  name: string;
  /** Bot id of the admin that answers by default. */
  admin?: string;
  memberIds: string[];
  notice?: string;
  replyMode?: 'admin' | 'all';
}

export interface TeamDiagnostics {
  /** The Host granted `session.run`, so Bot turns can run. */
  agentAvailable: boolean;
  /** The `minimax-bot` MCP server answered a tool listing. */
  teamToolsAvailable: boolean;
  /** Number of team tools the bridge can currently see. */
  toolCount: number;
  /** The tool catalogue is incomplete (a server was still warming up). */
  partial: boolean;
  /** Epoch ms the bridge first linked the team. */
  linkedAt?: number;
  /** Human-readable reason the team is not available. */
  reason?: string;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessage {
  messageId: string;
  /** `bot:<botId>` or `group:<groupId>`. */
  chatId: string;
  role: MessageRole;
  text: string;
  /** Epoch ms. */
  ts: number;
  /** Bot id for assistant messages. */
  authorId?: string;
  /** Tool name for `role === 'tool'`. */
  toolName?: string;
  /** Optimistic client-side message that is not yet committed. */
  pending?: boolean;
}

export type TaskState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
  taskId: string;
  state: TaskState;
  title?: string;
  botIds?: string[];
  progress?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface Helper {
  helperId: string;
  title?: string;
  state: 'running' | 'stopped' | 'error';
  lastRunAt?: number;
  nextRunAt?: number;
  detail?: string;
}

export interface MemoryEntry {
  id: string;
  scope: string;
  text: string;
  createdAt: number;
  chars?: number;
}

export interface Schedule {
  scheduleId: string;
  name: string;
  kind: 'daily' | 'interval' | 'once';
  /** `HH:MM` for daily, minutes for interval. */
  spec: string;
  targetBotId?: string;
  prompt?: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
}

export interface UsageBucket {
  key: string;
  label: string;
  turns: number;
  chars: number;
  tools: number;
  durationMs: number;
  errors: number;
}

export interface UsageByBot {
  botId: string;
  name: string;
  turns: number;
  chars: number;
  tools: number;
}

export interface UsageReport {
  buckets: UsageBucket[];
  byBot: UsageByBot[];
  totals: { turns: number; chars: number; tools: number; durationMs: number; errors: number };
}

/** A tool the bridge can call, mirroring the Host's plugin-MCP listing shape. */
export interface ToolDescriptor {
  /** Runtime name, e.g. `mcp__minimax-bot__message_bot`. */
  name: string;
  /** Server the tool belongs to. */
  server: string;
  /** Tool name within the server, e.g. `message_bot`. */
  tool: string;
  description?: string;
  inputSchema?: JsonValue;
}

export type PermissionDecision = 'allowOnce' | 'deny';

export interface PermissionRequest {
  requestId: string;
  sessionId: string;
  turnId?: string;
  toolName: string;
  /** Serialized tool input, shown verbatim to the user. */
  toolInput?: string;
  reason: string;
  /** Epoch ms; the request is withdrawn after this. */
  expiresAt?: number;
}

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionStep {
  id: string;
  header?: string;
  question: string;
  description?: string;
  selectionMode: 'single' | 'multiple';
  options: QuestionOption[];
  allowOther: true;
}

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  turnId?: string;
  mode: 'questionnaire' | 'feature-enable' | 'plan';
  title?: string;
  steps: QuestionStep[];
  expiresAt?: number;
}

export interface QuestionAnswer {
  stepId: string;
  selectedOptionIds: string[];
  selectedOther: boolean;
  otherText?: string;
  skipped?: boolean;
}

export interface Reaction {
  messageId: string;
  emoji: string;
}

// ---------------------------------------------------------------------------
// Operations: app -> bridge
// ---------------------------------------------------------------------------

export interface OpListTeam {
  bots: Bot[];
  groups: Group[];
  diagnostics: TeamDiagnostics;
}

export interface OpSendMessage {
  chatId: string;
  text: string;
  /** Bot ids to @mention in a group. */
  mentions?: string[];
  attachments?: string[];
}

export interface OpSendMessageResult {
  messageId: string;
  turnId?: string;
  sessionId: string;
}

export interface OpAbortTurn {
  turnId: string;
}

export interface OpDispatch {
  botIds: string[];
  prompt: string;
  title?: string;
}

export interface OpDispatchResult {
  taskIds: string[];
}

export interface OpListTasks {}

export interface OpListTasksResult {
  tasks: Task[];
}

export interface OpCancelTask {
  taskId: string;
}

export interface OpListHelpers {}

export interface OpListHelpersResult {
  helpers: Helper[];
}

export interface OpStartHelper {
  title?: string;
  task: string;
  targetBotId?: string;
}

export interface OpStopHelper {
  helperId: string;
}

export interface OpRecall {
  botId: string;
  query: string;
  limit?: number;
}

export interface OpRecallResult {
  entries: MemoryEntry[];
}

export interface OpRemember {
  botId: string;
  text: string;
}

export interface OpForget {
  botId: string;
  id: string;
}

export interface OpCreateBot {
  name: string;
  role?: string;
  instructions?: string;
  skin?: string;
  color?: string;
  model?: string;
  main?: boolean;
}

export interface OpUpdateBot {
  botId: string;
  name?: string;
  role?: string;
  instructions?: string;
  skin?: string;
  color?: string;
  model?: string;
  main?: boolean;
}

export interface OpDeleteBot {
  botId: string;
}

export interface OpCreateGroup {
  name: string;
  memberIds: string[];
  admin?: string;
  notice?: string;
  replyMode?: 'admin' | 'all';
}

export interface OpUpdateGroup {
  groupId: string;
  name?: string;
  memberIds?: string[];
  admin?: string;
  notice?: string;
  replyMode?: 'admin' | 'all';
}

export interface OpDeleteGroup {
  groupId: string;
}

export interface OpListSchedules {}

export interface OpListSchedulesResult {
  schedules: Schedule[];
}

export interface OpCreateSchedule {
  name: string;
  kind: 'daily' | 'interval' | 'once';
  /** `HH:MM` for daily, minutes for interval. */
  spec: string;
  targetBotId?: string;
  prompt?: string;
}

export interface OpDeleteSchedule {
  scheduleId: string;
}

export interface OpGetUsage {
  days?: number;
}

export interface OpRespondPermission {
  requestId: string;
  decision: PermissionDecision;
}

export interface OpAnswerQuestion {
  requestId: string;
  answers: QuestionAnswer[];
}

export interface OpReact {
  messageId: string;
  emoji: string;
}

export interface OpListHistory {
  chatId: string;
  limit?: number;
}

export interface OpListHistoryResult {
  messages: ChatMessage[];
}

/** Every operation the client can request, keyed by its frame type. */
export interface OpPayloadMap {
  'op.list_team': OpListTeam;
  'op.send_message': OpSendMessage;
  'op.abort_turn': OpAbortTurn;
  'op.dispatch': OpDispatch;
  'op.list_tasks': OpListTasks;
  'op.cancel_task': OpCancelTask;
  'op.list_helpers': OpListHelpers;
  'op.start_helper': OpStartHelper;
  'op.stop_helper': OpStopHelper;
  'op.recall': OpRecall;
  'op.remember': OpRemember;
  'op.forget': OpForget;
  'op.create_bot': OpCreateBot;
  'op.update_bot': OpUpdateBot;
  'op.delete_bot': OpDeleteBot;
  'op.create_group': OpCreateGroup;
  'op.update_group': OpUpdateGroup;
  'op.delete_group': OpDeleteGroup;
  'op.list_schedules': OpListSchedules;
  'op.create_schedule': OpCreateSchedule;
  'op.delete_schedule': OpDeleteSchedule;
  'op.get_usage': OpGetUsage;
  'op.respond_permission': OpRespondPermission;
  'op.answer_question': OpAnswerQuestion;
  'op.react': OpReact;
  'op.list_history': OpListHistory;
}

// ---------------------------------------------------------------------------
// Events: bridge -> app
// ---------------------------------------------------------------------------

export interface EvtTeamSnapshot {
  bots: Bot[];
  groups: Group[];
  diagnostics: TeamDiagnostics;
  tools: ToolDescriptor[];
}

export interface EvtTurnStarted {
  chatId: string;
  turnId: string;
}

export interface EvtMessageChunk {
  chatId: string;
  turnId: string;
  messageId: string;
  text: string;
  /** True for the final chunk of a committed message. */
  final?: boolean;
}

export interface EvtMessageCommitted {
  message: ChatMessage;
}

export interface EvtToolStarted {
  chatId: string;
  turnId: string;
  toolName: string;
  toolInput?: string;
}

export interface EvtToolFinished {
  chatId: string;
  turnId: string;
  toolName: string;
  ok: boolean;
  /** Token usage reported by the tool receipt, when present. */
  usage?: { tokens?: number; durationMs?: number };
  error?: string;
}

export interface EvtTurnFinished {
  chatId: string;
  turnId: string;
  status: 'finished' | 'error' | 'aborted';
  reason?: 'budget' | 'cancelled' | 'error';
  text?: string;
  error?: { code: string; message: string };
}

export interface EvtPermissionRequested {
  request: PermissionRequest;
}

export interface EvtPermissionResolved {
  requestId: string;
  decision: PermissionDecision;
}

export interface EvtQuestionRequested {
  request: QuestionRequest;
}

export interface EvtQuestionAnswered {
  requestId: string;
}

export interface EvtTaskUpdated {
  task: Task;
}

export interface EvtHelperUpdated {
  helper: Helper;
}

export interface EvtScheduleUpdated {
  schedule: Schedule;
}

export interface EvtBridgeStatus {
  desktopOnline: boolean;
  agentAvailable: boolean;
  teamToolsAvailable: boolean;
  linkedAt?: number;
}

export interface EvtReactionAdded {
  reaction: Reaction;
}

/** Every event the bridge can push, keyed by its frame type. */
export interface EventPayloadMap {
  'evt.team_snapshot': EvtTeamSnapshot;
  'evt.turn_started': EvtTurnStarted;
  'evt.message_chunk': EvtMessageChunk;
  'evt.message_committed': EvtMessageCommitted;
  'evt.tool_started': EvtToolStarted;
  'evt.tool_finished': EvtToolFinished;
  'evt.turn_finished': EvtTurnFinished;
  'evt.permission_requested': EvtPermissionRequested;
  'evt.permission_resolved': EvtPermissionResolved;
  'evt.question_requested': EvtQuestionRequested;
  'evt.question_answered': EvtQuestionAnswered;
  'evt.task_updated': EvtTaskUpdated;
  'evt.helper_updated': EvtHelperUpdated;
  'evt.schedule_updated': EvtScheduleUpdated;
  'evt.bridge_status': EvtBridgeStatus;
  'evt.reaction_added': EvtReactionAdded;
}

// ---------------------------------------------------------------------------
// Control frames
// ---------------------------------------------------------------------------

/** app -> relay: open a device session. */
export interface HelloPayload {
  /** Device id issued at pairing time. */
  deviceId: string;
  /** Device bearer token issued at pairing time. */
  token: string;
  /** Resume point; the relay replays everything after this seq. */
  lastSeq?: number;
  clientVersion: string;
}

/** relay -> app: the session is open. */
export interface HelloOkPayload {
  /** Highest seq the relay has buffered. */
  seq: number;
  bridgeOnline: boolean;
  /** Set when the relay had to drop frames the client could not catch up on. */
  truncated?: boolean;
}

export interface AckPayload {
  opId?: string;
  result: unknown;
}

export interface ErrPayload {
  opId?: string;
  code: string;
  message: string;
  /** Whether the caller may safely retry the same op. */
  retryable: boolean;
}

export type OpType = keyof OpPayloadMap;
export type EventType = keyof EventPayloadMap;
export type AnyOpType = OpType | EventType;

export const OP_TYPES = [
  'op.list_team',
  'op.send_message',
  'op.abort_turn',
  'op.dispatch',
  'op.list_tasks',
  'op.cancel_task',
  'op.list_helpers',
  'op.start_helper',
  'op.stop_helper',
  'op.recall',
  'op.remember',
  'op.forget',
  'op.create_bot',
  'op.update_bot',
  'op.delete_bot',
  'op.create_group',
  'op.update_group',
  'op.delete_group',
  'op.list_schedules',
  'op.create_schedule',
  'op.delete_schedule',
  'op.get_usage',
  'op.respond_permission',
  'op.answer_question',
  'op.react',
  'op.list_history',
] as const satisfies readonly OpType[];

export const EVENT_TYPES = [
  'evt.team_snapshot',
  'evt.turn_started',
  'evt.message_chunk',
  'evt.message_committed',
  'evt.tool_started',
  'evt.tool_finished',
  'evt.turn_finished',
  'evt.permission_requested',
  'evt.permission_resolved',
  'evt.question_requested',
  'evt.question_answered',
  'evt.task_updated',
  'evt.helper_updated',
  'evt.schedule_updated',
  'evt.bridge_status',
  'evt.reaction_added',
] as const satisfies readonly EventType[];

export function isOpType(type: string): type is OpType {
  return (OP_TYPES as readonly string[]).includes(type);
}

export function isEventType(type: string): type is EventType {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Maps an operation to the team tool that implements it.
 *
 * The bridge prefers this table to reach a tool, and falls back to a name match on
 * `mcp__minimax-bot__<tool>`. Keeping it here means the client, the relay and the bridge
 * agree on which tool backs which operation.
 */
export const OP_TOOL: Readonly<Partial<Record<OpType, string>>> = {
  'op.list_team': 'list_team',
  'op.send_message': 'message_bot',
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

/** Operations the bridge answers from its own agent rather than from a team tool. */
export const AGENT_BACKED_OPS: readonly OpType[] = ['op.send_message', 'op.abort_turn', 'op.respond_permission', 'op.answer_question'];
