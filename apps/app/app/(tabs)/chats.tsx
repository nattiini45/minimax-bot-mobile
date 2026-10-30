import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../../src/components/Avatar';
import { EmptyState, SectionHeader } from '../../src/components/primitives';
import { chatPath } from '../../src/nav/paths';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/** Every conversation the team exposes: one thread per Bot, one per group. */
export default function ChatsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const bots = useAppStore((state) => state.bots);
  const groups = useAppStore((state) => state.groups);
  const messages = useAppStore((state) => state.messages);
  const session = useAppStore((state) => state.session);

  if (!session) {
    return (
      <View style={styles.screen}>
        <EmptyState icon="○" title="No desktop linked yet" body="Pair this phone to reach your team." />
      </View>
    );
  }

  const lastFor = (chatId: string) => {
    const list = messages[chatId] ?? [];
    return list[list.length - 1];
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionHeader title="Bots" />
      {bots.length === 0 ? (
        <EmptyState title="No bots yet" />
      ) : (
        bots.map((bot) => {
          const chatId = `bot:${bot.botId}`;
          const last = lastFor(chatId);
          return (
            <Pressable
              key={bot.botId}
              accessibilityRole="button"
              accessibilityLabel={`Chat with ${bot.name}`}
              onPress={() => router.push(chatPath(chatId))}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? theme.colors.hover : 'transparent',
                  borderBottomColor: theme.colors.line,
                },
              ]}
            >
              <Avatar name={bot.name} skin={bot.skin} color={bot.color} size={40} />
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{bot.name}</Text>
                <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
                  {last ? last.text : (bot.role ?? 'Start a conversation')}
                </Text>
              </View>
            </Pressable>
          );
        })
      )}

      {groups.length > 0 ? (
        <>
          <View style={{ height: 20 }} />
          <SectionHeader title="Groups" />
          {groups.map((group) => {
            const chatId = `group:${group.groupId}`;
            const last = lastFor(chatId);
            return (
              <Pressable
                key={group.groupId}
                accessibilityRole="button"
                accessibilityLabel={`Open ${group.name}`}
                onPress={() => router.push(chatPath(chatId))}
                style={({ pressed }) => [
                  styles.row,
                  {
                    backgroundColor: pressed ? theme.colors.hover : 'transparent',
                    borderBottomColor: theme.colors.line,
                  },
                ]}
              >
                <View style={[styles.groupMark, { backgroundColor: theme.colors.tag }]}>
                  <Text style={{ color: theme.colors.muted, fontSize: 16 }}>◍</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{group.name}</Text>
                  <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
                    {last ? last.text : (group.notice ?? `${group.memberIds.length} members`)}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  groupMark: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
