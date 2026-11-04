/**
 * Wire contract for the MiniMax Bot mobile client.
 *
 * Three roles sit on this protocol:
 *  - `app`    — the Expo client (phone / tablet / web).
 *  - `bridge` — the MiniMax Code Mini App plugin that owns the team.
 *  - `relay`  — the Cloudflare Worker + Durable Object that pipes frames between them.
 *
 * The relay never interprets a payload. It stamps a monotonic `seq` on every event it
 * forwards from the bridge and replays from a ring buffer when a client resumes, so the
 * phone is always a projection of bridge-owned truth.
 */

export const PROTOCOL_VERSION = 1 as const;

/**
 * The WebSocket close codes the relay uses to say why a peer was refused.
 *
 * The relay accepts the upgrade first and closes the socket with one of these, so
 * the peer learns *why* it was refused. Answering the handshake with an HTTP error
 * instead would hide the reason behind a generic "connection failed" — a phone that
 * had been unpaired cannot tell that apart from a relay that is simply down.
 */
export const CLOSE_CODE = {
  /** The credential was not accepted. */
  unauthorized: 4001,
  /** Another peer took this peer's place. */
  replaced: 4000,
  /** The device was unpaired on the desktop. */
  deviceRevoked: 4003,
} as const;

export type CloseCode = (typeof CLOSE_CODE)[keyof typeof CLOSE_CODE];

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
  /**
   * The peer the relay says sent this frame; set by the relay, never by a peer.
   *
   * It is how the desktop knows which phone asked for something. A peer that
   * carries one has its frame dropped: the relay is the only thing that knows
   * which socket a frame came from.
   */
  from?: string;
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
  /**
   * The Bot's own picture, as a URL the phone can load, e.g. `https://…/chief.png`.
   *
   * A Bot with a picture of its own shows it instead of the octopus. A picture the
   * phone cannot load — a path on the desktop, say — is left out, so the app falls
   * back to the octopus rather than showing a broken frame.
   */
  avatar?: string;
  description?: string;
  model?: string;
  /** True for a main Bot (has management rights). */
  isMain?: boolean;
  /** Memory scope, usually the bot id. */
  memoryScope?: string;
  /** The Bot's face, e.g. `happy`. Presentation only. */
  face?: string;
  /** What the Bot is for, in the Bot's own words. */
  instructions?: string;
  /** Reasoning effort, e.g. `high`. */
  effort?: string;
  /**
   * Where this Bot's turns run when the phone sends one.
   *
   * `team` runs them in the team's own engine; `hosted` runs them on the desktop under
   * the bridge, so a permission check or a questionnaire the Bot raises can be answered
   * from the phone.
   */
  runMode?: BotRunMode;
}

/**
 * A Bot's picture, as the desktop holds it.
 *
 * The artwork is not copied into the app: the desktop keeps it, and the phone asks
 * for it. The bytes travel base64-encoded inside one frame, so the phone can show
 * the very image the desktop shows without hosting a copy of its own.
 */
export interface OpBotAvatar {
  botId: string;
}

export interface OpBotAvatarResult {
  botId: string;
  /** `image/png`, `image/jpeg`, `image/webp` or `image/gif`. */
  mime: string;
  /** The image bytes, base64-encoded. */
  data: string;
  /** Whether this is the Bot's own picture or the artwork of the look it wears. */
  source: 'avatar' | 'skin';
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
  /**
   * The turn this message belongs to.
   *
   * A turn the desktop's own engine runs is one record on the desktop that holds the
   * whole exchange, so it reaches the phone as several messages. They share one turn
   * id, which is what lets the phone group them with the tool calls that turn made.
   */
  turnId?: string;
  /**
   * Where the message was written.
   *
   * The desktop marks a message that arrived from somewhere else, and the phone marks
   * one that was typed on the desktop, so each surface can say which is which.
   */
  origin?: 'phone' | 'desktop';
}

/**
 * One tool call inside a turn.
 *
 * The desktop's own transcript records which tools a turn used and how each of them
 * ended, and this carries that record to the phone.
 */
