import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Capabilities, CapabilityItem } from '@minimax-bot/protocol';

import { Avatar, useBotSkins } from '../src/components/Avatar';
import { Icon } from '../src/components/Icon';
import { Card, EmptyState, SectionHeader } from '../src/components/primitives';
import { tapLight, tapMedium } from '../src/native/haptics';
import { chatPath } from '../src/nav/paths';
import { useTheme } from '../src/theme';
import { useAppStore } from '../src/state/store';

/**
 * What the desktop can do.
 *
 * The skills, plugins, agents and MCP servers are the desktop's own: the bridge reads
 * their inventory and sends it here. Picking a skill puts its slash-name into a
 * conversation's composer. The other inventories are read-only; nothing is executed
 * by choosing an entry.
 */
export default function ToolboxScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ chat?: string }>();
  const chatId = String(params.chat ?? '');

  const bots = useAppStore((state) => state.bots);
  const requestAsync = useAppStore((state) => state.requestAsync);
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer);
  // Every Bot on the roster gets a face of its own.
  const skins = useBotSkins(bots);

  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [picking, setPicking] = useState<CapabilityItem | null>(null);

  const load = useCallback(async () => {
    try {
      const result = (await requestAsync('op.list_capabilities', {})) as Capabilities | null;
      setCapabilities(result);
      setFailed(false);
    } catch {
      setCapabilities(null);
      setFailed(true);
    }
  }, [requestAsync]);

  useEffect(() => {
    void load();
  }, [load]);

  const needle = search.trim().toLowerCase();
  const matches = (item: CapabilityItem) =>
    !needle ||
    item.name.toLowerCase().includes(needle) ||
    item.id.toLowerCase().includes(needle) ||
    (item.description ?? '').toLowerCase().includes(needle);

  const skills = useMemo(
    () => (capabilities?.skills ?? []).filter(matches),
    [capabilities, needle],
  );
  const plugins = useMemo(
    () => (capabilities?.plugins ?? []).filter(matches),
    [capabilities, needle],
  );
  const agents = useMemo(
    () => (capabilities?.agents ?? []).filter(matches),
    [capabilities, needle],
  );
  const servers = useMemo(
    () => (capabilities?.mcp ?? []).filter(matches),
    [capabilities, needle],
  );

  /**
   * Puts a skill into the composer of the conversation the toolbox was opened from,
   * or asks which Bot should get it.
   */
  const choose = (item: CapabilityItem) => {
    tapMedium();
    const text = `/${item.id}`;
    if (chatId) {
      insertIntoComposer(chatId, text);
      router.back();
      return;
    }
    setPicking(item);
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { borderBottomColor: theme.colors.line }]}>
        <Text style={[styles.subtitle, { color: theme.colors.muted }]}>
          Browse your desktop's skills, plugins, agents and MCP servers. Pick a skill to put
          its name in your draft. Other entries are read-only.
        </Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search"
          placeholderTextColor={theme.colors.subtleText}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            styles.search,
            {
              backgroundColor: theme.colors.surface,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: theme.minInputFontSize,
            },
          ]}
          accessibilityLabel="Search"
        />
      </View>

      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {failed ? (
          <Card>
            <EmptyState
              icon="link"
              title="The desktop did not answer"
              body="Open MiniMax Code on your desktop so the phone can read what it can do."
            />
          </Card>
        ) : null}

        {!failed && !capabilities ? (
          <EmptyState title="Reading the desktop…" body="One moment." />
        ) : null}

        {capabilities ? (
          <>
            <SectionHeader
              title="Skills"
              caption={`${skills.length}${
                capabilities.skills.length ? ` of ${capabilities.skills.length}` : ''
              }`}
            />
            {skills.length === 0 ? (
              <Card>
                <EmptyState title="No skill matches" body="Try another word." />
              </Card>
            ) : (
              <Card flush>
                {skills.map((skill, index) => (
                  <Pressable
                    key={skill.id}
                    onPress={() => choose(skill)}
                    accessibilityRole="button"
                    accessibilityLabel={`Use ${skill.id}`}
                    style={({ pressed }) => [
                      styles.row,
                      index === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
                      { backgroundColor: pressed ? theme.colors.hover : 'transparent' },
                    ]}
                  >
                    <View style={[styles.mark, { backgroundColor: theme.colors.accentSoft }]}>
                      <Text style={[styles.markText, { color: theme.colors.accent }]}>
                        /{skill.id.slice(0, 1).toUpperCase()}
                      </Text>
                    </View>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>/{skill.id}</Text>
                      {skill.description ? (
                        <Text
                          style={[styles.rowSubtitle, { color: theme.colors.muted }]}
                          numberOfLines={2}
                        >
                          {skill.description}
                        </Text>
                      ) : null}
                    </View>
                    <Icon name="chevron" size={16} color={theme.colors.subtle} />
                  </Pressable>
                ))}
              </Card>
            )}

            <View style={{ height: 20 }} />
            <SectionHeader
              title="Plugins"
              caption={`${plugins.length}${
                capabilities.plugins.length ? ` of ${capabilities.plugins.length}` : ''
              }`}
            />
            {plugins.length === 0 ? (
              <Card>
                <EmptyState title="No plugin matches" body="Try another word." />
              </Card>
            ) : (
              <Card flush>
                {plugins.map((plugin, index) => (
                  <View
                    key={plugin.id}
                    style={[
                      styles.row,
                      index === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
                    ]}
                  >
                    <View style={[styles.mark, { backgroundColor: theme.colors.tag }]}>
                      <Icon name="bot" size={18} color={theme.colors.muted} />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>
                        {plugin.name}
                      </Text>
                      {plugin.description ? (
                        <Text
                          style={[styles.rowSubtitle, { color: theme.colors.muted }]}
                          numberOfLines={2}
                        >
                          {plugin.description}
                        </Text>
                      ) : null}
                      <Text style={[styles.rowMeta, { color: theme.colors.subtleText }]}>
                        {plugin.source === 'installed' ? 'installed' : 'official'}
                        {plugin.version ? ` · ${plugin.version}` : ''}
                      </Text>
                    </View>
                  </View>
                ))}
              </Card>
            )}

            <View style={{ height: 20 }} />
            <SectionHeader
              title="MCP servers"
              caption={`${servers.length}${
                capabilities.mcp.length ? ` of ${capabilities.mcp.length}` : ''
              }`}
            />
            {servers.length === 0 ? (
              <Card>
                <EmptyState title="No MCP server matches" body="Try another word." />
              </Card>
            ) : (
              <Card flush>
                {servers.map((server, index) => (
                  <View
                    key={server.id}
                    style={[
                      styles.row,
                      index === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
                    ]}
                  >
                    <View style={[styles.mark, { backgroundColor: theme.colors.tag }]}>
                      <Icon name="link" size={18} color={theme.colors.muted} />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{server.name}</Text>
                      {server.description ? (
                        <Text
                          style={[styles.rowSubtitle, { color: theme.colors.muted }]}
                          numberOfLines={2}
                        >
                          {server.description}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </Card>
            )}

            <View style={{ height: 20 }} />
            <SectionHeader
              title="Agents"
              caption={`${agents.length}${
                capabilities.agents.length ? ` of ${capabilities.agents.length}` : ''
              }`}
            />
            {agents.length === 0 ? (
              <Card>
                <EmptyState title="No agent matches" body="Try another word." />
              </Card>
            ) : (
              <Card flush>
                {agents.map((agent, index) => (
                  <View
                    key={agent.id}
                    style={[
                      styles.row,
                      index === 0 ? null : { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.line },
                    ]}
                  >
                    <View style={[styles.mark, { backgroundColor: theme.colors.tag }]}>
                      <Icon name="user" size={18} color={theme.colors.muted} />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{agent.name}</Text>
                      {agent.description ? (
                        <Text
                          style={[styles.rowSubtitle, { color: theme.colors.muted }]}
                          numberOfLines={2}
                        >
                          {agent.description}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </Card>
            )}
          </>
        ) : null}
      </ScrollView>

      {/* Which Bot should get it. A skill is a thing the desktop can do, and asking a
          Bot for it is a message the user writes, so the Bot is chosen first. */}
      <Modal
        visible={picking !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPicking(null)}
      >
        <Pressable
          style={styles.backdrop}
          accessibilityLabel="Close"
          accessibilityRole="button"
          onPress={() => setPicking(null)}
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.line },
          ]}
        >
          <View style={[styles.sheetHeader, { borderBottomColor: theme.colors.line }]}>
            <Text style={[styles.sheetTitle, { color: theme.colors.ink }]}>
              Ask which bot?
            </Text>
            <Pressable
              onPress={() => setPicking(null)}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={({ pressed }) => [
                styles.close,
                { backgroundColor: pressed ? theme.colors.hover : 'transparent' },
              ]}
            >
              <Icon name="close" size={18} color={theme.colors.muted} />
            </Pressable>
          </View>
          <ScrollView>
            {bots.length === 0 ? (
              <EmptyState title="No bots yet" body="Ask the Chief Bot to build your team." />
            ) : (
              bots.map((bot, index) => (
                <Pressable
                  key={bot.botId}
                  onPress={() => {
                    tapLight();
                    const target = `bot:${bot.botId}`;
                    insertIntoComposer(target, `/${picking?.id ?? ''}`);
                    setPicking(null);
                    router.push(chatPath(target));
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Ask ${bot.name}`}
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
                    size={34}
                  />
                  <View style={styles.rowText}>
                    <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{bot.name}</Text>
                    <Text
                      style={[styles.rowSubtitle, { color: theme.colors.muted }]}
                      numberOfLines={1}
                    >
                      {bot.role ?? 'Bot'}
                    </Text>
                  </View>
                  <Icon name="chevron" size={16} color={theme.colors.subtle} />
                </Pressable>
              ))
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4,
  },
  search: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 16,
    paddingBottom: 40,
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
    fontSize: 12,
    marginTop: 2,
    lineHeight: 17,
  },
  rowMeta: {
    fontSize: 11,
    marginTop: 3,
  },
  mark: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: {
    fontSize: 15,
    fontWeight: '700',
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '70%',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: 24,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
