import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

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
}: {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  pending?: boolean;
  author?: string;
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
      <View
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
            streaming…
          </Text>
        ) : null}
      </View>
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
