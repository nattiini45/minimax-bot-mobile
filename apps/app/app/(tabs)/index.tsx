import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../../src/components/Avatar';
import { Card, EmptyState, Pill, SectionHeader } from '../../src/components/primitives';
import { botPath, groupPath } from '../../src/nav/paths';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/** The team roster: every Bot and every group the desktop exposes. */
export default function TeamScreen() {
  const theme = useTheme();
  const router = useRouter();
  const bots = useAppStore((state) => state.bots);
  const groups = useAppStore((state) => state.groups);
  const diagnostics = useAppStore((state) => state.diagnostics);
  const session = useAppStore((state) => state.session);

  if (!session) {
    return (
      <View style={styles.screen}>
        <EmptyState
          icon="○"
          title="No desktop linked yet"
          body="Pair this phone with MiniMax Code to reach your team."
        />
        <View style={styles.cta}>
          <Pressable onPress={() => router.push('/pair')} style={[styles.ctaButton, { backgroundColor: theme.colors.user }]}>
            <Text style={[styles.ctaLabel, { color: theme.colors.userInk }]}>Pair this phone</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {!diagnostics.teamToolsAvailable ? (
        <Card style={{ marginBottom: 16 }}>
          <Text style={[styles.warningTitle, { color: theme.colors.warning }]}>The team is not linked</Text>
          <Text style={[styles.warningBody, { color: theme.colors.muted }]}>
            {diagnostics.reason ?? 'Open MiniMax Bot on your desktop so the bridge can reach the team tools.'}
          </Text>
        </Card>
      ) : null}

      <SectionHeader title={`Bots (${bots.length})`} />
      {bots.length === 0 ? (
        <Card>
          <EmptyState title="No bots yet" body="Ask the Chief Bot to build your team." />
        </Card>
      ) : (
        bots.map((bot) => (
          <Pressable
            key={bot.botId}
            accessibilityRole="button"
            accessibilityLabel={bot.name}
            onPress={() => router.push(botPath(bot.botId))}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: pressed ? theme.colors.hover : theme.colors.surface,
                borderColor: theme.colors.line,
              },
            ]}
          >
            <Avatar name={bot.name} skin={bot.skin} color={bot.color} size={42} />
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{bot.name}</Text>
              <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
                {bot.role ?? bot.description ?? 'Bot'}
              </Text>
            </View>
            {bot.isMain ? <Pill label="main" /> : null}
          </Pressable>
        ))
      )}

      {groups.length > 0 ? (
        <>
          <View style={{ height: 20 }} />
          <SectionHeader title={`Groups (${groups.length})`} />
          {groups.map((group) => (
            <Pressable
              key={group.groupId}
              accessibilityRole="button"
              accessibilityLabel={group.name}
              onPress={() => router.push(groupPath(group.groupId))}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? theme.colors.hover : theme.colors.surface,
                  borderColor: theme.colors.line,
                },
              ]}
            >
              <View style={[styles.groupMark, { backgroundColor: theme.colors.tag }]}>
                <Text style={{ color: theme.colors.muted, fontSize: 16 }}>◍</Text>
              </View>
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{group.name}</Text>
                <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
                  {group.memberIds.length} member{group.memberIds.length === 1 ? '' : 's'}
                  {group.replyMode ? ` · ${group.replyMode}` : ''}
                </Text>
              </View>
            </Pressable>
          ))}
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
    padding: 16,
    paddingBottom: 40,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
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
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  warningTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  warningBody: {
    fontSize: 13,
    lineHeight: 19,
  },
  cta: {
    paddingHorizontal: 16,
    paddingBottom: 32,
  },
  ctaButton: {
    borderRadius: 999,
    paddingVertical: 13,
    alignItems: 'center',
  },
  ctaLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
});