export interface TurnActivity {
  /** The turn this call belongs to. */
  turnId: string;
  /** Identifies this one call. */
  callId: string;
  toolName: string;
  /**
   * How the call ended.
   *
   * `unknown` means the desktop never saw the call report back, which is not the same
   * as a failure. `running` means the turn was cut short while the call was still going.
   */
  status: 'running' | 'ok' | 'failed' | 'unknown';
  /** Epoch ms the call began, when the turn's own record carries a time for it. */
  startedAt?: number;
  /** How long the call took, when the turn's own record carries a time for it. */
  durationMs?: number;
  error?: string;
}

/**
 * The state of a dispatched task.
 *
 * These are the states the team's task dispatcher actually reports. A phone that
 * showed a narrower set would have to guess what "waiting_for_tasks" means, so the
 * protocol carries the team's vocabulary instead of a lossy summary of it.
 */
export type TaskState =
  | 'queued'
  | 'running'
  | 'waiting_for_tasks'
  | 'waiting_for_user'
  | 'paused'
  | 'unknown'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Task {
  taskId: string;
  state: TaskState;
  title?: string;
  botIds?: string[];
  progress?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  /** The batch this task was dispatched in. */
  batchId?: string;
  /** `bot` or `discussion`. */
  kind?: string;
  chatId?: string;
  /** The message the task's answer was committed as. */
  resultMessageId?: string;
  /** The task's answer, when the team has produced one. */
  result?: string;
}

/** The state of a background helper. */
export type HelperState =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'interrupted'
  | 'blocked';

export interface Helper {
  helperId: string;
  title?: string;
  state: HelperState;
  lastRunAt?: number;
  nextRunAt?: number;
  detail?: string;
  /** The Bot the helper runs for, by name. */
  bot?: string;
  /** How long the helper ran, in seconds. */
  seconds?: number;
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
  /**
   * The conversation the request belongs to.
   *
   * A phone shows a request where it was asked, not in a list elsewhere: the thread
   * that is waiting for the answer is the one that has to carry the buttons.
   */
  chatId?: string;
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
  /** The conversation the question was asked in. */
  chatId?: string;
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
  /**
   * Id the client chose for this message.
   *
   * The bridge echoes it back as the committed message id, so the phone can show the
   * message the instant it is sent and replace it in place when the desktop confirms
   * it, without guessing which bubble to reconcile.
   */
  clientMessageId?: string;
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
  /**
   * The idempotency key the team uses to de-duplicate a dispatch.
   *
   * The bridge generates one when the client does not supply it, so a retry of the
   * same request never creates a second batch.
   */
  requestId?: string;
}

export interface OpDispatchResult {
  taskIds: string[];
  batchId?: string;
  requestId?: string;
  complete?: boolean;
}

/**
 * A task query.
 *
 * The team's task tool answers for one batch or one task at a time — there is no
 * "list everything" call. A client that wants the whole picture names the batch it
 * is interested in; a client that names neither gets every batch the bridge knows.
 */
export interface OpListTasks {
  taskId?: string;
  batchId?: string;
  /** How long the team may wait for the tasks to settle, up to 20 000 ms. */
  waitMs?: number;
  /** Where in the answer to start reading. */
  resultOffset?: number;
}

export interface OpListTasksResult {
  tasks: Task[];
  /** The batches the answer was read from. */
  batchIds?: string[];
  /**
   * True when the list only covers the batches the bridge has seen, which is the
   * case whenever the team dispatched work without the bridge.
   */
  partial?: boolean;
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
  /** The topic to read, when the client is looking for one specific topic. */
  key?: string;
  offset?: number;
  textOffset?: number;
  scope?: MemoryScope;
}

export interface OpRecallResult {
  entries: MemoryEntry[];
}

/** Where a memory lives. */
export type MemoryScope = 'self' | 'team' | 'bot';

export interface OpRemember {
  /** The Bot the memory belongs to. Required: without a caller, "self" needs a target. */
  botId: string;
  text: string;
  /**
   * The topic the memory is filed under.
   *
   * The team's memory tool insists on a topic: a memory is either filed under a
   * topic or replaces an existing entry. The bridge generates a topic when the
   * client does not name one.
   */
  key?: string;
  /** The entry to replace, instead of filing under a topic. */
  replaceId?: string;
  scope?: MemoryScope;
  pinned?: boolean;
  source?: string;
}

