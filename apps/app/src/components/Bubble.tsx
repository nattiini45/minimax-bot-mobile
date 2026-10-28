import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';

/**
 * Chat bubble.
 *
 * The user's own message uses the high-contrast `user` pair; the team's reply uses the
 * recessed `bubble` surface, matching the desktop skin.
 */
export function Bubble({
  role,
  text,
  pending,
  author,
  reactions,
  onLongPress,
}: {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  pending?: boolean;
  author?: string;
  reactions?: { emoji: string; count: number }[];
  onLongPress?: () => void;
}) {
  const theme = useTheme();

  if (role === 'system') {
    return (
      <View style={styles.systemRow}>
        <Text style={[styles.systemText, { color: theme.colors.muted }]}>{text}</Text>
      </View>
    );
  }

  const isUser = role === 'user';
  const background = isUser ? theme.colors.user : theme.colors.bubble;
  const foreground = isUser ? theme.colors.userInk : theme.colors.ink;

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={280}
        disabled={!onLongPress}
        accessibilityRole={onLongPress ? 'button' : undefined}
        accessibilityLabel={onLongPress ? 'React to this message' : undefined}
        // A long press is not reachable with a screen reader or a keyboard, so the same
        // action is offered as an explicit one.
        accessibilityActions={onLongPress ? [{ name: 'longpress', label: 'React' }] : undefined}
        onAccessibilityAction={
          onLongPress
            ? (event) => {
                if (event.nativeEvent.actionName === 'longpress') onLongPress();
              }
            : undefined
        }
        style={[
          styles.bubble,
          {
            backgroundColor: background,
            borderColor: isUser ? 'transparent' : theme.colors.line,
            borderBottomRightRadius: isUser ? 6 : 18,
            borderBottomLeftRadius: isUser ? 18 : 6,
          },
        ]}
      >
        {author ? (
          <Text style={[styles.author, { color: isUser ? theme.colors.userInk : theme.colors.muted }]}>
            {author}
          </Text>
        ) : null}
        <Text style={[styles.text, { color: foreground }]}>{text}</Text>
        {pending ? (
          <Text style={[styles.pending, { color: isUser ? theme.colors.userInk : theme.colors.subtle }]}>
            {isUser ? 'sending…' : 'streaming…'}
          </Text>
        ) : null}
      </Pressable>
      {reactions && reactions.length > 0 ? (
        <View style={[styles.reactions, isUser ? styles.reactionsUser : styles.reactionsAssistant]}>
          {reactions.map((reaction) => (
            <View
              key={reaction.emoji}
              style={[styles.reaction, { backgroundColor: theme.colors.tag, borderColor: theme.colors.line }]}
            >
              <Text style={styles.reactionEmoji}>{reaction.emoji}</Text>
              {reaction.count > 1 ? (
                <Text style={[styles.reactionCount, { color: theme.colors.muted }]}>{reaction.count}</Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '86%',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  author: {
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 2,
  },
  text: {
    fontSize: 15,
    lineHeight: 21,
  },
  pending: {
    fontSize: 11,
    marginTop: 4,
  },
  reactions: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
  },
  reactionsUser: {
    justifyContent: 'flex-end',
  },
  reactionsAssistant: {
    justifyContent: 'flex-start',
  },
  reaction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  reactionEmoji: {
    fontSize: 12,
  },
  reactionCount: {
    fontSize: 11,
    fontWeight: '600',
  },
  systemRow: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 6,
  },
  systemText: {
    fontSize: 12,
    textAlign: 'center',
  },
});
