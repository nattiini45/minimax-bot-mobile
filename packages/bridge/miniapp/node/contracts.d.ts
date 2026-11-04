import type { ChatMessage, TurnActivity, ToolDescriptor, QuestionAnswer } from './protocol/types.js';
export type { ChatMessage, TurnActivity };

/** Structural Desktop capabilities consumed by this bridge, not the CLI Host. */
export interface HostContext {
  dataDir?: string;
  agent?: HostAgent;
  tool?: HostTool;
  logger?: { warn?: (...values: unknown[]) => void };
}
export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: HostAgentEvent) => void;
}
export interface HostQuestion {
  schemaVersion?: number;
  id?: string;
  title?: string;
  steps: unknown[];
  expiresAt?: number;
}
export interface PendingQuestion {
  requestId: string;
  turnId?: string;
  mode: string;
  request: HostQuestion;
}
/** Older Host envelopes can omit fields; the bridge never invents their usage. */
export interface HostRunResult {
  sessionId?: string;
  turnId?: string;
  status?: string;
  text?: string;
  pendingQuestion?: PendingQuestion;
  usage?: { totalTokens?: number; total?: number; cost?: number; totalCost?: number };
  error?: { code?: string; message?: string };
}
export interface HostAgentEvent {
  type: string;
  sessionId?: string;
  turnId?: string;
  requestId?: string;
  mode?: string;
  request?: HostQuestion;
  name?: string;
  toolName?: string;
  toolInput?: string;
  reason?: string;
  text?: string;
  status?: string;
  ok?: boolean;
  error?: { code?: string; message?: string };
}
export interface HostAgent {
  run?: (input: { text: string; sessionId?: string; model?: unknown }, options?: RunOptions) => Promise<HostRunResult>;
  answer?: (input: { sessionId: string; requestId: string; answers: QuestionAnswer[] }, options?: RunOptions) => Promise<HostRunResult>;
  reply?: (input: { sessionId: string; requestId: string; decision: string }) => Promise<void>;
  models?: () => Promise<unknown>;
}
export interface HostTool {
  list?: () => Promise<{ tools?: Array<Partial<ToolDescriptor>>; partial?: boolean }>;
  call?: (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<{
    kind?: string; isError?: boolean; content?: unknown; structuredContent?: unknown;
  }>;
}
export interface PendingRequest {
  requestId: string;
  sessionId?: string;
  turnId?: string;
  chatId?: string;
  toolName?: string;
  toolInput?: string;
  reason?: string;
  mode?: string;
  title?: string;
  steps?: unknown[];
  expiresAt?: number;
}
export interface PendingItem {
  kind: 'permission' | 'question';
  request: PendingRequest;
  sessionId: string;
  expiresAt: number;
  claimed?: boolean;
  claimId?: number;
}
export interface TeamTurn {
  batchId: string;
  taskId?: string;
  messageId?: string;
  chatId?: string;
}
export interface LedgerEntry {
  ts: number;
  kind: string;
  botId?: string;
  botName?: string;
  toolName?: string;
  chars?: number;
  durationMs?: number;
  tokens?: number;
  cost?: number;
  error?: boolean;
  ok?: boolean;
  requestId?: string;
  deviceId?: string;
  decision?: string;
  action?: string;
  subject?: string;
  detail?: string;
}
