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
 *
 * The paths are typed as the router's own `Href`, so a screen can hand one straight to
 * `router.push` and the router still checks the route it names.
 */

import type { Href } from 'expo-router';

/** The route of one bot. */
export function botPath(botId: string): Href {
  return `/bot/${encodeURIComponent(botId)}` as Href;
}

/** The route of one group. */
export function groupPath(groupId: string): Href {
  return `/group/${encodeURIComponent(groupId)}` as Href;
}

/** The route of one conversation. */
export function chatPath(chatId: string): Href {
  return `/chat/${encodeURIComponent(chatId)}` as Href;
}

/**
 * The route of the toolbox: the desktop's skills, plugins and agents.
 *
 * The conversation it was opened from travels with it, so a skill picked there can be
 * put into that conversation's composer.
 */
export function toolboxPath(chatId?: string): Href {
  return (chatId ? `/toolbox?chat=${encodeURIComponent(chatId)}` : '/toolbox') as Href;
}
