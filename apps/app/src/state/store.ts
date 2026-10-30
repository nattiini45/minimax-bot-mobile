/**
 * Application state.
 *
 * The phone is a projection of the desktop's truth: every mutation is a request to the
 * bridge, and the screen updates when the bridge's event comes back. The store keeps an
 * outbox so a message composed while offline is delivered exactly once.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Frame } from '@minimax-bot/protocol';
import { create } from 'zustand';

import { CLOSE_DEVICE_REVOKED, RelayClient, type ConnectionStatus } from '../net/relay-client';
import { isValidRelayUrl, relayOrigin } from '../net/relay-url';
import { releaseDevice } from '../net/release';
import {
  clearDeviceToken,
  loadDeviceOrigin,
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
}

export interface AppState {
  session: Session | null;
  status: ConnectionStatus;
  lastError: string | null;
  bridgeOnline: boolean;

  bots: AppBot[];
  groups: AppGroup[];
  tools: AppTool[];
  diagnostics: Diagnostics;

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

  outbox: OutboxItem[];
  /**
   * The pending bubble behind each `opId`.
   *
   * A send that the desktop refuses must not leave a message the desktop never
   * accepted, so the bubble is taken back out when its operation fails.
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
  sendChatMessage: (chatId: string, text: string) => void;
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
  flushOutbox: () => void;
  /** Re-reads everything the phone can show: the roster, tasks, helpers and schedules. */
  refreshTeam: () => void;
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
  description?: string;
  model?: string;
  isMain?: boolean;
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
  toolName: string;
  toolInput?: string;
  reason: string;
}

export interface AppQuestion {
  requestId: string;
  sessionId: string;
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
  /** `running` until the tool reports back. */
  status: 'running' | 'ok' | 'failed';
  startedAt: number;
  durationMs?: number;
  error?: string;
}

/** How many tool calls are kept per chat. */
const ACTIVITY_LIMIT = 40;

/**
 * Keeps the activity list within its limit.
 *
 * Only finished calls are dropped. A running call is still the truth about what the
 * team is doing, and evicting it would lose the call that a later finish belongs to.
 */
