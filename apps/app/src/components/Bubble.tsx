import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from './Avatar';
import { Markdown } from './Markdown';
import { useTheme } from '../theme';

/** Who a message came from, when the sender is a Bot. */
export interface MessageAuthor {
  botId?: string;
  name: string;
  skin?: string;
  color?: string;
  avatar?: string;
}

/**
 * Chat bubble.
 *
 * The user's own message uses the high-contrast `user` pair; the team's reply uses a
 * raised surface with a hairline edge, matching the desktop skin. A Bot's reply
 * carries the Bot's own face beside it, so a thread of six bots reads as six voices
 * and not as one long column.
 */
export function Bubble({
  role,
  text,
  pending,
  author,
  reactions,
  origin,
  onLongPress,
}: {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  pending?: boolean;
  author?: MessageAuthor;
  reactions?: { emoji: string; count: number }[];
  /**
   * Where the message was written.
   *
   * A message the user typed on the desktop is marked, because from the phone it would
   * otherwise be indistinguishable from one the phone sent. The desktop marks the
   * messages that arrive from the phone the same way.
   */
  origin?: 'desktop';
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

  const bubble = (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={280}
      disabled={!onLongPress}
      accessibilityRole={onLongPress ? 'text' : undefined}
      accessibilityLabel={onLongPress ? text : undefined}
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
          borderBottomRightRadius: isUser ? 6 : theme.radius.bubble,
          borderBottomLeftRadius: isUser ? theme.radius.bubble : 6,
        },
      ]}
    >
      {isUser ? (
        <Text style={[styles.text, { color: foreground }]}>{text}</Text>
      ) : (
        <Markdown text={text} style={[styles.text, { color: foreground }]} />
      )}
      {pending ? (
        <Text style={[styles.pending, { color: isUser ? theme.colors.userInk : theme.colors.subtleText }]}>
          {isUser ? 'sending…' : 'streaming…'}
        </Text>
      ) : null}
    </Pressable>
  );

  const name = author?.name;

  return (
    <View style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}>
      {!isUser && name ? (
        <View style={styles.avatarColumn}>
          <Avatar
            name={name}
            botId={author?.botId}
            skin={author?.skin}
            color={author?.color}
            avatar={author?.avatar}
            size={28}
          />
        </View>
      ) : null}

      <View style={styles.bubbleColumn}>
        {!isUser && name ? (
          <Text style={[styles.author, { color: theme.colors.muted }]}>{name}</Text>
        ) : null}
        {origin === 'desktop' ? (
          <Text style={[styles.origin, { color: theme.colors.subtleText }]}>From your desktop</Text>
        ) : null}
        {bubble}
        {onLongPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="React to this message"
            onPress={onLongPress}
            style={{ alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 4 }}
          >
            <Text style={{ color: theme.colors.muted, fontSize: 12 }}>React</Text>
          </Pressable>
        ) : null}
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
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingHorizontal: 14,
    marginBottom: 10,
    alignItems: 'flex-start',
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  avatarColumn: {
    width: 28,
    marginRight: 10,
    paddingTop: 2,
  },
  bubbleColumn: {
    maxWidth: '86%',
  },
  bubble: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  author: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
    marginLeft: 2,
  },
  origin: {
    fontSize: 11,
    marginBottom: 4,
    marginLeft: 2,
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
  },
  pending: {
    fontSize: 11,
    marginTop: 4,
  },
  reactions: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 5,
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
