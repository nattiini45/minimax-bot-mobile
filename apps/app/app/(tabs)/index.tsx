import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../src/components/Button';
import { Avatar, useBotSkins } from '../../src/components/Avatar';
import { GroupMark, useGroupPiles } from '../../src/components/GroupMark';
import { Icon } from '../../src/components/Icon';
import { Card, EmptyState, Pill, SectionHeader } from '../../src/components/primitives';
import { chatPath, toolboxPath } from '../../src/nav/paths';
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
  const lastError = useAppStore((state) => state.lastError);
  const clearError = useAppStore((state) => state.clearError);
  const bridgeOnline = useAppStore((state) => state.bridgeOnline);
  const desktopKnown = useAppStore((state) => state.desktopKnown);
  // Every Bot on the roster gets a face of its own.
  const skins = useBotSkins(bots);
  // Every group has the picture the desktop shows: a pile of its members.
  const piles = useGroupPiles();

  if (!session) {
    return (
      <View style={styles.screen}>
        <EmptyState
          icon="link"
          title="No desktop linked yet"
          body="Pair this phone with MiniMax Code to reach your team."
        />
        {/* The reason the phone lost its link, when there is one: "Pair this phone"
            on its own does not say why the phone is asking to be paired again. */}
        {lastError ? (
          <Card style={styles.reason}>
            <Text accessibilityRole="alert" style={[styles.warningTitle, { color: theme.colors.ink }]}>{lastError}</Text>
            <Button label="Dismiss error" variant="ghost" size="sm" onPress={clearError} />
          </Card>
        ) : null}
        <View style={styles.cta}>
          <Pressable onPress={() => router.push('/pair')} style={[styles.ctaButton, { backgroundColor: theme.colors.accent }]}>
            <Text style={[styles.ctaLabel, { color: theme.colors.accentInk }]}>Pair this phone</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // The desktop has not answered yet.
  //
  // Saying the team is not linked now would be a guess, and the wrong one most of
  // the time: the desktop is usually up and the phone is simply early. The relay's
  // replay is history — it is applied as one batch when it has all arrived — so
  // until then there is nothing to show and nothing to complain about.
  const desktopAnswered =
    diagnostics.teamToolsAvailable === true || typeof diagnostics.reason === 'string';

  if (!desktopAnswered) {
    const offline = desktopKnown && !bridgeOnline;
    return (
      <View style={styles.screen}>
        <EmptyState
          icon={offline ? 'link' : 'pulse'}
          title={offline ? 'Your desktop is offline' : 'Connecting to your desktop…'}
          body={
            offline
              ? 'Start MiniMax Code on your desktop to reach the team.'
              : 'The team appears as soon as your desktop answers.'
          }
        />
      </View>
    );
  }

  const live = bridgeOnline && diagnostics.teamToolsAvailable;

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

      {/* The team at a glance: who is on it, and whether the desktop is answering. */}
      {bots.length > 0 ? (
        <Card style={styles.hero}>
          <View style={styles.heroText}>
            <Text style={[styles.heroTitle, { color: theme.colors.ink }]}>Your team</Text>
            <Text style={[styles.heroSubtitle, { color: theme.colors.muted }]}>
              {bots.length} bot{bots.length === 1 ? '' : 's'}
              {groups.length > 0 ? ` · ${groups.length} group${groups.length === 1 ? '' : 's'}` : ''}
            </Text>
            <View style={styles.heroStatus}>
              <Pill label={live ? 'Live' : 'Offline'} tone={live ? 'success' : 'neutral'} />
            </View>
          </View>
          <View style={styles.facepile}>
            {bots.slice(0, 6).map((bot, index) => (
              <View
                key={bot.botId}
                style={[
                  styles.face,
                  {
                    marginLeft: index === 0 ? 0 : -8,
                    zIndex: 6 - index,
                    // The ring is the card's own colour, so a stack of faces reads as
                    // six faces rather than as one row of overlapping colours.
                    borderColor: theme.colors.surface,
                  },
                ]}
              >
                <Avatar
                  name={bot.name}
                  botId={bot.botId}
                  skin={bot.skin ?? skins[bot.botId]}
                  color={bot.color}
                  avatar={bot.avatar}
                  size={34}
                />
              </View>
            ))}
          </View>
        </Card>
      ) : null}

      <SectionHeader title="Bots" caption={bots.length > 0 ? `${bots.length}` : undefined} />
      {bots.length === 0 ? (
        <Card>
          <EmptyState title="No bots yet" body="Ask the Chief Bot to build your team." />
        </Card>
      ) : (
        <Card flush>
          {bots.map((bot, index) => (
            <Pressable
              key={bot.botId}
              accessibilityRole="button"
              accessibilityLabel={`Chat with ${bot.name}`}
              // A Bot is a conversation first: its settings live behind the Bot's own
              // conversation, not in the way of getting there.
              onPress={() => router.push(chatPath(`bot:${bot.botId}`))}
              style={({ pressed }) => [
                styles.row,
                index === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
                { backgroundColor: pressed ? theme.colors.hover : 'transparent' },
              ]}
            >
              <Avatar
                name={bot.name}
                botId={bot.botId}
                skin={bot.skin ?? skins[bot.botId]}
                color={bot.color}
                avatar={bot.avatar}
                size={42}
                ring={bot.isMain}
              />
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{bot.name}</Text>
                <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
                  {bot.role ?? bot.description ?? 'Bot'}
                </Text>
              </View>
              {bot.isMain ? <Pill label="main" tone="accent" /> : null}
              <Icon name="chevron" size={16} color={theme.colors.subtle} />
            </Pressable>
          ))}
        </Card>
      )}

      {/* What the desktop can do: its skills, its plugins and its agents. */}
      <View style={{ height: 20 }} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Toolbox"
        onPress={() => router.push(toolboxPath())}
        style={({ pressed }) => [
          styles.toolbox,
          {
            backgroundColor: pressed ? theme.colors.hover : theme.colors.surface,
            borderColor: theme.colors.line,
          },
        ]}
      >
        <View style={[styles.toolboxMark, { backgroundColor: theme.colors.accentSoft }]}>
          <Icon name="spark" size={20} color={theme.colors.accent} />
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>Toolbox</Text>
          <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
            The skills, plugins and agents your desktop has
          </Text>
        </View>
        <Icon name="chevron" size={16} color={theme.colors.subtle} />
      </Pressable>

      {groups.length > 0 ? (
        <>
          <View style={{ height: 20 }} />
          <SectionHeader title="Groups" caption={`${groups.length}`} />
          <Card flush>
            {groups.map((group, index) => (
              <Pressable
                key={group.groupId}
                accessibilityRole="button"
                accessibilityLabel={`Open ${group.name}`}
                onPress={() => router.push(chatPath(`group:${group.groupId}`))}
                style={({ pressed }) => [
                  styles.row,
                  index === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
                  { backgroundColor: pressed ? theme.colors.hover : 'transparent' },
                ]}
              >
                {/* The group's picture: the pile of members the desktop shows. The pile
                    sits in a card, so its halo takes the card's own colour. */}
                <GroupMark members={piles[group.groupId] ?? []} size={42} haloColor={theme.colors.surface} />
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{group.name}</Text>
                  <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]} numberOfLines={1}>
                    {group.memberIds.length} member{group.memberIds.length === 1 ? '' : 's'}
                    {group.replyMode ? ` · ${group.replyMode}` : ''}
                  </Text>
                </View>
                <Icon name="chevron" size={16} color={theme.colors.subtle} />
              </Pressable>
            ))}
          </Card>
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
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  heroText: {
    flex: 1,
  },
  heroTitle: {
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  heroSubtitle: {
    fontSize: 13,
    marginTop: 3,
  },
  heroStatus: {
    flexDirection: 'row',
    marginTop: 10,
  },
  facepile: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  face: {
    borderRadius: 21,
    borderWidth: 2,
    padding: 2,
    backgroundColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
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
  toolbox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
  },
  toolboxMark: {
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
  reason: {
    marginHorizontal: 16,
    marginBottom: 12,
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