export interface OpRememberResult {
  /** The id of the entry that was written. */
  id?: string;
  /** The topic it was filed under. */
  key?: string;
  scope?: string;
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
  /** How hard the Bot works: `default`, `high`, `low`. */
  effort?: string;
  main?: boolean;
}

export interface OpDeleteBot {
  botId: string;
}

/**
 * Where a Bot's turn runs when the phone sends it a message.
 *
 * `team` runs the turn in the team's own engine: the Bot answers there, and the
 * desktop Bot app keeps the whole exchange. `hosted` runs it on the desktop under the
 * bridge, in the Bot's own session, so that a permission check or a questionnaire the
 * Bot raises can be answered from the phone — the Host only lets the Mini App that
 * owns a run answer its questions.
 */
export type BotRunMode = 'team' | 'hosted';

export interface OpSetBotMode {
  botId: string;
  mode: BotRunMode;
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
  /**
   * The tool calls the conversation's turns made.
   *
   * The messages alone would leave a cold start without the work a turn did, so the
   * calls travel with them: the phone then shows the same conversation whether it was
   * there for the turn or opened it afterwards.
   */
  activity?: TurnActivity[];
}

/**
 * One model the desktop's Host offers.
 *
 * The list comes from the Host itself, so the phone offers what can actually run: a
 * model that is not in the catalog cannot be picked, and a model cannot be asked for
 * an effort it does not have.
 */
export interface ModelOption {
  /** `providerId/modelId` — the id the team tool takes. */
  id: string;
  /** The name the desktop shows. */
  name: string;
  providerId: string;
  modelId: string;
  /** The reasoning efforts this model offers, in the Host's own order. */
  efforts: string[];
  /** The model's own default effort, when it has one. */
  defaultEffort?: string;
}

/** The Host's model catalog. */
export interface ModelCatalog {
  /** False on a Host that does not let a run pick its model. */
  supported: boolean;
  /** The model a Bot runs on when it has none of its own. */
  default?: ModelOption;
  models: ModelOption[];
}

export interface OpListModels {}

/**
 * One thing the desktop can be asked to use.
 *
 * A skill is invoked by name — the desktop writes it as `/name` — a plugin is a Mini
 * App the desktop runs, and an agent is a worker the desktop can hand a task to.
 */
export interface CapabilityItem {
  /** The name it is called by. */
  id: string;
  /** The name the desktop shows. */
  name: string;
  description?: string;
  /** Where it lives on the desktop. */
  source?: string;
  /** The version of a plugin. */
  version?: string;
}

/** What the desktop can do beyond answering in a chat. */
export interface Capabilities {
  skills: CapabilityItem[];
  plugins: CapabilityItem[];
  agents: CapabilityItem[];
  /** The MCP servers a Bot's turn can call tools on. */
  mcp: CapabilityItem[];
}

export interface OpListCapabilities {}

/** Every operation the client can request, keyed by its frame type. */
export interface OpPayloadMap {
  'op.list_team': OpListTeam;
  'op.bot_avatar': OpBotAvatar;
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
  'op.set_bot_mode': OpSetBotMode;
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
  'op.list_models': OpListModels;
  'op.list_capabilities': OpListCapabilities;
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
  /**
   * Epoch ms the turn began.
   *
   * A turn can run for a long time, so the phone shows how long it has been running.
   * It is the bridge's own clock, because the desktop's stream of a running turn is
   * not readable.
   */
  startedAt?: number;
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
  /**
   * Identifies this one call.
   *
   * The same tool can run twice in the same turn, and the host does not name the two
   * calls apart, so the bridge numbers them. A finish carries the number of the call it
   * belongs to, which is what lets a client match the two.
   */
  callId: string;
}

