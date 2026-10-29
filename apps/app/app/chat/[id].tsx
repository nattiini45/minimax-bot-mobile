import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActivityRail } from '../../src/components/ActivityRail';
import { Avatar } from '../../src/components/Avatar';
import { Bubble } from '../../src/components/Bubble';
import { EmptyState } from '../../src/components/primitives';
import { tapLight, tapMedium } from '../../src/native/haptics';
import { notify } from '../../src/native/notifications';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';
import type { AppMessage } from '../../src/state/store';

/** The reactions offered when a message is held down. */
const REACTION_EMOJI = ['👍', '🎉', '🔥', '👀', '✅'];

/**
 * A conversation.
 *
 * The desktop owns the thread, so the composer sends an operation and the screen waits
 * for the bridge's events. An optimistic bubble keeps the typing feeling instant and is
 * reconciled when the real message comes back.
 */
export default function ChatScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const chatId = useMemo(() => decodeURIComponent(String(params.id ?? '')), [params.id]);

  const bots = useAppStore((state) => state.bots);
  const groups = useAppStore((state) => state.groups);
  const messages = useAppStore((state) => state.messages[chatId]);
  const activity = useAppStore((state) => state.activity[chatId]);
  const activeTurn = useAppStore((state) => state.activeTurn[chatId]);
  const reactions = useAppStore((state) => state.reactions);
  const requestAsync = useAppStore((state) => state.requestAsync);
  const sendChatMessage = useAppStore((state) => state.sendChatMessage);
  const react = useAppStore((state) => state.react);
  // The phone rebuilds its view of the conversation when it learns it has a hole.
  // The thread is read again then, because the copy on screen is the one that
  // was dropped: without this the conversation would be empty until the screen
  // was opened afresh.
  const resyncCount = useAppStore((state) => state.resyncCount);

  const [draft, setDraft] = useState('');
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  // The picker belongs to the message it was opened on. Moving to another chat must
  // close it, or the next reaction would be sent to the wrong conversation.
  useEffect(() => {
    setReactingTo(null);
  }, [chatId]);
  const listRef = useRef<FlatList<AppMessage>>(null);
  const lastCount = useRef(0);

  const bot = bots.find((entry) => `bot:${entry.botId}` === chatId);
  const group = groups.find((entry) => `group:${entry.groupId}` === chatId);
  const thread = messages ?? [];

  const load = useCallback(async () => {
    try {
      await requestAsync('op.list_history', { chatId });
    } catch {
      /* the banner reports the failure */
    }
  }, [chatId, requestAsync]);

  useEffect(() => {
    void load();
  }, [load, resyncCount]);

  useEffect(() => {
    if (thread.length > lastCount.current) {
      tapLight();
      void notify(group?.name ?? bot?.name ?? 'New message', thread[thread.length - 1]?.text ?? '');
    }
    lastCount.current = thread.length;
  }, [thread.length, bot?.name, group?.name]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    tapMedium();
    setDraft('');
    sendChatMessage(chatId, text);
  };

  const title = bot?.name ?? group?.name ?? 'Chat';

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top + 44}
    >
      <FlatList
        ref={listRef}
        style={styles.listFlex}
        data={thread}
        keyExtractor={(item) => `${item.messageId}-${item.ts}`}
        renderItem={({ item }) => (
          <Bubble
            role={item.role}
            text={item.text}
            pending={item.pending}
            author={item.role === 'assistant' ? (bot?.name ?? group?.name) : undefined}
            reactions={reactions[item.messageId]}
            onLongPress={item.role === 'assistant' ? () => setReactingTo(item.messageId) : undefined}
          />
        )}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <EmptyState
            icon="✳"
            title={`Say hello to ${title}`}
            body="Your message runs on the desktop; the reply streams back here."
          />
        }
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
      />

      <ActivityRail
        activity={activity ?? []}
        activeTurn={activeTurn}
        actorName={bot?.name ?? group?.name}
      />

      {group ? (
        <View style={[styles.mentions, { borderTopColor: theme.colors.line, backgroundColor: theme.colors.bg }]}>
          <FlatList
            horizontal
            data={group.memberIds}
            keyExtractor={(id) => id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.mentionRow}
            renderItem={({ item }) => {
              const member = bots.find((entry) => entry.botId === item);
              return (
                <View style={[styles.mention, { backgroundColor: theme.colors.tag }]}>
                  <Avatar name={member?.name ?? item} color={member?.color} size={18} />
                  <Text style={[styles.mentionText, { color: theme.colors.muted }]}>
                    @{member?.name ?? item}
                  </Text>
                </View>
              );
            }}
          />
        </View>
      ) : null}

      {bot ? (
        <Text
          style={[styles.headerLink, { color: theme.colors.muted }]}
          onPress={() => router.push(`/bot/${bot.botId}`)}
        >
          Bot details
        </Text>
      ) : null}

      {reactingTo ? (
        <View style={[styles.reactionBar, { backgroundColor: theme.colors.bg, borderTopColor: theme.colors.line }]}>
          {REACTION_EMOJI.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={() => {
                tapLight();
                react(reactingTo, emoji);
                setReactingTo(null);
              }}
              accessibilityRole="button"
              accessibilityLabel={`React ${emoji}`}
              style={[styles.reactionButton, { backgroundColor: theme.colors.surface, borderColor: theme.colors.line }]}
            >
              <Text style={styles.reactionEmoji}>{emoji}</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => setReactingTo(null)}
            accessibilityRole="button"
            accessibilityLabel="Cancel reaction"
            style={styles.reactionCancel}
          >
            <Text style={[styles.reactionCancelText, { color: theme.colors.subtle }]}>Cancel</Text>
          </Pressable>
        </View>
      ) : null}

      <View
        style={[
          styles.composer,
          {
            borderTopColor: theme.colors.line,
            backgroundColor: theme.colors.bg,
            paddingBottom: Math.max(insets.bottom, 10),
          },
        ]}
      >
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={group ? `Message ${group.name}` : `Message ${title}`}
          placeholderTextColor={theme.colors.subtle}
          multiline
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: theme.minInputFontSize,
            },
          ]}
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={send}
          accessibilityLabel="Message"
        />
        <Pressable
          style={[styles.send, { backgroundColor: draft.trim() ? theme.colors.user : theme.colors.tag }]}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !draft.trim() }}
          disabled={!draft.trim()}
          onPress={send}
        >
          <Text style={[styles.sendLabel, { color: draft.trim() ? theme.colors.userInk : theme.colors.subtle }]}>
            ↑
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  listFlex: {
    flex: 1,
  },
  list: {
    padding: 12,
    paddingBottom: 20,
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  mentions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 8,
  },
  reactionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  reactionButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  reactionEmoji: {
    fontSize: 18,
  },
  reactionCancel: {
    marginLeft: 'auto',
    paddingHorizontal: 6,
  },
  reactionCancelText: {
    fontSize: 13,
  },
  mentionRow: {
    paddingHorizontal: 14,
    gap: 8,
  },
  mention: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  mentionText: {
    fontSize: 12,
    fontWeight: '500',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 140,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 11,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendLabel: {
    fontSize: 20,
    fontWeight: '700',
  },
  headerLink: {
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: 6,
  },
});
