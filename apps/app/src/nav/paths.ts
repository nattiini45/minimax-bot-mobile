/**
 * The routes the phone navigates to.
 *
 * The ids in these paths come from the relay: they are the bot ids and group ids the
 * team tools report. An id is a piece of text from somewhere else, so it is encoded
 * before it goes into a path: an id that contains a slash or a `..` would otherwise
 * address a different route than the one that was meant.
 *
 * The ids are read back with `useLocalSearchParams`, which decodes them, so what the
 * screen sees is the id the roster reported.
 */

/** The route of one bot. */
export function botPath(botId: string): string {
  return `/bot/${encodeURIComponent(botId)}`;
}

/** The route of one group. */
export function groupPath(groupId: string): string {
  return `/group/${encodeURIComponent(groupId)}`;
}

/** The route of one conversation. */
export function chatPath(chatId: string): string {
  return `/chat/${encodeURIComponent(chatId)}`;
}
