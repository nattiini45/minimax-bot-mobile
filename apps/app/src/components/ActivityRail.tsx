import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';
import type { AppActivity } from '../state/store';

/**
 * The live trace of what the team is doing.
 *
 * The bridge reports every tool the team runs while it answers, so the phone can show
 * the work instead of a long silence: which tool ran, how long it took, and whether it
 * failed. Only the current turn is shown; the rail collapses to one line so it never
 * competes with the conversation itself.
 */
export function ActivityRail({
  activity,
  activeTurn,
  actorName,
}: {
  activity: AppActivity[];
  activeTurn?: string;
  actorName?: string;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  const entries = useMemo(() => {
    const turn = activeTurn ?? activity[activity.length - 1]?.turnId;
    if (!turn) return [];
    return activity.filter((entry) => entry.turnId === turn);
  }, [activity, activeTurn]);

  if (entries.length === 0) return null;

  const running = entries.some((entry) => entry.status === 'running');
  const failed = entries.some((entry) => entry.status === 'failed');
  const totalMs = entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0);

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
        },
      ]}
    >
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        accessibilityRole="button"
        accessibilityLabel={expanded ? 'Hide team activity' : 'Show team activity'}
        style={styles.header}
      >
        <View style={styles.headerLeft}>
          <Text style={[styles.pulse, { color: failed ? theme.colors.danger : theme.colors.success }]}>
            {running ? '◍' : failed ? '✕' : '✓'}
          </Text>
          <Text style={[styles.title, { color: theme.colors.ink }]}>
            {running
              ? `${actorName ?? 'The team'} is working`
              : failed
                ? `${actorName ?? 'The team'} hit an error`
                : `${actorName ?? 'The team'} finished`}
          </Text>
          <Text style={[styles.meta, { color: theme.colors.subtle }]}>
            {entries.length} {entries.length === 1 ? 'tool' : 'tools'}
            {totalMs > 0 ? ` · ${formatDuration(totalMs)}` : ''}
          </Text>
        </View>
        <Text style={[styles.chevron, { color: theme.colors.subtle }]}>{expanded ? '▾' : '▸'}</Text>
      </Pressable>

      {expanded ? (
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {entries.map((entry) => (
            <View key={entry.id} style={styles.row}>
              <Text
                style={[
                  styles.mark,
                  {
                    color:
                      entry.status === 'running'
                        ? theme.colors.subtle
                        : entry.status === 'failed'
                          ? theme.colors.danger
                          : theme.colors.success,
                  },
                ]}
              >
                {entry.status === 'running' ? '◍' : entry.status === 'failed' ? '✕' : '✓'}
              </Text>
              <Text style={[styles.tool, { color: theme.colors.ink }]} numberOfLines={1}>
                {entry.toolName}
              </Text>
              {entry.durationMs !== undefined ? (
                <Text style={[styles.duration, { color: theme.colors.muted }]}>
                  {formatDuration(entry.durationMs)}
                </Text>
              ) : null}
              {entry.status === 'running' ? (
                <Text style={[styles.duration, { color: theme.colors.subtle }]}>running</Text>
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
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
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
  pulse: {
    fontSize: 12,
    fontWeight: '700',
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
  },
  meta: {
    fontSize: 12,
  },
  chevron: {
    fontSize: 12,
    paddingLeft: 8,
  },
  list: {
    maxHeight: 148,
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
  mark: {
    fontSize: 11,
    fontWeight: '700',
    width: 12,
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
