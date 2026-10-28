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

import { RelayClient, type ConnectionStatus } from '../net/relay-client';

export interface Session {
  relayUrl: string;
  accountId: string;
  deviceId: string;
  deviceToken: string;
  deviceName: string;
}

export interface OutboxItem {
  opId: string;
  type: string;
  payload: unknown;
  queuedAt: number;
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
  tasks: AppTask[];
  helpers: AppHelper[];
  schedules: AppSchedule[];
  approvals: AppPermission[];
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
  flushOutbox: () => void;
  /** Re-reads everything the phone can show: the roster, tasks, helpers and schedules. */
  refreshTeam: () => void;
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
      useAppStore.setState({ tasks: Array.isArray(data.tasks) ? data.tasks : state.tasks });
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
      useAppStore.setState({
        messages: { ...state.messages, [chatId]: data.messages },
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

async function persistSession(session: Session | null) {
  if (!session) {
    await AsyncStorage.removeItem(SESSION_KEY);
    return;
  }
  await AsyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await AsyncStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
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
    return Array.isArray(parsed) ? (parsed as OutboxItem[]) : [];
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

export const useAppStore = create<AppState>((set, get) => ({
  session: null,
  status: 'idle',
  lastError: null,
  bridgeOnline: false,

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
  tasks: [],
  helpers: [],
  schedules: [],
  approvals: [],
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
      const outbox = [...get().outbox, { opId, type, payload, queuedAt: Date.now() }];
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
        const outbox = [...get().outbox, { opId, type, payload, queuedAt: Date.now() }];
        set({ outbox });
        void persistOutbox(outbox);
      }
    });
  },

  flushOutbox: () => {
    const { outbox } = get();
    if (!outbox.length || !client) return;
    const remaining: OutboxItem[] = [];
    for (const item of outbox) {
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
        remaining.push(...outbox.slice(outbox.indexOf(item)));
        break;
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
      set({ lastError: p.message ?? 'The request failed.' });
      return;
    }

    if (frame.type === 'hello.ok') {
      set({ bridgeOnline: p.bridgeOnline === true });
      if (p.truncated === true) {
        // The relay could not replay everything this phone missed, so its view has a
        // hole. The projection is dropped and rebuilt from a fresh read.
        set({ messages: {}, tasks: [], helpers: [], schedules: [], bots: [], groups: [] });
      }
      get().refreshTeam();
      return;
    }

    if (!frame.type.startsWith('evt.')) return;

    switch (frame.type) {
      case 'evt.team_snapshot': {
        set({
          bots: p.bots ?? [],
          groups: p.groups ?? [],
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

      case 'evt.turn_finished': {
        const { chatId } = p as { chatId?: string };
        if (!chatId) break;
        const list = (state.messages[chatId] ?? []).map((message) =>
          message.pending ? { ...message, pending: false } : message,
        );
        set({ messages: { ...state.messages, [chatId]: list } });
        break;
      }

      case 'evt.permission_requested': {
        const request = p.request as AppPermission | undefined;
        if (!request) break;
        set({ approvals: [...state.approvals.filter((a) => a.requestId !== request.requestId), request] });
        break;
      }

      case 'evt.permission_resolved': {
        const requestId = p.requestId;
        set({ approvals: state.approvals.filter((a) => a.requestId !== requestId) });
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
        code === 4003
          ? 'This phone was unpaired on the desktop. Pair it again there.'
          : 'The relay refused this phone. Pair it again.',
      );
      useAppStore.getState().setSession(null);
      void persistSession(null);
      void persistOutbox([]);
      useAppStore.setState({ outbox: [] });
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
