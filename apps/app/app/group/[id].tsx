import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '../../src/components/Avatar';
import { Button } from '../../src/components/Button';
import { Card, EmptyState, Pill, SectionHeader } from '../../src/components/primitives';
import { tapLight } from '../../src/native/haptics';
import { botPath, chatPath } from '../../src/nav/paths';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/** A group: its members, who answers, and how the conversation is routed. */
export default function GroupScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const groupId = String(params.id ?? '');

  const groups = useAppStore((state) => state.groups);
  const bots = useAppStore((state) => state.bots);
  const group = groups.find((entry) => entry.groupId === groupId);

  if (!group) {
    return (
      <View style={styles.screen}>
        <EmptyState title="This group is not available" body="It may have been removed on the desktop." />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={[styles.mark, { backgroundColor: theme.colors.tag }]}>
          <Text style={{ color: theme.colors.muted, fontSize: 22 }}>◍</Text>
        </View>
        <Text style={[styles.name, { color: theme.colors.ink }]}>{group.name}</Text>
        <Text style={[styles.meta, { color: theme.colors.muted }]}>
          {group.replyMode === 'all' ? 'Everyone replies' : 'The admin answers by default'}
        </Text>
      </View>

      {group.notice ? (
        <>
          <SectionHeader title="Notice" />
          <Card>
            <Text style={[styles.notice, { color: theme.colors.ink }]}>{group.notice}</Text>
          </Card>
        </>
      ) : null}

      <View style={styles.actions}>
        <Button
          label="Open group chat"
          variant="primary"
          onPress={() => router.push(chatPath(`group:${group.groupId}`))}
        />
      </View>

      <View style={{ height: 20 }} />
      <SectionHeader title={`Members (${group.memberIds.length})`} />
      <Card>
        {group.memberIds.map((id) => {
          const member = bots.find((entry) => entry.botId === id);
          return (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityLabel={member?.name ?? id}
              onPress={() => {
                tapLight();
                router.push(botPath(id));
              }}
              style={[styles.member, { borderBottomColor: theme.colors.line }]}
            >
              <Avatar name={member?.name ?? id} color={member?.color} size={32} />
              <View style={styles.memberText}>
                <Text style={[styles.memberName, { color: theme.colors.ink }]}>{member?.name ?? id}</Text>
                <Text style={[styles.memberRole, { color: theme.colors.muted }]} numberOfLines={1}>
                  {member?.role ?? 'Bot'}
                </Text>
              </View>
              {group.admin === id ? <Pill label="admin" /> : null}
            </Pressable>
          );
        })}
      </Card>
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
  header: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  mark: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 8,
  },
  meta: {
    fontSize: 13,
  },
  notice: {
    fontSize: 14,
    lineHeight: 20,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 12,
  },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memberText: {
    flex: 1,
  },
  memberName: {
    fontSize: 14,
    fontWeight: '500',
  },
  memberRole: {
    fontSize: 12,
    marginTop: 1,
  },
});
