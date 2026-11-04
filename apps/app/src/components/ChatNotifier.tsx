import { usePathname } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { notify } from '../native/notifications';
import { useAppStore } from '../state/store';

/**
 * Tells the phone that something arrived while it was not looking.
 *
 * A notification is for a message the user has not seen yet, in a conversation they are
 * not reading. A notification for a message the user just sent, or for one that arrived
 * in the conversation on screen, is noise — and noise that repeats for every message in
 * a conversation is worse than no notification at all.
 *
 * So a notification is scheduled only when all three hold:
 *
 * - the message is one the team wrote, not one the phone sent;
 * - the app is in the background, because a message that arrives while the app is open
 *   is on screen already;
 * - the conversation is not the one on screen.
 *
 * The notification names the conversation and carries its id, so that opening it opens
 * that conversation and not whichever one the app was last showing.
 */
export function ChatNotifier(): null {
  const messages = useAppStore((state) => state.messages);
  const bots = useAppStore((state) => state.bots);
  const groups = useAppStore((state) => state.groups);
  const pathname = usePathname();
  const [foreground, setForeground] = useState(() => AppState.currentState === 'active');
  /** The message ids that have been seen, per conversation. */
  const seen = useRef<Record<string, Set<string>>>({});
  /** The conversations whose thread has been read at least once. */
  const read = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    for (const [chatId, thread] of Object.entries(messages)) {
      const known = seen.current[chatId] ?? new Set<string>();
      const first = !read.current[chatId];
      read.current[chatId] = true;
      for (const message of thread) {
        if (known.has(message.messageId)) continue;
        known.add(message.messageId);
        // A thread that is read for the first time is a thread that was already there.
        if (first) continue;
        // The phone's own message is not news.
        if (message.role === 'user') continue;
        if (foreground) continue;
        // The conversation on screen is not news either.
        if (pathname === `/chat/${encodeURIComponent(chatId)}`) continue;
        void notify(nameOf(chatId, bots, groups), chatId);
      }
      seen.current[chatId] = known;
    }
  }, [bots, foreground, groups, messages, pathname]);

  return null;
}

/**
 * The name a conversation is known by.
 *
 * The chat id says what it is — `bot:<id>` or `group:<id>` — and the roster says what
 * it is called. A conversation the roster does not know is named after its kind.
 */
function nameOf(
  chatId: string,
  bots: Array<{ botId: string; name: string }>,
  groups: Array<{ groupId: string; name: string }>,
): string {
  if (chatId.startsWith('bot:')) {
    const botId = chatId.slice(4);
    return bots.find((bot) => bot.botId === botId)?.name ?? 'A Bot';
  }
  if (chatId.startsWith('group:')) {
    const groupId = chatId.slice(6);
    return groups.find((group) => group.groupId === groupId)?.name ?? 'A group';
  }
  return 'A conversation';
}
