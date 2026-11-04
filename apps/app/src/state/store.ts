/**
 * Application state.
 *
 * The phone is a projection of the desktop's truth: every mutation is a request to the
 * bridge, and the screen updates when the bridge's event comes back. The store keeps an
 * bounded outbox until acknowledgement. A socket write is not proof of execution;
 * unacknowledged writes become recoverable uncertainty, not an exactly-once promise.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Frame, QuestionAnswer, TurnActivity } from '@minimax-bot/protocol';
import { MAX_ACTIVITY_CALLS, trimTurnActivity, turnOrderOf } from '@minimax-bot/protocol';
import { create } from 'zustand';
import { validPendingRequest } from './render-requests';
import { LOCAL_RECOVERY_LIMIT, localRecovery, own, retainMessages, validChatId, validMessage } from './retention';

import { CLOSE_DEVICE_REVOKED, RelayClient, type ConnectionStatus } from '../net/relay-client';
import { isValidRelayUrl, relayOrigin } from '../net/relay-url';
import { releaseDevice } from '../net/release';
import {
  clearDeviceToken,
  loadDeviceOrigin,
  loadDeviceBinding,
  loadDeviceToken,
  saveDeviceToken,
  saveLastRelayUrl,
} from './credential-store';

export interface Session {
  relayUrl: string;
  accountId: string;
  deviceId: string;
  deviceToken: string;
  deviceName: string;
  /** Random credential-generation identity; no token is persisted in the outbox. */
  ownerId?: string;
}

/**
 * The session as it is kept on disk: everything but the token.
 *
 * The token is only here for a phone that paired before it moved to the
 * keystore, and it is written out again without it the first time it is read.
 */
interface StoredSession {
  relayUrl: string;
  accountId: string;
  deviceId: string;
  deviceName: string;
  deviceToken?: string;
  ownerId?: string;
}

export interface OutboxItem {
  opId: string;
  type: string;
  payload: unknown;
  queuedAt: number;
  /**
   * The account the operation was composed for.
   *
   * The phone holds one credential at a time, so an operation that belongs to
   * another account can never be delivered: the room it was written for is
   * reached with a credential this phone does not have. The outbox survives a
   * dropped session, so without this the next account's connection would flush it.
   */
  accountId: string;
  origin?: string;
  deviceId?: string;
  ownerId?: string;
  /** Set BEFORE a socket write. Such an item is never blindly redispatched. */
  sentAt?: number;
  expiresAt?: number;
  /** Quarantined answers are retained for reconciliation only, never dispatched. */
  decisionUncertain?: boolean;
  /** Recovery-only records are restored as failed bubbles, never dispatched. */
  deliveryError?: string;
  deliveryUncertain?: boolean;
  retryable?: boolean;
}

export interface ChatDraft { text: string; mentions: string[] }

export interface AppState {
  session: Session | null;
  /** Non-secret authority/lifecycle epoch; changes on owner changes and explicit logout. */
  ownerGeneration: number;
  status: ConnectionStatus;
  lastError: string | null;
  bridgeOnline: boolean;
  /** Whether the relay has said whether a desktop is attached. */
  desktopKnown: boolean;

  bots: AppBot[];
  groups: AppGroup[];
  tools: AppTool[];
  diagnostics: Diagnostics;

  /**
   * The pictures the desktop sent, by Bot id, as data URIs.
   *
   * The artwork is not part of the app: the desktop keeps it and the phone asks for
   * it. What arrives is held here for as long as the phone is open, so a Bot is
   * drawn once, not once per screen.
   */
  pictures: Record<string, string>;

  messages: Record<string, AppMessage[]>;
  /**
   * The tool calls of the current turn, per chat.
   *
   * The bridge reports every tool the team runs. The phone keeps them so the chat can
   * show what the team is doing while it works, instead of a long silence.
   */
  activity: Record<string, AppActivity[]>;
  /** The turn each chat is currently running. */
  activeTurn: Record<string, string>;
  /** When the turn each chat is running began, so the phone can say how long it runs. */
  turnStartedAt: Record<string, number>;
  /** Reactions per message id. */
  reactions: Record<string, AppReaction[]>;
  tasks: AppTask[];
  /**
   * Why the task list may be incomplete.
   *
   * The team's task tool answers for one batch at a time, so a list rebuilt from the
   * batches the bridge knows never covers work the team dispatched on its own. The
   * phone says so rather than showing a list that looks complete.
   */
  tasksNote: string | null;
  helpers: AppHelper[];
  schedules: AppSchedule[];
  approvals: AppPermission[];
  /**
   * The decisions this phone has already given, by request id.
   *
   * The approval stays on screen until the desktop says it is resolved, so the phone
   * has to remember that it already answered it: otherwise the approve control is
   * still there after the tap, and a second tap sends a second answer.
   */
  decided: Record<string, string>;
  /**
   * The operation each decision was sent with, by request id.
   *
   * A decision the desktop refused has to be given back, and the refusal names the
   * operation and not the request, so the phone needs the link between them.
   */
  decidedOps: Record<string, string>;
  questions: AppQuestion[];
  usage: AppUsage | null;

  /**
   * Text a screen wants put into the composer of a conversation.
   *
   * The toolbox knows what the desktop can do but not what the user wants to say about
   * it, so a picked skill travels to the conversation as text waiting in the composer.
   * The token tells the conversation that this is a new insertion, so the same skill
   * can be picked twice.
   */
  composerInsert: { chatId: string; text: string; token: number } | null;
  drafts: Record<string, ChatDraft>;
  setDraft: (chatId: string, draft: ChatDraft) => void;
  consumeComposerInsert: (token: number) => AppState['composerInsert'];
  clearError: () => void;
  retryMessage: (chatId: string, messageId: string) => boolean;