function trimActivity(list: AppActivity[]): AppActivity[] {
  if (list.length <= ACTIVITY_LIMIT) return list;
  let excess = list.length - ACTIVITY_LIMIT;
  return list.filter((entry) => {
    if (excess > 0 && entry.status !== 'running') {
      excess -= 1;
      return false;
    }
    return true;
  });
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
 * Applies the answer to a read operation to the store.
 *
 * The bridge answers a read with the data; the phone is a projection of that data, so
 * the answer is what the screen renders.
 */
function applyOperationResult(
  result: unknown,
  type: string | undefined,
  payload: unknown,
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
      if (!chatId || !Array.isArray(data.messages)) return;
      // The desktop owns the reaction counts, so they arrive with the thread. Without
      // them the chips would vanish on a restart while the desktop kept counting.
      const reactions = Array.isArray(data.reactions) ? (data.reactions as AppReaction[]) : [];
      const byMessage: Record<string, AppReaction[]> = {};
      for (const reaction of reactions) {
        if (!reaction?.messageId || !reaction?.emoji) continue;
        const list = byMessage[reaction.messageId] ?? [];
        list.push(reaction);
        byMessage[reaction.messageId] = list;
      }
      useAppStore.setState({
        messages: { ...state.messages, [chatId]: data.messages },
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
export async function persistSession(session: Session | null) {
  if (!session) {
    await AsyncStorage.removeItem(SESSION_KEY);
    await clearDeviceToken();
    return;
  }
  // The token is the one secret in the session, and it goes to the keystore. The
  // rest is not a credential and stays where the app can read it.
  const { deviceToken, ...rest } = session;
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(rest));
  await saveDeviceToken(deviceToken, relayOrigin(session.relayUrl));
  // The relay this phone belongs to is remembered outside the session, so that a
  // pairing code is not sent to another relay without the user saying so - even
  // after this phone was unpaired.
  await saveLastRelayUrl(session.relayUrl);
}

/**
 * Reads the session back.
 *
 * The relay address is checked again on the way in: a stored value that was
 * tampered with must not be able to send the device token to another host.
 */
export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredSession;
    if (!stored || typeof stored !== 'object') return null;

    if (typeof stored.relayUrl !== 'string' || !isValidRelayUrl(stored.relayUrl)) {
      // The address is not one the app may use, so the token is not used with it
      // either: the session is dropped and the phone has to pair again.
      await persistSession(null);
      return null;
    }

    let token = await loadDeviceToken();
    const origin = await loadDeviceOrigin();

    if (!token && typeof stored.deviceToken === 'string' && stored.deviceToken.length > 0) {
      // A phone that paired before the token moved to the keystore.
      token = stored.deviceToken;
      await saveDeviceToken(token, relayOrigin(stored.relayUrl));
    }
    if (!token) return null;

    // The address the token was minted for is remembered beside the token. If the
    // address in the plain store names another relay now, the store was changed
    // by something that is not this app, and the token is not presented there.
    if (origin && origin !== relayOrigin(stored.relayUrl)) {
      await persistSession(null);
      return null;
    }

    const session: Session = {
      relayUrl: stored.relayUrl,
      accountId: typeof stored.accountId === 'string' ? stored.accountId : 'default',
      deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : '',
      deviceName: typeof stored.deviceName === 'string' ? stored.deviceName : 'Phone',
      deviceToken: token,
    };

    // The record is written back without the token, so the plain text copy is
    // gone even if the phone paired before this change.
    const { deviceToken: _dropped, ...clean } = session;
    await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(clean));

    return session;
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
    const raw = await AsyncStorage.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // An entry that was written before the outbox knew its account cannot be
    // attributed to one, and an operation that cannot be attributed to an account
    // is never sent.
    return parsed.map((entry) => ({
      opId: typeof entry?.opId === 'string' ? entry.opId : '',
      type: typeof entry?.type === 'string' ? entry.type : '',
      payload: entry?.payload,
      queuedAt: typeof entry?.queuedAt === 'number' ? entry.queuedAt : 0,
      accountId: typeof entry?.accountId === 'string' ? entry.accountId : '',
    }));
  } catch {
    return [];
  }
}

async function persistOutbox(outbox: OutboxItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  } catch {
    /* storage is full or unavailable; the in-memory outbox still works */
  }
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

