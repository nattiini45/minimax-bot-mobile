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
  pendingOp: Record<string, { type: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>;

  setSession: (session: Session | null) => void;
  setStatus: (status: ConnectionStatus) => void;
  setError: (message: string | null) => void;
  applyFrame: (frame: Frame) => void;
  request: (type: string, payload: unknown) => void;
  requestAsync: (type: string, payload: unknown) => Promise<unknown>;
  flushOutbox: () => void;
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

let client: RelayClient | null = null;

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
  pendingOp: {},

  setSession: (session) => {
    set({ session });
    void persistSession(session);
  },

  setStatus: (status) => set({ status }),
  setError: (message) => set({ lastError: message }),

  request: (type, payload) => {
    const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const frame = {
      v: 1 as const,
      id: `f_${opId}`,
      ts: Date.now(),
      type,
      source: 'app' as const,
      payload,
      opId,
    };

    const current = get();
    const sent = client?.send(frame) ?? false;
    if (!sent) {
      set({ outbox: [...current.outbox, { opId, type, payload, queuedAt: Date.now() }] });
    }
  },

  requestAsync: (type, payload) => {
    const opId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve, reject) => {
      set((state) => ({
        pendingOp: { ...state.pendingOp, [opId]: { type, resolve, reject } },
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
        set((state) => ({
          outbox: [...state.outbox, { opId, type, payload, queuedAt: Date.now() }],
        }));
      }
    });
  },

  flushOutbox: () => {
    const { outbox } = get();
    if (!outbox.length || !client) return;
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
      if (!client.send(frame)) return;
    }
    set({ outbox: [] });
  },

  applyFrame: (frame) => {
    const state = get();
    // The envelope is typed loosely on purpose; the payload shape depends on the frame type.
    const p = (frame.payload ?? {}) as Record<string, any>;

    if (frame.type === 'ack') {
      const opId = p.opId;
      const pending = opId ? state.pendingOp[opId] : undefined;
      if (pending && opId) {
        set((current) => {
          const next = { ...current.pendingOp };
          delete next[opId];
          return { pendingOp: next };
        });
        pending.resolve(p.result);
      }
      return;
    }

    if (frame.type === 'err') {
      const opId = p.opId;
      const pending = opId ? state.pendingOp[opId] : undefined;
      if (pending && opId) {
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
  });
  client = instance;
  instance.connect();
  return instance;
}

export function disconnectRelay(): void {
  client?.disconnect();
  client = null;
}