  outbox: OutboxItem[];
  /**
   * The pending bubble behind each `opId`.
   *
   * Refusals settle the pending bubble in place with recoverable text and a
   * guarded retry, rather than deleting the user's only copy.
   */
  optimisticByOp: Record<string, { messageId: string; chatId: string }>;
  pendingOp: Record<
    string,
    {
      type: string;
      payload: unknown;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >;

  setSession: (session: Session | null) => void;
  setStatus: (status: ConnectionStatus) => void;
  setError: (message: string | null) => void;
  applyFrame: (frame: Frame) => void;
  request: (type: string, payload: unknown) => string;
  requestAsync: (type: string, payload: unknown) => Promise<unknown>;
  /**
   * Sends a chat message and shows it immediately.
   *
   * The desktop owns the thread, so the message is shown as a pending bubble and
   * reconciled when the desktop commits it. The client chooses the message id and the
   * bridge echoes it back, so the committed message replaces the bubble in place.
   */
  sendChatMessage: (chatId: string, text: string, mentions?: string[]) => void;
  /** Adds a reaction to a message. The bridge confirms it with `evt.reaction_added`. */
  react: (messageId: string, emoji: string) => void;
  /**
   * Answers a permission request.
   *
   * The decision is recorded before it is sent, so the approve control is disabled
   * straight away. A second tap would otherwise send a second answer for the same
   * request, and the desktop would refuse it.
   */
  respondPermission: (requestId: string, decision: 'allowOnce' | 'deny') => void;
  /**
   * Answers a questionnaire.
   *
   * The answer is sent in the shape the run that is waiting for it expects: every step
   * the question asked, with the options that were chosen and the free-text answer if
   * one was typed.
   */
  answerQuestion: (requestId: string, answers: QuestionAnswer[]) => void;
  /**
   * Changes how a Bot's turns run when the phone sends one.
   *
   * `team` runs the turn in the team's own engine, where the desktop Bot app keeps the
   * whole exchange. `hosted` runs it on the desktop under the bridge, so a permission
   * check or a questionnaire the Bot raises can be answered from the phone.
   */
  setBotMode: (botId: string, mode: 'team' | 'hosted') => void;
  /**
   * Changes a Bot's own settings: what it is for, what it may do and how hard it works.
   *
   * The team owns these: the change is made on the Bot itself, not on a copy the phone
   * keeps.
   */
  updateBot: (
    botId: string,
    changes: {
      name?: string;
      role?: string;
      instructions?: string;
      model?: string;
      effort?: string;
    },
  ) => void;
  /**
   * Puts text into the composer of a conversation.
   *
   * Nothing is sent: the text waits for the user, because a skill or a plugin is a
   * thing the desktop can do, and what to ask of it is the user's call.
   */
  insertIntoComposer: (chatId: string, text: string) => void;
  flushOutbox: () => void;
  /** Re-reads everything the phone can show: the roster, tasks, helpers and schedules. */
  refreshTeam: () => void;
  /**
   * Asks the desktop for a Bot's picture.
   *
   * The desktop holds the only copy of the artwork, so the picture is fetched over
   * the link and kept in {@link pictures}. A Bot the desktop has no picture for keeps
   * its drawn octopus — a missing picture is never a broken frame.
   */
  loadBotPicture: (botId: string) => void;
  /**
   * How many times the phone has had to rebuild its view of the conversation.
   *
   * A screen that shows a conversation watches this: the projection is dropped
   * when the phone learns it has a hole, so the screen has to read the thread
   * again rather than show an empty one until it is opened afresh.
   */
  resyncCount: number;
}

export interface AppBot {
  botId: string;
  name: string;
  role?: string;
  skin?: string;
  color?: string;
  /** The Bot's own picture, when the desktop knows one the phone can load. */
  avatar?: string;
  description?: string;
  model?: string;
  isMain?: boolean;
  /** The Bot's face, e.g. `happy`. */
  face?: string;
  /** What the Bot is for, in the Bot's own words. */
  instructions?: string;
  /** Reasoning effort, e.g. `high`. */
  effort?: string;
  /**
   * Where this Bot's turns run when the phone sends one.
   *
   * `team` runs them in the team's own engine; `hosted` runs them on the desktop under
   * the bridge, so a permission check or a questionnaire the Bot raises can be
   * answered from the phone.
   */
  runMode?: 'team' | 'hosted';
}

export interface AppGroup {
  groupId: string;
  name: string;
  admin?: string;
  memberIds: string[];
  notice?: string;
  replyMode?: 'admin' | 'all';
}

export interface AppTool {
  name: string;
  server: string;
  tool: string;
  description?: string;
}

export interface Diagnostics {
  agentAvailable: boolean;
  teamToolsAvailable: boolean;
  toolCount: number;
  partial: boolean;
  reason?: string;
}

export interface AppMessage {
  messageId: string;
  chatId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  ts: number;
  authorId?: string;
  toolName?: string;
  pending?: boolean;
  /** Correlates late replies without retaining an unbounded completed-operation map. */
  deliveryOpId?: string;
  deliveryError?: string;
  deliveryUncertain?: boolean;
  retryable?: boolean;
  mentions?: string[];
  /**
   * The turn this message belongs to.
   *
   * A turn the desktop's own engine runs is one record on the desktop that holds the
   * whole exchange, so it reaches the phone as several messages. They share one turn
   * id, which is what groups them with the tool calls that turn made.
   */
  turnId?: string;
  /** Set when the message was written on the desktop rather than on the phone. */
  origin?: 'desktop';
}

export interface AppTask {
  taskId: string;
  state: string;
  title?: string;
  botIds?: string[];
  updatedAt: number;
}

export interface AppHelper {
  helperId: string;
  title?: string;
  state: string;
  lastRunAt?: number;
  nextRunAt?: number;
}

export interface AppSchedule {
  scheduleId: string;
  name: string;
  kind: string;
  spec: string;
  enabled: boolean;
  nextRunAt?: number;
}

export interface AppPermission {
  requestId: string;
  sessionId: string;
  turnId?: string;
  /** The conversation the request was raised in, so it can be shown there. */
  chatId?: string;
  toolName: string;
  toolInput?: string;
  reason: string;
}

export interface AppQuestion {
  requestId: string;
  sessionId: string;
  /** The conversation the question was asked in, so it can be shown there. */
  chatId?: string;
  title?: string;
  steps: {
    id: string;
    header?: string;
    question: string;
    description?: string;
    selectionMode: 'single' | 'multiple';
    options: { id: string; label: string; description?: string }[];
  }[];
}

export interface AppUsage {
  buckets: { key: string; label: string; turns: number; chars: number; tools: number }[];
  byBot: { botId: string; name: string; turns: number; chars: number; tools: number }[];
  totals: { turns: number; chars: number; tools: number; durationMs: number; errors: number };
}

/**
 * One tool call inside a turn.
 *
 * The bridge reports every tool the team runs, so the phone can show the work and not
 * only its result: which tool ran, how long it took, and whether it failed.
 */
export interface AppActivity {
  id: string;
  chatId: string;
  turnId: string;
  toolName: string;
  /**
   * `running` until the tool reports back.
   *
   * `unknown` means the turn ended before the tool reported at all, which is neither a
   * success nor a failure.
   */
  status: 'running' | 'ok' | 'failed' | 'unknown';
  /** When the call began, when that is known. */
  startedAt?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Keeps the activity list within its limit.
 *
 * The rule is the bridge's rule, because the two keep the same calls: the phone would
 * otherwise drop what the bridge sent, and the two would disagree about how many tools
 * a turn used. A turn is kept whole — a turn that showed only some of its calls would
 * say that the Bot used fewer tools than it did — so whole turns go, the oldest first,
 * and the newest turn stays whatever the limit says.
 *
 * @param list the calls of the chat
 * @param messages the thread of the chat, which knows the order of the turns
 */
function trimActivity(list: AppActivity[], messages: AppMessage[] = []): AppActivity[] {
  return trimTurnActivity(
    list,
    MAX_ACTIVITY_CALLS,
    turnOrderOf(messages),
    // A turn that is still running stays: it is the truth about what the team is doing.
    (turnId) => list.some((entry) => entry.turnId === turnId && entry.status === 'running'),
  );
}

/** How many reactions are kept per message. */
const REACTION_LIMIT = 12;

/** One reaction on one message. */
export interface AppReaction {
  messageId: string;
  emoji: string;
  count: number;
}

const SESSION_KEY = 'minimax-bot.session';
const OUTBOX_KEY = 'minimax-bot.outbox';
/** How long an operation may wait for its answer before the caller is told it timed out. */
const OP_TIMEOUT_MS = 20_000;

let client: RelayClient | null = null;

/** The operation type behind each `opId`, so an answer can be applied to the right list. */
const opTypes = new Map<string, string>();

/**
 * Asks the desktop for the picture of every Bot on the roster.
 *
 * The artwork lives on the desktop, so it is fetched per Bot, once: the answer is
 * kept in the store, and a Bot that already has its picture is not asked again.
 */
function requestPictures(bots: AppBot[]): void {
  for (const bot of bots) {
    useAppStore.getState().loadBotPicture(bot.botId);
  }
}

/**
 * Applies the answer to a read operation to the store.
 *
 * The bridge answers a read with the data; the phone is a projection of that data, so
 * the answer is what the screen renders.
 */
function applyOperationResult(
  result: unknown,
  type: string | undefined,
  payload: unknown,
  baseline: AppMessage[] = [],
): void {
  if (!result || typeof result !== 'object') return;
  const data = result as Record<string, any>;
  const state = useAppStore.getState();

  switch (type) {
    case 'op.list_team':
      useAppStore.setState({
        bots: Array.isArray(data.bots) ? data.bots : state.bots,
        groups: Array.isArray(data.groups) ? data.groups : state.groups,
        tools: Array.isArray(data.tools) ? data.tools : state.tools,
        diagnostics: data.diagnostics ? { ...state.diagnostics, ...data.diagnostics } : state.diagnostics,
      });
      // The roster names the look each Bot wears; the picture behind it is asked for
      // separately, because it is bytes rather than a field.
      requestPictures(useAppStore.getState().bots);
      return;
    case 'op.list_tasks':
      useAppStore.setState({
        tasks: Array.isArray(data.tasks) ? data.tasks : state.tasks,
        tasksNote: typeof data.note === 'string' ? data.note : null,
      });
      return;
    case 'op.list_helpers':
      useAppStore.setState({ helpers: Array.isArray(data.helpers) ? data.helpers : state.helpers });
      return;
    case 'op.list_schedules':
      useAppStore.setState({
        schedules: Array.isArray(data.schedules) ? data.schedules : state.schedules,
      });
      return;
    case 'op.list_history': {
      const chatId = (payload as { chatId?: string } | undefined)?.chatId;
      if (!validChatId(chatId) || !Array.isArray(data.messages)) return;
      const before = new Map(baseline.map(m => [m.messageId, m]));
      const merged = new Map<string, AppMessage>(data.messages.filter(validMessage).filter((m: AppMessage) => m.chatId === chatId).map((m: AppMessage) => [m.messageId, m]));
      for (const m of own(state.messages, chatId) ?? []) {
        if (localRecovery(m) || before.get(m.messageId) !== m) merged.set(m.messageId, m);
      }
      const messages = [...merged.values()].sort((a, b) => a.ts - b.ts);
      // The desktop owns the reaction counts, so they arrive with the thread. Without
      // them the chips would vanish on a restart while the desktop kept counting.
      const reactions = Array.isArray(data.reactions) ? (data.reactions as AppReaction[]) : [];
      const byMessage: Record<string, AppReaction[]> = Object.create(null);
      for (const reaction of reactions) {
        if (!reaction?.messageId || !reaction?.emoji) continue;
        const list = own(byMessage, reaction.messageId) ?? [];
        list.push(reaction);
        byMessage[reaction.messageId] = list;
      }
      // The calls the conversation's turns made travel with the thread, so that a chat
      // opened after the fact shows the same work the live view showed.
      const activity = Array.isArray(data.activity) ? (data.activity as TurnActivity[]) : [];
      const byId = new Map<string, AppActivity>();
      for (const entry of state.activity[chatId] ?? []) byId.set(entry.id, entry);
      for (const entry of activity) {
        if (!entry?.callId || !entry?.toolName || !entry?.turnId) continue;
        byId.set(entry.callId, {
          id: entry.callId,
          chatId,
          turnId: entry.turnId,
          toolName: entry.toolName,
          status: entry.status,
          ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
          ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
          ...(entry.error ? { error: entry.error } : {}),
        });
      }
      useAppStore.setState({
        messages: retainMessages({ ...state, messages: { ...state.messages, [chatId]: messages } }),
        activity: { ...state.activity, [chatId]: trimActivity([...byId.values()], messages) },
        reactions: { ...state.reactions, ...byMessage },
      });
      return;
    }
    case 'op.get_usage':
      if (data.totals) useAppStore.setState({ usage: data as AppUsage });
      return;
    default:
      return;
  }
}

/**
 * Writes the session down, or throws it away.
 *
 * Exported so the persistence can be tested without a running app.
 */
let sessionRevision = 0;
let sessionWrites: Promise<void> = Promise.resolve();
let knownOwner: Session | null = null;
function sameOwner(a: Session | null, b: Session | null): boolean {
  return !!a && !!b && relayOrigin(a.relayUrl) === relayOrigin(b.relayUrl) &&
    a.accountId === b.accountId && a.deviceId === b.deviceId && a.deviceToken === b.deviceToken;
}
function ownedSession(session: Session): Session {
  const ownerId = session.ownerId ?? (sameOwner(session, knownOwner) ? knownOwner?.ownerId : undefined) ??
    `owner_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
  knownOwner = { ...session, ownerId };
  return knownOwner;
}

export function persistSession(input: Session | null): Promise<void> {
  const revision = ++sessionRevision;
  const session = input ? ownedSession(input) : null;
  const result = sessionWrites.then(async () => {
    // Publish metadata LAST. A failed/obsolete credential replacement is never loadable.
    await AsyncStorage.removeItem(SESSION_KEY);
    if (revision !== sessionRevision) return;
    if (!session) { await clearDeviceToken(); return; }
    if (!isValidRelayUrl(session.relayUrl)) throw new Error('Invalid relay address.');
    const { deviceToken, ...rest } = session;
    await saveDeviceToken(deviceToken, relayOrigin(session.relayUrl), session);
    if (revision !== sessionRevision) return;
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(rest));
    if (revision !== sessionRevision) { await AsyncStorage.removeItem(SESSION_KEY); return; }
    await saveLastRelayUrl(session.relayUrl);
  });
  sessionWrites = result.catch(() => {});
  return result;
}

/**
 * Reads the session back.
 *
 * The relay address is checked again on the way in: a stored value that was
 * tampered with must not be able to send the device token to another host.
 */
export async function loadSession(): Promise<Session | null> {
  try {
    const barrier = sessionWrites;
    await barrier;
    if (barrier !== sessionWrites) return null;
    const revision = sessionRevision;
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredSession;
    if (!stored || typeof stored !== 'object') return null;

    if (typeof stored.relayUrl !== 'string' || !isValidRelayUrl(stored.relayUrl)) {
      // The address is not one the app may use, so the token is not used with it
      // either: the session is dropped and the phone has to pair again.
      if (revision === sessionRevision) await persistSession(null);
      return null;
    }

    let token = await loadDeviceToken();
    const origin = await loadDeviceOrigin();
    const binding = await loadDeviceBinding();
    const expectedOrigin = relayOrigin(stored.relayUrl);
    const legacy = !token && typeof stored.deviceToken === 'string' && stored.deviceToken.length > 0;
    if (legacy) token = stored.deviceToken!;
    if (!token) return null;
    // Only an actual legacy inline token may bootstrap a missing origin. Secure read
    // failures throw; neither plaintext metadata nor a fallback copy repairs them.
    if ((!legacy && origin !== expectedOrigin) || (origin && origin !== expectedOrigin) ||
      (binding && (binding.token !== token || binding.origin !== expectedOrigin ||
        binding.accountId !== stored.accountId || binding.deviceId !== stored.deviceId ||
        (stored.ownerId !== undefined && binding.ownerId !== stored.ownerId))) || (stored.ownerId && !binding)) {
      if (revision === sessionRevision) await persistSession(null);
      return null;
    }

    const session: Session = {
      relayUrl: stored.relayUrl,
      accountId: typeof stored.accountId === 'string' ? stored.accountId : 'default',
      deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : '',
      deviceName: typeof stored.deviceName === 'string' ? stored.deviceName : 'Phone',
      deviceToken: token,
      ...(stored.ownerId ? { ownerId: stored.ownerId } : {}),
    };
    if (revision !== sessionRevision || barrier !== sessionWrites) return null;
    if (legacy || !binding) {
      await persistSession(session);
      if (sessionRevision !== revision + 1) return null;
    }
    return ownedSession(session);
  } catch {
    return null;
  }
}

/**
 * Loads the outbox left over from a previous run.
 *
 * A message composed while the desktop was unreachable is in here. Without this it
 * would be lost the moment the app was closed.
 */
export async function loadOutbox(): Promise<OutboxItem[]> {
  try {
    await outboxWrites;
    const parse = (raw: string | null): OutboxItem[] => {
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      // Legacy entries without complete ownership cannot be safely attributed.
      return parsed.filter(entry => entry && typeof entry.opId === 'string' &&
        typeof entry.type === 'string' && typeof entry.ownerId === 'string' &&
        typeof entry.origin === 'string' && typeof entry.deviceId === 'string' &&
        typeof entry.accountId === 'string' && Number.isFinite(entry.queuedAt) &&
        (entry.sentAt === undefined || Number.isFinite(entry.sentAt)) &&
        (entry.expiresAt === undefined || Number.isFinite(entry.expiresAt)));
    };
    const records = parse(await AsyncStorage.getItem(OUTBOX_KEY));
    const active = records.filter(item => !item.deliveryError && !item.decisionUncertain).slice(-MAX_OUTBOX_ITEMS);
    const recovery = records.filter(item => item.type === 'op.send_message' &&
      typeof item.deliveryError === 'string').slice(-LOCAL_RECOVERY_LIMIT);
    const quarantined = records.filter(item => item.decisionUncertain === true && isDecision(item.type) &&
      typeof (item.payload as { requestId?: unknown })?.requestId === 'string').slice(-DECISION_LIMIT);
    return [...active, ...recovery, ...quarantined];
  } catch {
    return [];
  }
}

let outboxWrites: Promise<unknown> = Promise.resolve();
function persistOutbox(outbox: OutboxItem[]): Promise<boolean> {
  const state = useAppStore.getState();
  const session = state.session;
  const recovery = session ? Object.values(state.messages).flat().filter(m => m.role === 'user' && m.deliveryError)
    .slice(-LOCAL_RECOVERY_LIMIT).map(m => ({
      opId: m.deliveryOpId ?? `recovery_${m.messageId}`, type: 'op.send_message', queuedAt: m.ts,
      payload: { chatId: m.chatId, text: m.text, clientMessageId: m.messageId, mentions: m.mentions },
      accountId: session.accountId, origin: relayOrigin(session.relayUrl), deviceId: session.deviceId, ownerId: session.ownerId,
      deliveryError: m.deliveryError, deliveryUncertain: m.deliveryUncertain, retryable: m.retryable,
    })) : [];
  // One atomic record: removing a queued operation and saving its recovery text
  // cannot be interrupted between two keys.
  const quarantined: OutboxItem[] = session ? [...uncertainDecisions].map(([requestId, entry]) => ({
    ...entry, payload: { requestId }, queuedAt: Date.now(), accountId: session.accountId,
    origin: relayOrigin(session.relayUrl), deviceId: session.deviceId, ownerId: session.ownerId, decisionUncertain: true,
  })) : [];
  const raw = JSON.stringify([...outbox, ...recovery, ...quarantined]);
  const result = outboxWrites.then(() => AsyncStorage.setItem(OUTBOX_KEY, raw)).then(() => true, () => false);
  outboxWrites = result;
  return result;
}

/**
 * How many operations the phone keeps waiting to send.
 *
 * The queue survives a dropped session, so a phone that is offline for a long time
 * would otherwise grow it without bound and then deliver a week-old conversation in
 * one burst. The oldest goes first: the message a user just wrote is the one they are
 * waiting for.
 */
const MAX_OUTBOX_ITEMS = 100;

/**
 * Keeps the queue within its bound.
 *
 * @param outbox the queue as it would be
 * @returns the queue, oldest first, within the bound
 */
function boundedOutbox(outbox: OutboxItem[]): OutboxItem[] {
  return outbox.length > MAX_OUTBOX_ITEMS ? outbox.slice(outbox.length - MAX_OUTBOX_ITEMS) : outbox;
}

const DECISION_LIMIT = 200;
type DecisionType = 'op.respond_permission' | 'op.answer_question';
const isDecision = (type: string | undefined): type is DecisionType => type === 'op.respond_permission' || type === 'op.answer_question';
const uncertainDecisions = new Map<string, { opId: string; type: DecisionType }>();
const operationTimers = new Map<string, ReturnType<typeof setTimeout>>();
const operationReads = new Map<string, { payload: unknown; baseline?: AppMessage[] }>();
const latestHistory = new Map<string, string>();
let insertionToken = 0;
let accountGeneration = 0;

function itemOwnedBy(item: OutboxItem, session: Session | null): boolean {
  return !!session && !!item.ownerId && item.ownerId === session.ownerId &&
    item.origin === relayOrigin(session.relayUrl) && item.accountId === session.accountId && item.deviceId === session.deviceId;
}

function armOperation(opId: string, milliseconds = OP_TIMEOUT_MS): ReturnType<typeof setTimeout> {
  const previous = operationTimers.get(opId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    const item = useAppStore.getState().outbox.find(item => item.opId === opId);
    finishOperation(opId, possiblyWritten(item)
      ? 'Delivery is uncertain: the desktop did not confirm this request. Check the desktop before sending it again.'
      : 'The request timed out before it was sent. It will not be sent later.', possiblyWritten(item));
  }, Math.max(0, milliseconds));
  (timer as unknown as { unref?: () => void }).unref?.();
  operationTimers.set(opId, timer);
  return timer;
}

/** Settles all bookkeeping exactly once; late commits still reconcile by message id. */
function finishOperation(opId: string, error?: string, uncertain = false, retryable = true): void {
  const state = useAppStore.getState();
  const item = state.outbox.find(item => item.opId === opId);
  const pending = own(state.pendingOp, opId);
  const recovery = Object.values(state.messages).flat().find(m => m.deliveryOpId === opId && m.deliveryError);
  const optimistic = own(state.optimisticByOp, opId) ?? (recovery ? { chatId: recovery.chatId, messageId: recovery.messageId } : undefined);
  const quarantine = [...uncertainDecisions].find(([, entry]) => entry.opId === opId);
  if (!item && !pending && !optimistic && !quarantine && !opTypes.has(opId) && !Object.values(state.decidedOps).includes(opId)) return;
  const payload = (item?.payload ?? pending?.payload ?? (quarantine ? { requestId: quarantine[0] } : undefined)) as { requestId?: string } | undefined;
  const type = opTypes.get(opId) ?? item?.type ?? quarantine?.[1].type;
  const quarantined = !!error && uncertain && isDecision(type) && typeof payload?.requestId === 'string';
  if (quarantined) uncertainDecisions.set(payload!.requestId!, { opId, type: type as DecisionType });
  else if (quarantine) uncertainDecisions.delete(quarantine[0]);
  const timer = operationTimers.get(opId);
  if (timer) clearTimeout(timer);
  if (pending) clearTimeout(pending.timer);
  operationTimers.delete(opId);
  attemptedWrites.delete(opId);
  opTypes.delete(opId);
  operationReads.delete(opId);
  const pendingOp = { ...state.pendingOp };
  const optimisticByOp = { ...state.optimisticByOp };
  delete pendingOp[opId];
  delete optimisticByOp[opId];
  const decided = { ...state.decided };
  const decidedOps = { ...state.decidedOps };
  for (const [id, sent] of Object.entries(decidedOps)) {
    if (sent !== opId) continue;
    if (quarantined) decided[id] = 'uncertain';
    else { delete decided[id]; delete decidedOps[id]; }
  }
  if (quarantined) { decided[payload!.requestId!] = 'uncertain'; decidedOps[payload!.requestId!] = opId; }
  const messages = optimistic ? {
    ...state.messages,
    [optimistic.chatId]: (own(state.messages, optimistic.chatId) ?? []).map(m => m.messageId === optimistic.messageId
      ? { ...m, pending: false, deliveryOpId: error ? opId : undefined, deliveryError: error, deliveryUncertain: error ? uncertain : undefined, retryable: !!error && retryable && !uncertain }
      : m),
  } : state.messages;
  const outbox = state.outbox.filter(item => item.opId !== opId);
  useAppStore.setState({
    outbox, pendingOp, optimisticByOp, decided, decidedOps, messages,
    ...(!error && type === 'op.respond_permission' ? { approvals: state.approvals.filter(r => r.requestId !== payload?.requestId) } : {}),
    ...(!error && type === 'op.answer_question' ? { questions: state.questions.filter(r => r.requestId !== payload?.requestId) } : {}),
    ...(error ? { lastError: error } : {}),
  });
  void persistOutbox(outbox);
  if (error) pending?.reject(new Error(error));
}

function decisionProjection(state: AppState, requests: { requestId: string }[]) {
  const live = new Set(requests.map(r => r.requestId));
  const decided = Object.fromEntries(Object.entries(state.decided).filter(([id]) => live.has(id)));
  const decidedOps = Object.fromEntries(Object.entries(state.decidedOps).filter(([id]) => live.has(id)));
  for (const item of state.outbox) {
    const id = (item.payload as { requestId?: string })?.requestId;
    if (isDecision(item.type) && id && live.has(id)) {
      decided[id] ??= item.sentAt !== undefined ? 'uncertain' : 'pending';
      decidedOps[id] ??= item.opId;
    }
  }
  for (const [id, entry] of uncertainDecisions) {
    if (live.has(id)) { decided[id] = 'uncertain'; decidedOps[id] = entry.opId; }
  }
  return { decided, decidedOps };
}

function decisionBlocked(requestId: string): boolean {
  if (uncertainDecisions.has(requestId) || useAppStore.getState().outbox.some(item =>
    isDecision(item.type) && (item.payload as { requestId?: string })?.requestId === requestId)) return true;
  if (uncertainDecisions.size + useAppStore.getState().outbox.filter(item => isDecision(item.type)).length < DECISION_LIMIT) return false;
  useAppStore.getState().setError('Too many decisions have unconfirmed outcomes. Resolve them on the desktop before answering more.');
  return true;
}

function queueOperation(type: string, payload: unknown, asynchronous = false): string {
  const state = useAppStore.getState();
  const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  opTypes.set(opId, type);
  const chatId = (payload as { chatId?: string } | undefined)?.chatId;
  operationReads.set(opId, { payload, ...(type === 'op.list_history' && chatId ? { baseline: own(state.messages, chatId) ?? [] } : {}) });
  if (type === 'op.list_history' && chatId) {
    latestHistory.delete(chatId);
    latestHistory.set(chatId, opId);
    if (latestHistory.size > 1000) latestHistory.delete(latestHistory.keys().next().value!);
  }
  const session = state.session ? ownedSession(state.session) : null;
  if (session && !state.session?.ownerId) useAppStore.setState({ session });
  const expiresAt = type === 'op.send_message' && !asynchronous ? undefined : Date.now() + OP_TIMEOUT_MS;
  const item: OutboxItem = {
    opId, type, payload, queuedAt: Date.now(), accountId: session?.accountId ?? '',
    origin: session ? relayOrigin(session.relayUrl) : '', deviceId: session?.deviceId ?? '', ownerId: session?.ownerId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  // Eviction must settle the old operation, not leave a promise or pending bubble.
  for (const evicted of state.outbox.slice(0, Math.max(0, state.outbox.length + 1 - MAX_OUTBOX_ITEMS))) {
    finishOperation(evicted.opId, 'The delivery queue is full. This message was not confirmed.', possiblyWritten(evicted));
  }
  const outbox = boundedOutbox([...useAppStore.getState().outbox, item]);
  useAppStore.setState({ outbox });
  void persistOutbox(outbox);
  if (expiresAt !== undefined) armOperation(opId);
  useAppStore.getState().flushOutbox();
  return opId;
}

const dispatching = new Set<string>();
const attemptedWrites = new Set<string>();
function possiblyWritten(item: OutboxItem | undefined): boolean {
  return item?.sentAt !== undefined && (!dispatching.has(item.opId) || attemptedWrites.has(item.opId));
}
async function dispatchOutbox(): Promise<void> {
  const state = useAppStore.getState();
  if (!state.session) return;
  // Drop unattributable legacy entries even while disconnected; never guess their owner.
  for (const item of state.outbox) {
    if (!itemOwnedBy(item, state.session)) finishOperation(item.opId, 'The link that owned this request changed.');
  }
  const transport = client;
  if (!transport || state.status !== 'online' || !state.bridgeOnline || !state.desktopKnown) return;
  for (const item of useAppStore.getState().outbox) {
    if (item.deliveryError || dispatching.has(item.opId)) continue;
    if (item.sentAt !== undefined) {
      if (!operationTimers.has(item.opId)) armOperation(item.opId, item.sentAt + OP_TIMEOUT_MS - Date.now());
      continue;
    }
    if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) {
      finishOperation(item.opId, 'The request timed out before it was sent. It will not be sent later.');
      continue;
    }
    dispatching.add(item.opId);
    let wakeReplacement = false;
    try {
      const reserved = { ...item, sentAt: Date.now() };
      useAppStore.setState(s => ({ outbox: s.outbox.map(i => i.opId === item.opId ? reserved : i) }));
      // Journal possible delivery before writing: a process death must not turn a
      // possibly executed mutation back into an undisclosed future dispatch.
      const saved = await persistOutbox(useAppStore.getState().outbox);
      const current = useAppStore.getState();
      if (!current.outbox.includes(reserved)) continue;
      if (item.expiresAt !== undefined && item.expiresAt <= Date.now()) {
        finishOperation(item.opId, 'The request timed out before it was sent. It will not be sent later.');
        continue;
      }
      if (!saved) { finishOperation(item.opId, 'Could not save this request safely. It was not sent.'); continue; }
      const ready = client === transport && itemOwnedBy(item, current.session) && current.bridgeOnline && current.status === 'online';
      let sent = false;
      if (ready) {
        attemptedWrites.add(item.opId);
        sent = transport.send({ v: 1, id: `f_${item.opId}`, ts: Date.now(), type: item.type, source: 'app', payload: item.payload, opId: item.opId });
        if (!sent) attemptedWrites.delete(item.opId);
      }
      if (sent) armOperation(item.opId, Math.min(item.expiresAt ?? Infinity, Date.now() + OP_TIMEOUT_MS) - Date.now());
      else {
        useAppStore.setState(s => ({ outbox: s.outbox.map(i => i === reserved ? item : i) }));
        await persistOutbox(useAppStore.getState().outbox);
        wakeReplacement = client !== transport;
        break;
      }
    } finally {
      dispatching.delete(item.opId);
      // A replacement hello may have skipped this reservation. Wake it once, only
      // after definitely-unsent state is journaled and the dispatch guard is released.
      if (wakeReplacement) void Promise.resolve().then(() => {
        const current = useAppStore.getState();
        const queued = current.outbox.find(i => i.opId === item.opId);
        if (client && current.status === 'online' && current.bridgeOnline && current.desktopKnown &&
          queued && queued.sentAt === undefined && itemOwnedBy(queued, current.session)) current.flushOutbox();
      });
    }
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  session: null,
  ownerGeneration: 0,
  status: 'idle',
  lastError: null,
  bridgeOnline: false,
  /**
   * Whether the relay has said whether a desktop is attached.
   *
   * `bridgeOnline` alone cannot say that: it is false both when the relay has told
   * the phone that no desktop is attached and when the phone has not heard from the
   * relay yet. The two need different words on the screen — one is a problem the
   * user can fix, the other is a phone that is simply early.
   */
  desktopKnown: false,
  /**
   * How many times the phone has had to rebuild its view of the conversation.
   *
   * A screen that shows a conversation watches this: the projection is dropped
   * when the phone learns it has a hole, so the screen has to read the thread
   * again rather than show an empty one until it is opened afresh.
   */
  resyncCount: 0,

  bots: [],
  groups: [],
  tools: [],
  pictures: {},
  diagnostics: {
    agentAvailable: false,
    teamToolsAvailable: false,
    toolCount: 0,
    partial: false,
  },

  messages: {},
  activity: {},
  activeTurn: {},
  turnStartedAt: {},
  reactions: {},
  tasks: [],
  tasksNote: null,
  helpers: [],
  schedules: [],
  approvals: [],
  decided: {},
  decidedOps: {},
  questions: [],
  usage: null,
  composerInsert: null,
  drafts: {},

  outbox: [],
  optimisticByOp: {},
  pendingOp: {},

  setSession: (input) => {
    const previous = get();
    const session = input ? ownedSession(input) : null;
    if (!sameOwner(previous.session, session)) {
      accountGeneration += 1;
      disconnectRelay();
      for (const pending of Object.values(previous.pendingOp)) {
        clearTimeout(pending.timer);
        pending.reject(new Error('The account link changed.'));
      }
      for (const timer of operationTimers.values()) clearTimeout(timer);
      operationTimers.clear(); opTypes.clear(); operationReads.clear(); latestHistory.clear(); uncertainDecisions.clear(); attemptedWrites.clear();
      // A hydrated/recoverable queue is retained only for the exact credential owner.
      const records = !previous.session && session ? previous.outbox.filter(item => itemOwnedBy(item, session)) : [];
      const outbox = records.filter(item => !item.deliveryError && !item.decisionUncertain).slice(-MAX_OUTBOX_ITEMS);
      set({ ...useAppStore.getInitialState(), session, outbox, ownerGeneration: accountGeneration });
      const messages: Record<string, AppMessage[]> = {};
      const optimisticByOp: AppState['optimisticByOp'] = {};
      const decided: Record<string, string> = {};
      const decidedOps: Record<string, string> = {};
      for (const item of records) {
        const p = item.payload as { requestId?: string; chatId?: string; text?: string; clientMessageId?: string; mentions?: string[] } | undefined;
        if (isDecision(item.type) && typeof p?.requestId === 'string' && !['__proto__', 'constructor', 'prototype'].includes(p.requestId)) {
          decided[p.requestId] = item.decisionUncertain || item.sentAt !== undefined ? 'uncertain' : 'pending';
          decidedOps[p.requestId] = item.opId;
          if (item.decisionUncertain) uncertainDecisions.set(p.requestId, { opId: item.opId, type: item.type });
        }
        if (item.type !== 'op.send_message' || !validChatId(p?.chatId) || !p?.clientMessageId || typeof p.text !== 'string') continue;
        const message: AppMessage = { messageId: p.clientMessageId, chatId: p.chatId, role: 'user', text: p.text, ts: item.queuedAt,
          pending: !item.deliveryError, mentions: p.mentions, deliveryOpId: item.opId,
          deliveryError: item.deliveryError, deliveryUncertain: item.deliveryUncertain, retryable: item.retryable,
        };
        messages[p.chatId] = [...(own(messages, p.chatId) ?? []), message];
        if (!item.deliveryError) optimisticByOp[item.opId] = { chatId: p.chatId, messageId: message.messageId };
      }
      set({ messages, optimisticByOp, decided, decidedOps });
      for (const item of outbox) {
        const deadline = item.expiresAt ?? (item.sentAt === undefined ? undefined : item.sentAt + OP_TIMEOUT_MS);
        if (deadline !== undefined) armOperation(item.opId, deadline - Date.now());
      }
      void persistOutbox(outbox);
    } else set({ session });
    const persistence = persistSession(session);
    const revision = sessionRevision;
    void persistence.catch(() => {
      if (revision !== sessionRevision || get().session?.ownerId !== session?.ownerId) return;
      if (session) get().setSession(null);
      set({ lastError: 'Could not securely save or remove the account link. Unlock the device and pair again.' });
    });
  },

  setStatus: (status) => set({ status, ...(status !== 'online' ? { bridgeOnline: false, desktopKnown: false } : {}) }),
  setError: (message) => set({ lastError: message }),
  clearError: () => set({ lastError: null }),
  setDraft: (chatId, draft) => {
    if (!validChatId(chatId) || typeof draft.text !== 'string') return;
    const drafts = { ...get().drafts };
    if (!draft.text && !draft.mentions.length) delete drafts[chatId];
    else {
      if (!Object.hasOwn(drafts, chatId) && Object.keys(drafts).length >= 100) {
        set({ lastError: 'There are already 100 saved drafts. Clear one before starting another.' });
        return;
      }
      drafts[chatId] = { text: draft.text, mentions: [...draft.mentions] };
    }
    set({ drafts });
  },
  consumeComposerInsert: (token) => {
    const insertion = get().composerInsert;
    if (!insertion || insertion.token !== token) return null;
    set({ composerInsert: null });
    return insertion;
  },
  retryMessage: (chatId, messageId) => {
    const message = (own(get().messages, chatId) ?? []).find(m => m.messageId === messageId);
    if (!message || !message.deliveryError || !message.retryable || message.deliveryUncertain || message.pending) return false;
    set(state => ({ messages: { ...state.messages, [chatId]: state.messages[chatId]!.filter(m => m !== message) } }));
    get().sendChatMessage(chatId, message.text, message.mentions);
    return true;
  },

  request: (type, payload) => queueOperation(type, payload),

  requestAsync: (type, payload) => new Promise((resolve, reject) => {
    const opId = queueOperation(type, payload, true);
    const timer = operationTimers.get(opId)!;
    set(state => ({ pendingOp: { ...state.pendingOp, [opId]: { type, payload, resolve, reject, timer } } }));
  }),

  flushOutbox: () => { void dispatchOutbox(); },

  refreshTeam: () => {
    const state = get();
    if (!state.session) return;
    state.request('op.list_team', {});
    state.request('op.list_tasks', {});
    state.request('op.list_helpers', {});
    state.request('op.list_schedules', {});
  },

  loadBotPicture: (botId) => {
    const state = get();
    if (!botId || own(state.pictures, botId)) return;
    // A picture is only worth asking for while the desktop can answer. Offline, the
    // Bot keeps its drawn octopus until the desktop comes back.
    if (state.status !== 'online') return;

    const bot = state.bots.find((candidate) => candidate.botId === botId);
    // A Bot with no look and no picture of its own has nothing to fetch.
    if (!bot || (!bot.skin && !bot.avatar)) return;

    const generation = accountGeneration;
    void state
      .requestAsync('op.bot_avatar', { botId })
      .then((result) => {
        const data = result as { mime?: string; data?: string } | undefined;
        if (!data?.mime || !data.data || generation !== accountGeneration || !sameOwner(state.session, get().session)) return;
        set((current) => ({
          pictures: { ...current.pictures, [botId]: `data:${data.mime};base64,${data.data}` },
        }));
      })
      .catch(() => {
        // The desktop has no picture for this Bot. The drawn octopus stands in, and
        // asking again would only ask again.
      });
  },

  sendChatMessage: (chatId, text, mentions) => {
    const body = text.trim();
    if (!body || !validChatId(chatId)) return;
    if (Object.values(get().messages).flat().filter(localRecovery).length >= LOCAL_RECOVERY_LIMIT) {
      get().setDraft(chatId, { text, mentions: mentions ?? [] });
      set({ lastError: 'There are already 200 undelivered messages. Resolve one before sending more; your text is saved as a draft.' });
      return;
    }

    // The client picks the message id, so the bubble it shows now is the very message
    // the desktop commits later: the committed message replaces it in place, and a
    // send that fails can retain its own text with an explicit delivery error.
    const messageId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const message: AppMessage = {
      messageId,
      chatId,
      role: 'user',
      text: body,
      ts: Date.now(),
      pending: true,
      mentions: [...(mentions ?? [])],
    };
    set((state) => ({
      messages: { ...state.messages, [chatId]: [...(own(state.messages, chatId) ?? []), message] },
    }));

    // Who the message names. A group decides who speaks first by who is mentioned, so
    // the names travel with the message rather than being a line of text.
    const named = (mentions ?? []).filter((id) => typeof id === 'string' && id !== '');
    const opId = get().request('op.send_message', {
      chatId,
      text: body,
      ...(named.length ? { mentions: named } : {}),
      clientMessageId: messageId,
    });
    set((state) => ({
      optimisticByOp: { ...state.optimisticByOp, [opId]: { messageId, chatId } },
      messages: { ...state.messages, [chatId]: (own(state.messages, chatId) ?? []).map(m => m.messageId === messageId ? { ...m, deliveryOpId: opId } : m) },
    }));
  },

  react: (messageId, emoji) => {
    if (!messageId || !emoji) return;
    // The bridge owns the count, so the phone does not guess it: it asks, and the
    // bridge answers with `evt.reaction_added`.
    get().request('op.react', { messageId, emoji });
  },

  respondPermission: (requestId, decision) => {
    if (!requestId || ['__proto__', 'constructor', 'prototype'].includes(requestId)) return;
    // A decision that has already been given is not given again. The desktop claims
    // the request before it tells the Host, so a second answer for the same request
    // would be refused there; the phone does not send one.
    if (own(get().decided, requestId) || !get().approvals.some(r => r.requestId === requestId) || decisionBlocked(requestId)) return;
    const opId = get().request('op.respond_permission', { requestId, decision });
    set((state) => ({
      decided: { ...state.decided, [requestId]: decision },
      decidedOps: { ...state.decidedOps, [requestId]: opId },
    }));
  },

  answerQuestion: (requestId, answers) => {
    if (!requestId || ['__proto__', 'constructor', 'prototype'].includes(requestId)) return;
    // A question that has been answered is not answered again, for the same reason a
    // permission request is not decided twice.
    if (own(get().decided, requestId) || !get().questions.some(r => r.requestId === requestId) || decisionBlocked(requestId)) return;
    const opId = get().request('op.answer_question', { requestId, answers });
    set((state) => ({
      decided: { ...state.decided, [requestId]: 'answered' },
      decidedOps: { ...state.decidedOps, [requestId]: opId },
      // The question stays in the thread until the desktop says it was answered. If the
      // desktop refuses the answer, the question is still waiting for one and has to
      // stay on screen, so that it can be answered again.
    }));
  },

  setBotMode: (botId, mode) => {
    if (!botId) return;
    get().request('op.set_bot_mode', { botId, mode });
    // The roster carries the mode the desktop is using, so the phone shows the mode
    // that is really in force and not the one that was asked for.
    set((state) => ({
      bots: state.bots.map((bot) => (bot.botId === botId ? { ...bot, runMode: mode } : bot)),
    }));
  },

  updateBot: (botId, changes) => {
    if (!botId) return;
    const payload = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => typeof value === 'string' && value.trim() !== ''),
    );
    if (Object.keys(payload).length === 0) return;
    get().request('op.update_bot', { botId, ...payload });
    // The team owns the Bot, so the phone shows what it asked for and re-reads the
    // roster afterwards to show what the team actually did.
    set((state) => ({
      bots: state.bots.map((bot) => (bot.botId === botId ? { ...bot, ...payload } : bot)),
    }));
    get().refreshTeam();
  },

  insertIntoComposer: (chatId, text) => {
    const body = String(text ?? '').trim();
    if (!validChatId(chatId) || !body) return;
    set((state) => ({
      composerInsert: {
        chatId,
        text: body,
        // The token makes every insertion a new one, so the same skill can be picked
        // twice and the second one is not mistaken for the first.
        token: ++insertionToken,
      },
    }));
  },

  applyFrame: (frame) => {
    const state = get();
    // The envelope is typed loosely on purpose; the payload shape depends on the frame type.
    const p = (frame.payload ?? {}) as Record<string, any>;
    if (typeof p !== 'object' || Array.isArray(p) ||
      (p.chatId !== undefined && !validChatId(p.chatId)) ||
      (p.request?.chatId !== undefined && !validChatId(p.request.chatId)) ||
      (frame.type === 'evt.message_committed' && !validMessage(p.message)) ||
      (frame.type === 'evt.question_requested' && !validPendingRequest(p.request, true)) ||
      (frame.type === 'evt.permission_requested' && !validPendingRequest(p.request, false)) ||
      (frame.type === 'evt.message_chunk' && (!validChatId(p.chatId) || typeof p.text !== 'string' || typeof p.turnId !== 'string'))) {
      set({ lastError: 'The desktop sent an invalid conversation frame. Reconnect to refresh it.' });
      return false;
    }

    if (frame.type === 'ack') {
      const opId = typeof p.opId === 'string' ? p.opId : '';
      if (!opId) return;
      const pending = own(state.pendingOp, opId);
      const read = operationReads.get(opId);
      const type = opTypes.get(opId);
      const chatId = (read?.payload as { chatId?: string } | undefined)?.chatId;
      if (type !== 'op.list_history' || (chatId && latestHistory.get(chatId) === opId)) {
        applyOperationResult(p.result, type, read?.payload ?? pending?.payload, read?.baseline);
      }
      finishOperation(opId);
      pending?.resolve(p.result);
      return;
    }

    if (frame.type === 'err') {
      const message = typeof p.message === 'string' ? p.message : 'The request failed.';
      if (typeof p.opId === 'string') finishOperation(p.opId, message, p.code === 'AGENT_OUTCOME_UNKNOWN' || p.code === 'OUTCOME_UNKNOWN', p.retryable !== false);
      else set({ lastError: message });
      return;
    }

    if (frame.type === 'hello.ok') {
      set({ bridgeOnline: p.bridgeOnline === true, desktopKnown: true });
      if (p.truncated === true) {
        for (const item of get().outbox) {
          if (item.type !== 'op.send_message') finishOperation(item.opId, 'The desktop view was reset. Request fresh data before trying again.', possiblyWritten(item));
        }
        // The relay could not replay everything this phone missed, so its view has a
        // hole. The projection is dropped and rebuilt from a fresh read — including
        // the live trace, which would otherwise keep claiming that the team is working.
        set((state) => ({
          messages: Object.fromEntries(Object.entries(state.messages).map(([id, list]) => [id, list.filter(localRecovery)]).filter(([, list]) => list.length)),
          approvals: [], questions: [], decided: {}, decidedOps: {},
          tasks: [],
          helpers: [],
          schedules: [],
          bots: [],
          groups: [],
          activity: {},
          activeTurn: {},
          turnStartedAt: {},
          reactions: {},
          // The thread is read again by the screen that shows it: the projection
          // it was reading is the one that was just dropped, so without this the
          // open conversation would be empty until the screen was opened afresh.
          resyncCount: state.resyncCount + 1,
        }));
      }
      get().refreshTeam();
      return;
    }

    if (!frame.type.startsWith('evt.')) return;

    switch (frame.type) {
      case 'evt.team_snapshot': {
        // A group without members must not take the screen down with it, so the
        // roster is normalised before anything renders.
        const bots = Array.isArray(p.bots) ? (p.bots as AppBot[]) : [];
        const groups = Array.isArray(p.groups)
          ? (p.groups as AppGroup[]).map((group) => ({
              ...group,
              memberIds: Array.isArray(group.memberIds) ? group.memberIds : [],
            }))
          : [];
        set({
          bots,
          groups,
          tools: p.tools ?? [],
          diagnostics: p.diagnostics ?? state.diagnostics,
        });
        requestPictures(bots);
        break;
      }

      case 'evt.message_chunk': {
        const { chatId, turnId, text } = p as { chatId?: string; turnId?: string; text?: string };
        if (!chatId) break;
        const list = [...(state.messages[chatId] ?? [])];
        const index = list.findIndex(
          (message) => message.messageId === `msg_${turnId}` || (message.pending && message.role === 'assistant'),
        );
        if (index >= 0) {
          list[index] = { ...list[index], text: list[index]!.text + text };
        } else {
          list.push({
            messageId: `msg_${turnId}`,
            chatId,
            role: 'assistant',
            text: text ?? '',
            ts: Date.now(),
            pending: true,
          });
        }
        set({ messages: { ...state.messages, [chatId]: list } });
        break;
      }

      case 'evt.message_committed': {
        const message = p.message as AppMessage | undefined;
        if (!message) break;
        // The committed message replaces the pending bubble that carried the same id.
        if (message.role === 'user') {
          const next = { ...state.optimisticByOp };
          let changed = false;
          for (const [opId, entry] of Object.entries(next)) {
            if (entry.messageId === message.messageId && entry.chatId === message.chatId) {
              own(state.pendingOp, opId)?.resolve({ message });
              finishOperation(opId);
              delete next[opId];
              changed = true;
            }
          }
          if (changed) set({ optimisticByOp: next });
        }
        const list = [...(state.messages[message.chatId] ?? [])].filter(
          (existing) => existing.messageId !== message.messageId,
        );
        list.push({ ...message, pending: false });
        list.sort((a, b) => a.ts - b.ts);
        set({ messages: { ...state.messages, [message.chatId]: list } });
        break;
      }

      case 'evt.turn_started': {
        const { chatId, turnId, startedAt } = p as {
          chatId?: string;
          turnId?: string;
          startedAt?: number;
        };
        if (!chatId || !turnId) break;
        // A turn can run for a long time, so the phone keeps when it began and says how
        // long it has been running.
        set({
          activeTurn: { ...state.activeTurn, [chatId]: turnId },
          turnStartedAt: { ...state.turnStartedAt, [chatId]: startedAt ?? Date.now() },
        });
        break;
      }

      case 'evt.tool_started': {
        const { chatId, turnId, toolName, callId } = p as {
          chatId?: string;
          turnId?: string;
          toolName?: string;
          callId?: string;
        };
        if (!chatId || !turnId || !toolName) break;
        const list = state.activity[chatId] ?? [];
        // History can arrive before the live replay of the same completed call.
        // Its stable id makes starts idempotent; never downgrade a known result.
        if (callId && list.some((entry) => entry.id === callId)) break;
        const entry: AppActivity = {
          // The bridge names every call, so two calls of the same tool never collide.
          id: callId ?? `${turnId}:${toolName}:${list.length}:${Date.now()}`,
          chatId,
          turnId,
          toolName,
          status: 'running',
          startedAt: Date.now(),
        };
        set({
          activity: { ...state.activity, [chatId]: trimActivity([...list, entry], state.messages[chatId] ?? []) },
        });
        break;
      }

      case 'evt.tool_finished': {
        const { chatId, turnId, toolName, callId, ok, status, usage, error } = p as {
          chatId?: string;
          turnId?: string;
          toolName?: string;
          callId?: string;
          ok?: boolean;
          status?: 'ok' | 'failed' | 'unknown';
          usage?: { durationMs?: number };
          error?: string;
        };
        if (!chatId || !turnId || !toolName) break;
        const list = state.activity[chatId] ?? [];
        // The call id names the exact call, so a finish never lands on the wrong one.
        // Without one, the oldest unfinished call of that name is the one that ran.
        let index = list.findIndex((entry) => callId !== undefined && entry.id === callId);
        if (index < 0) {
          for (let i = 0; i < list.length; i += 1) {
            const entry = list[i]!;
            if (entry.turnId === turnId && entry.toolName === toolName && entry.status === 'running') {
              index = i;
              break;
            }
          }
        }
        if (index < 0) break;
        const durationMs = typeof usage?.durationMs === 'number' ? usage.durationMs : undefined;
        const next = [...list];
        next[index] = {
          ...next[index]!,
          // The bridge may say more than a yes or a no: a call the turn ended before it
          // reported is neither.
          status: status ?? (ok === true ? 'ok' : 'failed'),
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(error ? { error } : {}),
        };
        set({
          activity: { ...state.activity, [chatId]: trimActivity(next, state.messages[chatId] ?? []) },
        });
        break;
      }

      case 'evt.turn_finished': {
        const { chatId, turnId } = p as { chatId?: string; turnId?: string };
        if (!chatId) break;
        const list = (state.messages[chatId] ?? []).map((message) =>
          message.pending && message.role !== 'user' ? { ...message, pending: false } : message,
        );
        const activeTurn = { ...state.activeTurn };
        const turnStartedAt = { ...state.turnStartedAt };
        // A turn that finished is not necessarily the turn that is running: the desktop
        // can start the next one before the previous one reports. A stale finish must
        // not clear the new turn, or the rail stops showing the work in progress.
        if (turnId === undefined || activeTurn[chatId] === turnId) {
          delete activeTurn[chatId];
          delete turnStartedAt[chatId];
        }
        // A tool that never reported back — an aborted turn, a cut budget — would keep
        // its entry running for ever, and the rail would claim the team is working.
        const activity = state.activity[chatId] ?? [];
        const closed = activity.map((entry) =>
          entry.status === 'running' && (turnId === undefined || entry.turnId === turnId)
            ? { ...entry, status: 'unknown' as const, error: entry.error ?? 'The turn ended before this tool reported back.' }
            : entry,
        );
        set({
          messages: { ...state.messages, [chatId]: list },
          activeTurn,
          turnStartedAt,
          activity: { ...state.activity, [chatId]: closed },
        });
        break;
      }

      case 'evt.reaction_added': {
        const reaction = p.reaction as { messageId?: string; emoji?: string } | undefined;
        if (!reaction?.messageId || !reaction.emoji) break;
        const list = own(state.reactions, reaction.messageId) ?? [];
        const index = list.findIndex((entry) => entry.emoji === reaction.emoji);
        const next =
          index >= 0
            ? list.map((entry, i) => (i === index ? { ...entry, count: entry.count + 1 } : entry))
            : [...list, { messageId: reaction.messageId, emoji: reaction.emoji, count: 1 }];
        set({ reactions: { ...state.reactions, [reaction.messageId]: next.slice(0, REACTION_LIMIT) } });
        break;
      }

      case 'evt.permission_requested': {
        const request = p.request as AppPermission | undefined;
        if (!request || typeof request.requestId !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(request.requestId)) break;
        const approvals = [...state.approvals.filter((a) => a.requestId !== request.requestId), request].slice(-100);
        set({ approvals, ...decisionProjection(state, [...approvals, ...state.questions]) });
        break;
      }

      case 'evt.permission_resolved': {
        const requestId = p.requestId;
        const opId = own(state.decidedOps, requestId) ?? uncertainDecisions.get(requestId)?.opId;
        if (opId) finishOperation(opId);
        const decided = { ...state.decided };
        const decidedOps = { ...state.decidedOps };
        delete decided[requestId];
        delete decidedOps[requestId];
        set({ approvals: state.approvals.filter((a) => a.requestId !== requestId), decided, decidedOps });
        break;
      }

      case 'evt.question_requested': {
        const request = p.request as AppQuestion | undefined;
        if (!request || typeof request.requestId !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(request.requestId)) break;
        const questions = [...state.questions.filter((q) => q.requestId !== request.requestId), request].slice(-100);
        set({ questions, ...decisionProjection(state, [...state.approvals, ...questions]) });
        break;
      }

      case 'evt.question_answered': {
        const requestId = p.requestId;
        const opId = own(state.decidedOps, requestId) ?? uncertainDecisions.get(requestId)?.opId;
        if (opId) finishOperation(opId);
        const decided = { ...state.decided };
        const decidedOps = { ...state.decidedOps };
        delete decided[requestId];
        delete decidedOps[requestId];
        set({
          questions: state.questions.filter((q) => q.requestId !== requestId),
          decided,
          decidedOps,
        });
        break;
      }

      case 'evt.task_updated': {
        const task = p.task as AppTask | undefined;
        if (!task) break;
        const tasks = state.tasks.filter((t) => t.taskId !== task.taskId);
        tasks.push(task);
        set({ tasks });
        break;
      }

      case 'evt.helper_updated': {
        const helper = p.helper as AppHelper | undefined;
        if (!helper) break;
        const helpers = state.helpers.filter((h) => h.helperId !== helper.helperId);
        helpers.push(helper);
        set({ helpers });
        break;
      }

      case 'evt.schedule_updated': {
        const schedule = p.schedule as AppSchedule | undefined;
        if (!schedule) break;
        const schedules = state.schedules.filter((s) => s.scheduleId !== schedule.scheduleId);
        schedules.push(schedule);
        set({ schedules });
        break;
      }

      case 'evt.bridge_status': {
        set({
          bridgeOnline: p.desktopOnline === true || (p.desktopOnline === undefined && state.bridgeOnline),
          desktopKnown: typeof p.desktopOnline === 'boolean' || state.desktopKnown,
          diagnostics: {
            ...state.diagnostics,
            agentAvailable: p.agentAvailable ?? state.diagnostics.agentAvailable,
            teamToolsAvailable:
              p.teamToolsAvailable ?? state.diagnostics.teamToolsAvailable,
          },
        });
        break;
      }

      default:
        break;
    }
    if (['evt.message_chunk', 'evt.message_committed', 'evt.turn_started', 'evt.turn_finished'].includes(frame.type)) {
      const current = get();
      const messages = retainMessages(current);
      const ids = new Set(Object.values(messages).flat().map(m => m.messageId));
      set({ messages,
        reactions: Object.fromEntries(Object.entries(current.reactions).filter(([id]) => ids.has(id))),
      });
      if (frame.type === 'evt.message_committed' && p.message?.role === 'user') void persistOutbox(get().outbox);
    }
  },
}));

/** Opens the relay connection for the current session. */
export function connectRelay(session: Session): RelayClient {
  disconnectRelay();
  const instance = new RelayClient({
    url: session.relayUrl,
    accountId: session.accountId,
    deviceId: session.deviceId,
    token: session.deviceToken,
    clientVersion: '0.1.0',
    onFrame: (frame) => {
      if (client !== instance || !sameOwner(useAppStore.getState().session, session)) return false;
      // The public action remains void for React event/act callbacks. The transport
      // alone observes its internal rejection sentinel before advancing its cursor.
      const applied = (useAppStore.getState().applyFrame as (frame: Frame) => unknown)(frame);
      if (applied === false) return false;
      if (frame.type === 'hello.ok' || frame.type === 'evt.bridge_status') {
        useAppStore.getState().flushOutbox();
      }
    },
    onStatus: (status) => {
      if (client !== instance || !sameOwner(useAppStore.getState().session, session)) return;
      useAppStore.getState().setStatus(status);
      if (status === 'online') {
        useAppStore.getState().flushOutbox();
      }
    },
    onFatal: (code) => {
      if (client !== instance || !sameOwner(useAppStore.getState().session, session)) return;
      const recoverable = useAppStore.getState().outbox.filter(item => item.type === 'op.send_message');
      useAppStore.getState().setSession(null);
      useAppStore.setState({ outbox: recoverable });
      void persistOutbox(recoverable);
      // The relay will not serve this device again: it was revoked, or another phone
      // took its place. The session is dropped so the app asks for a new pairing code
      // instead of retrying forever with a credential that cannot work.
      useAppStore.getState().setError(
        code === CLOSE_DEVICE_REVOKED
          ? 'This phone was unpaired on the desktop. Pair it again there.'
          : 'The relay no longer knows this phone — it may have restarted. Pair it again.',
      );
      // The queued messages are not thrown away with the session. Every item carries
      // the account it was composed for, so it is only ever sent into that account's
      // room: dropping the session says nothing about the conversation the user has
      // not had yet. Unpairing on purpose still clears them.
    },
  });
  client = instance;
  instance.connect();
  return instance;
}

export function disconnectRelay(): void {
  const previous = client;
  client = null;
  previous?.disconnect();
}

/**
 * Unpairs this phone.
 *
 * Local state is cleared immediately. Remote revocation has a deadline and its
 * result is reported separately: local cleanup must not claim the server forgot
 * a credential when its answer could not be confirmed.
 *
 * @returns whether the relay released the token.
 */
export async function unpairPhone(): Promise<boolean> {
  const session = useAppStore.getState().session;
  disconnectRelay();
  useAppStore.getState().setSession(null);
  const cleanup = persistSession(null).catch(() => {
    if (!useAppStore.getState().session) useAppStore.getState().setError('The local link was removed, but the locked keystore could not be erased.');
  });
  if (!session) { await cleanup; return false; }
  const released = await releaseDevice(session.relayUrl, session.accountId, session.deviceToken);
  await cleanup;
  if (!released && !useAppStore.getState().session) {
    useAppStore.getState().setError('This phone is unlinked locally. Remote revocation is unconfirmed; remove the phone on the desktop too.');
  }
  return released;
}