export const useAppStore = create<AppState>((set, get) => ({
  session: null,
  status: 'idle',
  lastError: null,
  bridgeOnline: false,
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
  diagnostics: {
    agentAvailable: false,
    teamToolsAvailable: false,
    toolCount: 0,
    partial: false,
  },

  messages: {},
  activity: {},
  activeTurn: {},
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

  outbox: [],
  optimisticByOp: {},
  pendingOp: {},

  setSession: (session) => {
    set({ session });
    void persistSession(session);
  },

  setStatus: (status) => set({ status }),
  setError: (message) => set({ lastError: message }),

  request: (type, payload) => {
    const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    opTypes.set(opId, type);
    const frame = {
      v: 1 as const,
      id: `f_${opId}`,
      ts: Date.now(),
      type,
      source: 'app' as const,
      payload,
      opId,
    };

    const sent = client?.send(frame) ?? false;
    if (!sent) {
      const outbox = boundedOutbox([
        ...get().outbox,
        {
          opId,
          type,
          payload,
          queuedAt: Date.now(),
          // The account the operation was composed for, so it is never sent into
          // another account's room.
          accountId: get().session?.accountId ?? '',
        },
      ]);
      set({ outbox });
      void persistOutbox(outbox);
    }
    return opId;
  },

  requestAsync: (type, payload) => {
    const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    opTypes.set(opId, type);
    return new Promise((resolve, reject) => {
      // An operation that is never answered must not leave the caller waiting for
      // ever: a screen that awaits this would spin until the app is closed.
      const timer = setTimeout(() => {
        set((state) => {
          const next = { ...state.pendingOp };
          delete next[opId];
          return { pendingOp: next };
        });
        reject(new Error('The desktop did not answer in time.'));
      }, OP_TIMEOUT_MS);

      set((state) => ({
        pendingOp: { ...state.pendingOp, [opId]: { type, payload, resolve, reject, timer } },
      }));

      const frame = {
        v: 1 as const,
        id: `f_${opId}`,
        ts: Date.now(),
        type,
        source: 'app' as const,
        payload,
        opId,
      };

      const sent = client?.send(frame) ?? false;
      if (!sent) {
        const outbox = boundedOutbox([
          ...get().outbox,
          {
            opId,
            type,
            payload,
            queuedAt: Date.now(),
            // The account the operation was composed for, so it is never sent into
            // another account's room.
            accountId: get().session?.accountId ?? '',
          },
        ]);
        set({ outbox });
        void persistOutbox(outbox);
      }
    });
  },

  flushOutbox: () => {
    const { outbox } = get();
    if (!outbox.length || !client) return;
    const accountId = get().session?.accountId ?? '';
    const remaining: OutboxItem[] = [];
    let stopped = false;
    for (const item of outbox) {
      // An operation composed for another account is not sent here. The phone
      // holds one credential at a time, so the room it belongs to cannot be
      // reached with this connection, and sending it would put one account's
      // content into another account's room and execute it there.
      if (item.accountId !== accountId) continue;
      if (stopped) {
        remaining.push(item);
        continue;
      }
      const frame = {
        v: 1 as const,
        id: `f_${item.opId}`,
        ts: Date.now(),
        type: item.type,
        source: 'app' as const,
        payload: item.payload,
        opId: item.opId,
      };
      if (!client.send(frame)) {
        // The socket went away mid-flush. Everything from here on stays queued; the
        // frames already sent keep their opId, so the bridge's dedupe makes a later
        // retry harmless.
        stopped = true;
        remaining.push(item);
      }
    }
    set({ outbox: remaining });
    void persistOutbox(remaining);
  },

  refreshTeam: () => {
    const state = get();
    if (!state.session) return;
    state.request('op.list_team', {});
    state.request('op.list_tasks', {});
    state.request('op.list_helpers', {});
    state.request('op.list_schedules', {});
  },

  sendChatMessage: (chatId, text) => {
    const body = text.trim();
    if (!body) return;

    // The client picks the message id, so the bubble it shows now is the very message
    // the desktop commits later: the committed message replaces it in place, and a
    // send that fails can take its own bubble back out.
    const messageId = `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const message: AppMessage = {
      messageId,
      chatId,
      role: 'user',
      text: body,
      ts: Date.now(),
      pending: true,
    };
    set((state) => ({
      messages: { ...state.messages, [chatId]: [...(state.messages[chatId] ?? []), message] },
    }));

    const opId = get().request('op.send_message', { chatId, text: body, clientMessageId: messageId });
    set((state) => ({
      optimisticByOp: { ...state.optimisticByOp, [opId]: { messageId, chatId } },
    }));
  },

  react: (messageId, emoji) => {
    if (!messageId || !emoji) return;
    // The bridge owns the count, so the phone does not guess it: it asks, and the
    // bridge answers with `evt.reaction_added`.
    get().request('op.react', { messageId, emoji });
  },

  respondPermission: (requestId, decision) => {
    if (!requestId) return;
    // A decision that has already been given is not given again. The desktop claims
    // the request before it tells the Host, so a second answer for the same request
    // would be refused there; the phone does not send one.
    if (get().decided[requestId]) return;
    const opId = get().request('op.respond_permission', { requestId, decision });
    set((state) => ({
      decided: { ...state.decided, [requestId]: decision },
      decidedOps: { ...state.decidedOps, [requestId]: opId },
    }));
  },

  applyFrame: (frame) => {
    const state = get();
    // The envelope is typed loosely on purpose; the payload shape depends on the frame type.
    const p = (frame.payload ?? {}) as Record<string, any>;

    if (frame.type === 'ack') {
      const opId = p.opId;
      const pending = opId ? state.pendingOp[opId] : undefined;
      if (pending && opId) {
        clearTimeout(pending.timer);
        set((current) => {
          const next = { ...current.pendingOp };
          delete next[opId];
          return { pendingOp: next };
        });
        pending.resolve(p.result);
      }
      // The answer to a read is the only place the data ever arrives, so it is applied
      // to the store here. A screen that only awaits the promise would otherwise show
      // an empty list forever.
      applyOperationResult(p.result, opId ? opTypes.get(opId) : undefined, pending?.payload);
      return;
    }

    if (frame.type === 'err') {
      const opId = p.opId;
      // A send the desktop refused must not leave a bubble it never accepted.
      if (opId) {
        const optimistic = state.optimisticByOp[opId];
        if (optimistic) {
          set((current) => {
            const list = (current.messages[optimistic.chatId] ?? []).filter(
              (message) => message.messageId !== optimistic.messageId,
            );
            const next = { ...current.optimisticByOp };
            delete next[opId];
            return {
              messages: { ...current.messages, [optimistic.chatId]: list },
              optimisticByOp: next,
            };
          });
        }
      }
      const pending = opId ? state.pendingOp[opId] : undefined;
      if (pending && opId) {
        clearTimeout(pending.timer);
        set((current) => {
          const next = { ...current.pendingOp };
          delete next[opId];
          return { pendingOp: next };
        });
        pending.reject(new Error(p.message ?? 'The request failed.'));
      }
      // A decision the desktop refused is given back: the request is still waiting
      // for an answer, and the phone has to be able to give one.
      if (opId) {
        set((current) => {
          const decided = { ...current.decided };
          const decidedOps = { ...current.decidedOps };
          let changed = false;
          for (const [requestId, sentOpId] of Object.entries(decidedOps)) {
            if (sentOpId !== opId) continue;
            delete decided[requestId];
            delete decidedOps[requestId];
            changed = true;
          }
          return changed ? { decided, decidedOps } : current;
        });
      }
      set({ lastError: p.message ?? 'The request failed.' });
      return;
    }

    if (frame.type === 'hello.ok') {
      set({ bridgeOnline: p.bridgeOnline === true });
      if (p.truncated === true) {
        // The relay could not replay everything this phone missed, so its view has a
        // hole. The projection is dropped and rebuilt from a fresh read — including
        // the live trace, which would otherwise keep claiming that the team is working.
        set((state) => ({
          messages: {},
          tasks: [],
          helpers: [],
          schedules: [],
          bots: [],
          groups: [],
          activity: {},
          activeTurn: {},
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
            if (entry.messageId === message.messageId) {
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
        const { chatId, turnId } = p as { chatId?: string; turnId?: string };
        if (!chatId || !turnId) break;
        set({ activeTurn: { ...state.activeTurn, [chatId]: turnId } });
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
        const entry: AppActivity = {
          // The bridge names every call, so two calls of the same tool never collide.
          id: callId ?? `${turnId}:${toolName}:${list.length}:${Date.now()}`,
          chatId,
          turnId,
          toolName,
          status: 'running',
          startedAt: Date.now(),
        };
        set({ activity: { ...state.activity, [chatId]: trimActivity([...list, entry]) } });
        break;
      }

      case 'evt.tool_finished': {
        const { chatId, turnId, toolName, callId, ok, usage, error } = p as {
          chatId?: string;
          turnId?: string;
          toolName?: string;
          callId?: string;
          ok?: boolean;
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
          status: ok === true ? 'ok' : 'failed',
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(error ? { error } : {}),
        };
        set({ activity: { ...state.activity, [chatId]: trimActivity(next) } });
        break;
      }

      case 'evt.turn_finished': {
        const { chatId, turnId } = p as { chatId?: string; turnId?: string };
        if (!chatId) break;
        const list = (state.messages[chatId] ?? []).map((message) =>
          message.pending ? { ...message, pending: false } : message,
        );
        const activeTurn = { ...state.activeTurn };
        // A turn that finished is not necessarily the turn that is running: the desktop
        // can start the next one before the previous one reports. A stale finish must
        // not clear the new turn, or the rail stops showing the work in progress.
        if (turnId === undefined || activeTurn[chatId] === turnId) {
          delete activeTurn[chatId];
        }
        // A tool that never reported back — an aborted turn, a cut budget — would keep
        // its entry running for ever, and the rail would claim the team is working.
        const activity = state.activity[chatId] ?? [];
        const closed = activity.map((entry) =>
          entry.status === 'running' && (turnId === undefined || entry.turnId === turnId)
            ? { ...entry, status: 'failed' as const, error: entry.error ?? 'The turn ended before this tool reported back.' }
            : entry,
        );
        set({
          messages: { ...state.messages, [chatId]: list },
          activeTurn,
          activity: { ...state.activity, [chatId]: closed },
        });
        break;
      }

      case 'evt.reaction_added': {
        const reaction = p.reaction as { messageId?: string; emoji?: string } | undefined;
        if (!reaction?.messageId || !reaction.emoji) break;
        const list = state.reactions[reaction.messageId] ?? [];
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
        if (!request) break;
        const approvals = [...state.approvals.filter((a) => a.requestId !== request.requestId), request];
        // A decision is only remembered while the approval is on screen, so the map
        // cannot grow with approvals that are long gone.
        const live = new Set(approvals.map((a) => a.requestId));
        const decided: Record<string, string> = {};
        const decidedOps: Record<string, string> = {};
        for (const [id, value] of Object.entries(state.decided)) {
          if (!live.has(id)) continue;
          decided[id] = value;
          const opId = state.decidedOps[id];
          if (opId !== undefined) decidedOps[id] = opId;
        }
        set({ approvals, decided, decidedOps });
        break;
      }

      case 'evt.permission_resolved': {
        const requestId = p.requestId;
        const decided = { ...state.decided };
        const decidedOps = { ...state.decidedOps };
        delete decided[requestId];
        delete decidedOps[requestId];
        set({ approvals: state.approvals.filter((a) => a.requestId !== requestId), decided, decidedOps });
        break;
      }

      case 'evt.question_requested': {
        const request = p.request as AppQuestion | undefined;
        if (!request) break;
        set({ questions: [...state.questions.filter((q) => q.requestId !== request.requestId), request] });
        break;
      }

      case 'evt.question_answered': {
        const requestId = p.requestId;
        set({ questions: state.questions.filter((q) => q.requestId !== requestId) });
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
          bridgeOnline: p.desktopOnline !== false,
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
      useAppStore.getState().applyFrame(frame);
      if (frame.type === 'hello.ok') {
        useAppStore.getState().flushOutbox();
      }
    },
    onStatus: (status) => {
      useAppStore.getState().setStatus(status);
      if (status === 'online') {
        useAppStore.getState().flushOutbox();
      }
    },
    onFatal: (code) => {
      // The relay will not serve this device again: it was revoked, or another phone
      // took its place. The session is dropped so the app asks for a new pairing code
      // instead of retrying forever with a credential that cannot work.
      useAppStore.getState().setError(
        code === CLOSE_DEVICE_REVOKED
          ? 'This phone was unpaired on the desktop. Pair it again there.'
          : 'The relay no longer knows this phone — it may have restarted. Pair it again.',
      );
      useAppStore.getState().setSession(null);
      void persistSession(null);
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
  client?.disconnect();
  client = null;
}

/**
 * Unpairs this phone.
 *
 * The relay is told first: a phone that only forgets its own token leaves a
 * working credential behind on the relay, and the owner believes the device is
 * gone.
 *
 * @returns whether the relay released the token.
 */
export async function unpairPhone(): Promise<boolean> {
  const session = useAppStore.getState().session;
  disconnectRelay();
  if (!session) return false;

  const released = await releaseDevice(session.relayUrl, session.accountId, session.deviceToken);
  // The phone forgets the token either way: the local copy is the one the owner
  // asked to be gone.
  useAppStore.getState().setSession(null);
  // The queue belongs to the account that was just left. Its operations cannot
  // be delivered any more, and they must not be delivered to the next account.
  useAppStore.setState({ outbox: [] });
  void persistOutbox([]);
  return released;
}
