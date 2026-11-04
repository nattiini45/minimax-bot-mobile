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

import { Avatar, useBotSkins } from '../../src/components/Avatar';
import { Bubble } from '../../src/components/Bubble';
import { Button } from '../../src/components/Button';
import { ApprovalCard, QuestionCard } from '../../src/components/cards';
import { GroupMark, useGroupMark } from '../../src/components/GroupMark';
import { Icon } from '../../src/components/Icon';
import { EmptyState } from '../../src/components/primitives';
import { TurnActivity } from '../../src/components/TurnActivity';
import { WorkingIndicator } from '../../src/components/WorkingIndicator';
import { tapLight, tapMedium } from '../../src/native/haptics';
import { botPath, groupPath, toolboxPath } from '../../src/nav/paths';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';
import { OwnerBoundary, useOwnerGuard } from '../../src/state/OwnerBoundary';
import type { AppMessage } from '../../src/state/store';
import { buildThread, type ThreadItem } from '../../src/state/thread';

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
  const params = useLocalSearchParams<{ id: string }>();
  return <OwnerBoundary><ChatContent key={String(params.id ?? '')} /></OwnerBoundary>;
}

function ChatContent() {
  const isCurrentOwner = useOwnerGuard();
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const chatId = String(params.id ?? '');

  const bots = useAppStore((state) => state.bots);
  const groups = useAppStore((state) => state.groups);
  const messages = useAppStore((state) => state.messages[chatId]);
  const activity = useAppStore((state) => state.activity[chatId]);
  const activeTurn = useAppStore((state) => state.activeTurn[chatId]);
  const turnStartedAt = useAppStore((state) => state.turnStartedAt[chatId]);
  const reactions = useAppStore((state) => state.reactions);
  const requestAsync = useAppStore((state) => state.requestAsync);
  const sendChatMessage = useAppStore((state) => state.sendChatMessage);
  const react = useAppStore((state) => state.react);
  const retryMessage = useAppStore((state) => state.retryMessage);
  const respondPermission = useAppStore((state) => state.respondPermission);
  const answerQuestion = useAppStore((state) => state.answerQuestion);
  const decided = useAppStore((state) => state.decided);
  // The requests this conversation is waiting for. A permission check and a question
  // belong to the thread that raised them, so they are shown there and not in a list
  // somewhere else: the user answers where the question was asked.
  const allApprovals = useAppStore((state) => state.approvals);
  const allQuestions = useAppStore((state) => state.questions);
  const approvals = useMemo(
    () => allApprovals.filter((request) => request.chatId === chatId),
    [allApprovals, chatId],
  );
  const questions = useMemo(
    () => allQuestions.filter((request) => request.chatId === chatId),
    [allQuestions, chatId],
  );
  // The phone rebuilds its view of the conversation when it learns it has a hole.
  // The thread is read again then, because the copy on screen is the one that
  // was dropped: without this the conversation would be empty until the screen
  // was opened afresh.
  const resyncCount = useAppStore((state) => state.resyncCount);


  const savedDraft = useAppStore((state) => state.drafts[chatId]);
  const saveDraftAction = useAppStore((state) => state.setDraft);
  const saveDraft = useCallback((...args: Parameters<typeof saveDraftAction>) => {
    if (isCurrentOwner()) saveDraftAction(...args);
  }, [saveDraftAction, isCurrentOwner]);
  const draft = savedDraft?.text ?? '';
  const mentions = savedDraft?.mentions ?? [];
  const setDraft = (text: string) => saveDraft(chatId, { text, mentions });
  const [reactingTo, setReactingTo] = useState<string | null>(null);
  // Text the toolbox put into this conversation, waiting to be sent.
  const composerInsert = useAppStore((state) => state.composerInsert);
  const consumeComposerInsert = useAppStore((state) => state.consumeComposerInsert);
  useEffect(() => {
    if (!isCurrentOwner() || !composerInsert || composerInsert.chatId !== chatId) return;
    const insertion = consumeComposerInsert(composerInsert.token);
    if (!insertion) return;
    const current = useAppStore.getState().drafts[chatId];
    saveDraft(chatId, { text: current?.text ? `${current.text} ${insertion.text}` : insertion.text, mentions: current?.mentions ?? [] });
  }, [composerInsert, chatId, consumeComposerInsert, saveDraft, isCurrentOwner]);
  // The members this message names. A group decides who speaks first by who is
  // mentioned, so the phone has to say who it means.
  // Mentions are stored with this conversation's text, not shared between chats.
  // The picker belongs to the message it was opened on. Moving to another chat must
  // close it, or the next reaction would be sent to the wrong conversation.
  useEffect(() => {
    setReactingTo(null);
  }, [chatId]);
  const listRef = useRef<FlatList<ThreadItem>>(null);
  const lastCount = useRef(0);
  const followBottom = useRef(true);
  const positioned = useRef(false);
  useEffect(() => {
    followBottom.current = true;
    positioned.current = false;
    lastCount.current = 0;
  }, [chatId]);
  const follow = () => {
    if (!followBottom.current) return;
    listRef.current?.scrollToEnd({ animated: positioned.current });
    positioned.current = true;
  };

  const bot = bots.find((entry) => `bot:${entry.botId}` === chatId);
  const group = groups.find((entry) => `group:${entry.groupId}` === chatId);
  const thread = messages ?? [];
  // What the running turn is about: the last thing the user said. The desktop names it
  // while its Bot works, and the phone names it too, so the reader knows what is being
  // worked on rather than waiting on silence.
  const workingOn = useMemo(() => {
    const last = [...thread].reverse().find((message) => message.role === 'user');
    if (!last) return undefined;
    const text = last.text.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > 48 ? `${text.slice(0, 48)}…` : text;
  }, [thread]);
  /**
   * The thread as the reader sees it: the messages, and the tool calls of each turn
   * under the turn they belong to.
   */
  const items = useMemo(() => buildThread(thread, activity ?? []), [thread, activity]);
  // Every Bot on the roster gets a face of its own.
  const skins = useBotSkins(bots);
  // A group shows the pile of members the desktop shows.
  const groupPile = useGroupMark(group);

  /**
   * Who wrote a message.
   *
   * In a group the answer changes from message to message, so the sender is looked up
   * by id: every Bot in the team carries its own face, and a thread of six bots must
   * not look like one bot talking to itself.
   */
  const authorOf = (message: AppMessage) => {
    if (message.role === 'user') return undefined;
    const sender = message.authorId ? bots.find((entry) => entry.botId === message.authorId) : undefined;
    if (sender) {
      return {
        botId: sender.botId,
        name: sender.name,
        skin: sender.skin ?? skins[sender.botId],
        color: sender.color,
        avatar: sender.avatar,
      };
    }
    const fallback = bot?.name ?? group?.name;
    return fallback
      ? {
          name: fallback,
          botId: bot?.botId,
          skin: bot?.skin ?? (bot ? skins[bot.botId] : undefined),
          color: bot?.color,
          avatar: bot?.avatar,
        }
      : undefined;
  };

  const [historyError, setHistoryError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const load = useCallback(async () => {
    if (!isCurrentOwner()) return;
    setHistoryError(null);
    setLoadingHistory(true);
    try {
      await requestAsync('op.list_history', { chatId });
    } catch (error) {
      if (isCurrentOwner()) setHistoryError(error instanceof Error ? error.message : 'History could not be loaded.');
    } finally {
      if (isCurrentOwner()) setLoadingHistory(false);
    }
  }, [chatId, requestAsync, isCurrentOwner]);

  useEffect(() => {
    void load();
  }, [load, resyncCount]);

  useEffect(() => {
    if (thread.length > lastCount.current) {
      tapLight();
    }
    lastCount.current = thread.length;
  }, [thread.length]);

  const send = () => {
    if (!isCurrentOwner()) return;
    const text = draft.trim();
    if (!text) return;
    tapMedium();
    followBottom.current = true;
    saveDraft(chatId, { text: '', mentions: [] });
    sendChatMessage(chatId, text, mentions);
  };

  /**
   * Names a member in the message being written.
   *
   * A tap adds the member to the message; a second tap takes it back. The mention is
   * carried as the member's id, so the desktop can turn it into the name the team
   * reads.
   */
  const toggleMention = (botId: string) => {
    tapLight();
    saveDraft(chatId, { text: draft, mentions: mentions.includes(botId) ? mentions.filter((id) => id !== botId) : [...mentions, botId] });
  };

  const title = bot?.name ?? group?.name ?? 'Chat';
  const subtitle = bot?.role ?? (group ? `${group.memberIds.length} bots` : undefined);

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      // On iOS the view is padded above the keyboard; on Android the window itself is
      // resized, and the view has to give up its height so that the composer stays
      // above the keyboard instead of behind it.
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 44 : 0}
    >
      <View
        style={[
          styles.header,
          {
            borderBottomColor: theme.colors.line,
            backgroundColor: theme.colors.bg,
            // The header is the screen's own, so it has to leave the status bar the
            // room the system bar takes.
            paddingTop: insets.top + 10,
          },
        ]}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={({ pressed }) => [styles.back, { backgroundColor: pressed ? theme.colors.hover : 'transparent' }]}
        >
          <Icon name="chevron" size={20} color={theme.colors.ink} style={styles.backIcon} />
        </Pressable>

        {bot ? (
          <Avatar
            name={bot.name}
            botId={bot.botId}
            skin={bot.skin ?? skins[bot.botId]}
            color={bot.color}
            avatar={bot.avatar}
            size={34}
          />
        ) : group ? (
          <GroupMark members={groupPile} size={34} />
        ) : null}

        <View style={styles.headerText}>
          <Text style={[styles.headerTitle, { color: theme.colors.ink }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.headerSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {bot ? (
          <Pressable
            onPress={() => router.push(botPath(bot.botId))}
            accessibilityRole="button"
            accessibilityLabel="Bot settings"
            style={({ pressed }) => [styles.headerAction, { backgroundColor: pressed ? theme.colors.hover : 'transparent' }]}
          >
            <Icon name="bot" size={20} color={theme.colors.muted} />
          </Pressable>
        ) : null}

        {group ? (
          <Pressable
            onPress={() => router.push(groupPath(group.groupId))}
            accessibilityRole="button"
            accessibilityLabel="Group settings"
            style={({ pressed }) => [styles.headerAction, { backgroundColor: pressed ? theme.colors.hover : 'transparent' }]}
          >
            <Icon name="team" size={20} color={theme.colors.muted} />
          </Pressable>
        ) : null}

        {/* What the desktop can do: its skills, its plugins and its agents. */}
        <Pressable
          onPress={() => router.push(toolboxPath(chatId))}
          accessibilityRole="button"
          accessibilityLabel="Toolbox"
          style={({ pressed }) => [styles.headerAction, { backgroundColor: pressed ? theme.colors.hover : 'transparent' }]}
        >
          <Icon name="spark" size={20} color={theme.colors.muted} />
        </Pressable>
      </View>

      <FlatList
        ref={listRef}
        style={styles.listFlex}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) =>
          item.kind === 'message' ? (
            <View>
            <Bubble
              role={item.message.role}
              text={item.message.text}
              pending={item.message.pending}
              author={item.showAuthor ? authorOf(item.message) : undefined}
              reactions={reactions[item.message.messageId]}
              origin={item.message.origin}
              onLongPress={
                item.message.role === 'assistant' ? () => setReactingTo(item.message.messageId) : undefined
              }
            />
            {item.message.deliveryError ? (
              <View style={{ paddingHorizontal: 14, marginBottom: 12, gap: 8 }}>
                <Text accessibilityRole="alert" style={{ color: theme.colors.ink, fontSize: 13 }}>
                  {item.message.deliveryUncertain ? 'Delivery uncertain' : 'Not sent'}: {item.message.deliveryError}
                  {item.message.deliveryUncertain ? ' Check the desktop before sending again; it may already have run.' : ''}
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Button label="Edit message draft" size="sm" variant="secondary" onPress={() => {
                    const current = useAppStore.getState().drafts[chatId];
                    saveDraft(chatId, {
                      text: current?.text ? `${current.text}\n${item.message.text}` : item.message.text,
                      mentions: [...new Set([...(current?.mentions ?? []), ...(item.message.mentions ?? [])])],
                    });
                  }} />
                  {item.message.retryable && !item.message.deliveryUncertain ? (
                    <Button label="Retry message" size="sm" onPress={() => {
                      followBottom.current = true;
                      if (isCurrentOwner()) retryMessage(chatId, item.message.messageId);
                    }} />
                  ) : null}
                </View>
              </View>
            ) : null}
            </View>
          ) : (
            <TurnActivity entries={item.entries} />
          )
        }
        contentContainerStyle={styles.list}
        ListEmptyComponent={historyError ? (
          <View style={{ padding: 16, gap: 8 }}>
            <Text accessibilityRole="alert" style={{ color: theme.colors.ink }}>{historyError}</Text>
            <Button label="Retry history" variant="secondary" onPress={() => void load()} />
          </View>
        ) : loadingHistory ? <EmptyState title="Reading conversation…" /> : (
          <EmptyState
            icon="spark"
            title={`Say hello to ${title}`}
            body="Your message runs on the desktop; the reply streams back here."
          />
        )}
        // The cards a Bot's turn raised: the permission it asked for and the question it
        // put to the user, answered where they were asked.
        ListFooterComponent={
          approvals.length || questions.length ? (
            <View style={styles.requests}>
              {approvals.map((request) => (
                <ApprovalCard
                  key={request.requestId}
                  request={request}
                  decided={decided[request.requestId]}
                  onDecide={(decision) => { if (isCurrentOwner()) respondPermission(request.requestId, decision); }}
                />
              ))}
              {questions.map((request) => (
                <QuestionCard
                  key={request.requestId}
                  request={request}
                  decided={decided[request.requestId]}
                  onAnswer={(answers) => { if (isCurrentOwner()) answerQuestion(request.requestId, answers); }}
                />
              ))}
            </View>
          ) : undefined
        }
        onContentSizeChange={follow}
        scrollEventThrottle={16}
        onScroll={({ nativeEvent: { contentSize, contentOffset, layoutMeasurement } }) => {
          followBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= 80;
        }}
        // Resizing must respect someone reading older messages, too.
        onKeyboardDidShow={follow}
      />

      <WorkingIndicator
        activeTurn={activeTurn}
        actorName={bot?.name ?? group?.name}
        workingOn={workingOn}
        startedAt={turnStartedAt}
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
              const named = mentions.includes(item);
              return (
                <Pressable
                  onPress={() => toggleMention(item)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: named }}
                  accessibilityLabel={`Mention ${member?.name ?? item}`}
                  style={({ pressed }) => [
                    styles.mention,
                    {
                      backgroundColor: named
                        ? theme.colors.accentSoft
                        : pressed
                          ? theme.colors.hover
                          : theme.colors.tag,
                      borderColor: named ? theme.colors.accent : 'transparent',
                    },
                  ]}
                >
                  <Avatar
                    name={member?.name ?? item}
                    botId={member?.botId}
                    color={member?.color}
                    skin={member?.skin ?? skins[member?.botId ?? item]}
                    avatar={member?.avatar}
                    size={18}
                  />
                  <Text
                    style={[
                      styles.mentionText,
                      { color: named ? theme.colors.accent : theme.colors.muted },
                    ]}
                  >
                    @{member?.name ?? item}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      ) : null}

      {reactingTo ? (
        <View style={[styles.reactionBar, { backgroundColor: theme.colors.bg, borderTopColor: theme.colors.line }]}>
          {REACTION_EMOJI.map((emoji) => (
            <Pressable
              key={emoji}
              onPress={() => {
                if (!isCurrentOwner()) return;
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
            <Text style={[styles.reactionCancelText, { color: theme.colors.subtleText }]}>Cancel</Text>
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
          placeholderTextColor={theme.colors.subtleText}
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
          style={[
            styles.send,
            { backgroundColor: draft.trim() ? theme.colors.accent : theme.colors.tag },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !draft.trim() }}
          disabled={!draft.trim()}
          onPress={send}
        >
          <Icon name="send" size={18} color={draft.trim() ? theme.colors.accentInk : theme.colors.subtle} />
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: {
    transform: [{ rotate: '180deg' }],
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  headerSubtitle: {
    fontSize: 12,
    marginTop: 1,
  },
  headerAction: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
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
  requests: {
    gap: 8,
    marginTop: 10,
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
    borderWidth: StyleSheet.hairlineWidth,
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
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
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
});