export interface EvtToolFinished {
  chatId: string;
  turnId: string;
  toolName: string;
  /** The call this finish belongs to. */
  callId: string;
  ok: boolean;
  /**
   * How the call ended, when that is more than a yes or a no.
   *
   * `unknown` means the turn ended before the call reported back, which is neither a
   * success nor a failure. The phone shows the same state it shows after the thread is
   * read back, so both views agree.
   */
  status?: 'ok' | 'failed' | 'unknown';
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
  'op.bot_avatar',
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
  'op.set_bot_mode',
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
  'op.list_models',
  'op.list_capabilities',
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
 * Checks a client-chosen message id.
 *
 * The bridge accepts the id and stores it as the committed message id, so it is
 * restricted to a short, unambiguous set of characters and a bounded length. A client
 * that sends anything else simply gets an id chosen for it.
 */
export function isValidClientMessageId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Maps an operation to the team tool that implements it.
 *
 * The bridge prefers this table to reach a tool, and falls back to a name match on
 * `mcp__minimax-bot__<tool>`. Keeping it here means the client, the relay and the bridge
 * agree on which tool backs which operation.
 */
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
} as const satisfies Partial<Record<OpType, string>>;

/**
 * Operations the bridge routes to the team by the chat the turn belongs to.
 *
 * A turn is addressed to a Bot or to a group, and the chat id says which. The bridge
 * hands the turn to the team itself, so the Bot that answers is the Bot the phone
 * picked — with that Bot's own instructions, model, effort and session.
 */
export const TEAM_ROUTED_OPS: readonly OpType[] = ['op.send_message', 'op.abort_turn'];

/**
 * Operations the bridge answers from its own agent rather than from a team tool.
 *
 * These are the Host's own questions — a tool call waiting for a decision, a
 * questionnaire waiting for an answer — which only the agent that started the turn can
 * answer.
 */
export const AGENT_BACKED_OPS: readonly OpType[] = ['op.respond_permission', 'op.answer_question'];

/**
 * Operations the bridge answers itself, without a team tool and without the agent.
 *
 * Together with {@link OP_TOOL}, {@link TEAM_ROUTED_OPS} and {@link AGENT_BACKED_OPS}
 * this accounts for every operation, so a consumer can ask "how is this op served?" and
 * get an answer.
 */
export const BRIDGE_LOCAL_OPS: readonly OpType[] = [
  'op.get_usage',
  'op.react',
  'op.list_history',
  'op.bot_avatar',
  'op.set_bot_mode',
  'op.list_models',
  'op.list_capabilities',
];

/**
 * The team tools that run a turn.
 *
 * `message_bot` hands work to a Bot and runs it in that Bot's own chat; `post_group`
 * posts to a group and runs the group's discussion. The bridge calls them itself, on
 * the phone's behalf, so the Bot that answers is the Bot the phone picked.
 */
export const TURN_ROUTING_TOOLS = ['message_bot', 'post_group'] as const;

/**
 * How the chat a turn belongs to decides which team tool runs it.
 *
 * `bot:` is a Bot's own private chat and `group:` is a group. The bridge reads the
 * prefix of the chat id and calls the matching tool, so the client, the relay and the
 * bridge agree on where a turn goes.
 */
export const CHAT_ROUTING = {
  'bot:': 'message_bot',
  'group:': 'post_group',
} as const satisfies Record<string, (typeof TURN_ROUTING_TOOLS)[number]>;

/**
 * Every operation is either tool backed, team routed, agent backed or answered by the
 * bridge.
 *
 * If an operation is added to {@link OP_TYPES} and none of the four, this fails to
 * compile — which is the point. The conditional is deliberately not distributive, so
 * that an empty union resolves to `true` rather than to `never`.
 */
type UnclassifiedOp = Exclude<
  OpType,
  | keyof typeof OP_TOOL
  | (typeof TEAM_ROUTED_OPS)[number]
  | (typeof AGENT_BACKED_OPS)[number]
  | (typeof BRIDGE_LOCAL_OPS)[number]
>;
const _everyOpIsClassified: [UnclassifiedOp] extends [never] ? true : never = true;
void _everyOpIsClassified;

/**
 * The complete `@minimax-bot` team tool surface: 21 tools.
 *
 * Every tool the MCP server exposes is either client-invokable ({@link OP_TOOL}) or
 * runs a turn ({@link TURN_ROUTING_TOOLS}). A tool that appears in neither would be
 * unreachable, and one appearing in both would be ambiguous.
 */
export const TEAM_TOOLS = [...Object.values(OP_TOOL), ...TURN_ROUTING_TOOLS] as const;
