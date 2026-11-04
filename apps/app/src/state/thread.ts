import type { AppActivity, AppMessage } from './store';

/**
 * One line of the thread.
 *
 * A turn is a message and the tool calls it made, and the calls belong with the turn
 * they came from — under the last message of that turn — rather than in one list at
 * the bottom of the conversation.
 */
export type ThreadItem =
  | { kind: 'message'; key: string; message: AppMessage; showAuthor: boolean }
  | { kind: 'turnActivity'; key: string; entries: AppActivity[] };

/**
 * The thread as the reader sees it.
 *
 * A turn the desktop's own engine runs reaches the phone as several messages, and the
 * calls it made travel with it. Putting them together means the phone shows the same
 * work the desktop shows, where it happened, instead of one list at the bottom of the
 * conversation.
 *
 * @param messages the thread, in the order the phone holds it
 * @param activity the tool calls of the chat
 */
export function buildThread(messages: AppMessage[], activity: AppActivity[] = []): ThreadItem[] {
  const groups = new Map<string, AppActivity[]>();
  for (const entry of activity) {
    const list = groups.get(entry.turnId) ?? [];
    list.push(entry);
    groups.set(entry.turnId, list);
  }

  const messageItems = messages.map((message) => ({
    kind: 'message' as const,
    key: `${message.messageId}-${message.ts}`,
    message,
    // The desktop shows the face of a Bot once for the whole of its turn, not once for
    // every bubble of it, so the face belongs to the first message of the turn.
    showAuthor: true,
  }));

  messageItems.forEach((item, index) => {
    const previous = messageItems[index - 1]?.message;
    const current = item.message;
    // Several Bots can answer one group task. Hide only a continuation by the
    // same speaker, never a new speaker (or a Bot after the user's request).
    if (current.turnId && previous?.turnId === current.turnId &&
        previous.role === current.role && previous.authorId === current.authorId) {
      item.showAuthor = false;
    }
  });

  // The last message of each turn decides where that turn's calls go.
  const lastOf = new Map<string, number>();
  messageItems.forEach((item, index) => {
    const turnId = item.message.turnId;
    if (!turnId) return;
    lastOf.set(turnId, index);
  });

  const out: ThreadItem[] = [];
  messageItems.forEach((item, index) => {
    out.push(item);
    const turnId = item.message.turnId;
    if (!turnId || lastOf.get(turnId) !== index) return;
    const entries = groups.get(turnId);
    if (!entries) return;
    out.push({ kind: 'turnActivity', key: `activity-${turnId}`, entries });
    groups.delete(turnId);
  });

  // A turn whose messages never arrived still has its calls to show.
  for (const [turnId, entries] of groups) {
    out.push({ kind: 'turnActivity', key: `activity-${turnId}`, entries });
  }
  return out;
}
