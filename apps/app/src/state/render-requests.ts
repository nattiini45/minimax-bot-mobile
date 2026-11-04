import { validChatId } from './retention';
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const optionalText = (value: Record<string, unknown>, fields: string[]) => fields.every(key => value[key] === undefined || text(value[key]));

/** Validate only understood/rendered fields; preserve unknown extension fields unchanged. */
export function validPendingRequest(value: unknown, question: boolean): boolean {
  if (!record(value) || !text(value.requestId) || !value.requestId || ['__proto__', 'constructor', 'prototype'].includes(value.requestId)) return false;
  if (!optionalText(value, ['sessionId', 'turnId', 'botId', 'title', 'toolName', 'toolInput', 'reason']) ||
    (value.chatId !== undefined && !validChatId(value.chatId))) return false;
  if (!question) return true;
  return Array.isArray(value.steps) && value.steps.every(step => record(step) && text(step.id) && !!step.id && text(step.question) &&
    optionalText(step, ['description']) && (step.selectionMode === undefined || (text(step.selectionMode) && ['single', 'multiple'].includes(step.selectionMode))) &&
    Array.isArray(step.options) && step.options.every(option => record(option) && text(option.id) && !!option.id && text(option.label) && optionalText(option, ['description'])));
}
