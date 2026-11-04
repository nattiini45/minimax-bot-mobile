import type { AppMessage, AppState } from './store';

export const HISTORY_PER_CHAT = 200;
export const HISTORY_GLOBAL = 2000;
export const LOCAL_RECOVERY_LIMIT = 200;

export const own = <T>(record: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

export function validChatId(value: unknown): value is string {
  return typeof value === 'string' && /^(bot|group):.+$/.test(value);
}
export function validMessage(value: unknown): value is AppMessage {
  const m = value as AppMessage | null;
  return !!m && validChatId(m.chatId) && typeof m.messageId === 'string' &&
    typeof m.text === 'string' && Number.isFinite(m.ts) &&
    ['user', 'assistant', 'system', 'tool'].includes(m.role);
}
export function localRecovery(message: AppMessage): boolean {
  return message.role === 'user' && (message.pending === true || !!message.deliveryError);
}

/** Limits committed history, never silently discards user recovery text or an active turn. */
export function retainMessages(state: Pick<AppState, 'messages' | 'activeTurn'>): Record<string, AppMessage[]> {
  const protectedMessage = (m: AppMessage) => localRecovery(m) || m.pending === true ||
    (!!m.turnId && own(state.activeTurn, m.chatId) === m.turnId);
  const perChat = Object.fromEntries(Object.entries(state.messages).map(([chatId, list]) => {
    let retained = 0;
    return [chatId, [...list].reverse().filter(m => protectedMessage(m) || retained++ < HISTORY_PER_CHAT).reverse()];
  }));
  const ordinary = Object.values(perChat).flat().filter(m => !protectedMessage(m)).sort((a, b) => b.ts - a.ts);
  const kept = new Set(ordinary.slice(0, HISTORY_GLOBAL));
  return Object.fromEntries(Object.entries(perChat).map(([id, list]) => [id, list.filter(m => protectedMessage(m) || kept.has(m))]).filter(([, list]) => list.length));
}
