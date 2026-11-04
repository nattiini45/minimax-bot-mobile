import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from './Icon';
import { useTheme } from '../theme';
import type { AppActivity } from '../state/store';

/**
 * The tool calls one turn made.
 *
 * A turn the desktop's own engine runs can use dozens of tools, and the desktop keeps
 * them in a panel of their own. The phone keeps them with the turn they belong to, in
 * the same place — folded away until the reader asks for them, so that a long list of
 * calls does not bury the conversation.
 */
export function TurnActivity({ entries }: { entries: AppActivity[] }) {
  const theme = useTheme();
  // A small list is shown at once; a long one is folded away until it is asked for.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const expanded = chosen ?? entries.length <= 8;

  if (entries.length === 0) return null;

  const failed = entries.some((entry) => entry.status === 'failed');
  const running = entries.some((entry) => entry.status === 'running');
  const totalMs = entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);

  return (
    <View style={[styles.wrap, { borderColor: theme.colors.line }]}>
      <Pressable
        onPress={() => setChosen(!expanded)}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Hide the tools this turn used' : 'Show the tools this turn used'}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <Icon
            name={running ? 'pulse' : failed ? 'close' : 'check'}
            size={14}
            color={failed ? theme.colors.danger : running ? theme.colors.accent : theme.colors.success}
          />
          <Text style={[styles.title, { color: theme.colors.ink }]}>
            {entries.length} {entries.length === 1 ? 'tool' : 'tools'}
          </Text>
          {totalMs > 0 ? (
            <Text style={[styles.meta, { color: theme.colors.subtleText }]}>{formatDuration(totalMs)}</Text>
          ) : null}
        </View>
        <Icon name="chevron" size={16} color={theme.colors.subtle} style={expanded ? styles.chevronUp : styles.chevronDown} />
      </Pressable>

      {expanded ? (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {entries.map((entry) => (
            <View key={entry.id} style={styles.row}>
              <Icon
                name={entry.status === 'running' ? 'pulse' : entry.status === 'failed' ? 'close' : 'check'}
                size={14}
                color={
                  entry.status === 'running'
                    ? theme.colors.subtle
                    : entry.status === 'failed'
                      ? theme.colors.danger
                      : entry.status === 'unknown'
                        ? theme.colors.muted
                        : theme.colors.success
                }
              />
              <Text style={[styles.tool, { color: theme.colors.ink }]} numberOfLines={1}>
                {entry.toolName}
              </Text>
              {entry.durationMs !== undefined ? (
                <Text style={[styles.duration, { color: theme.colors.muted }]}>{formatDuration(entry.durationMs)}</Text>
              ) : null}
              {entry.status === 'running' ? (
                <Text style={[styles.duration, { color: theme.colors.subtleText }]}>running</Text>
              ) : null}
              {entry.status === 'unknown' ? (
                <Text style={[styles.duration, { color: theme.colors.muted }]}>no report</Text>
              ) : null}
              {entry.error && entry.status === 'failed' ? (
                <Text style={[styles.duration, { color: theme.colors.danger }]} numberOfLines={1}>
                  {entry.error}
                </Text>
              ) : null}
            </View>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

/** Formats a duration the way the desktop skin does: seconds under a minute. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  const rounded = Math.round(seconds);
  // Rounding first means 59.999s is a minute, not "60s".
  if (rounded < 60) return seconds < 10 ? `${seconds.toFixed(1)}s` : `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  return `${minutes}m ${rounded % 60}s`;
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
  },
  chevronDown: {
    transform: [{ rotate: '-45deg' }],
  },
  chevronUp: {
    transform: [{ rotate: '135deg' }],
  },
  list: {
    maxHeight: 180,
    marginTop: 6,
  },
  listContent: {
    gap: 3,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  tool: {
    fontSize: 12,
    fontWeight: '500',
    flexShrink: 1,
  },
  duration: {
    fontSize: 11,
    marginLeft: 'auto',
  },
});
