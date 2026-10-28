import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../src/components/Button';
import { Card, EmptyState, Pill, SectionHeader } from '../../src/components/primitives';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/** Usage, schedules and the tool catalogue the bridge can reach. */
export default function InsightsScreen() {
  const theme = useTheme();
  const schedules = useAppStore((state) => state.schedules);
  const tools = useAppStore((state) => state.tools);
  const diagnostics = useAppStore((state) => state.diagnostics);
  const requestAsync = useAppStore((state) => state.requestAsync);
  const [usage, setUsage] = useState<{
    totals: { turns: number; chars: number; tools: number; errors: number };
    byBot: { botId: string; name: string; turns: number; chars: number; tools: number }[];
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const result = (await requestAsync('op.get_usage', { days: 7 })) as {
        totals: { turns: number; chars: number; tools: number; errors: number };
        byBot: { botId: string; name: string; turns: number; chars: number; tools: number }[];
      } | null;
      if (result) setUsage(result);
    } catch {
      /* the banner already reports the failure */
    }
  }, [requestAsync]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionHeader
        title="Usage (7 days)"
        action={
          <Button label="Refresh" variant="ghost" size="sm" onPress={() => void load()} />
        }
      />
      <Card>
        {usage ? (
          <View style={styles.statsRow}>
            <Stat label="Turns" value={String(usage.totals.turns)} />
            <Stat label="Chars" value={String(usage.totals.chars)} />
            <Stat label="Tools" value={String(usage.totals.tools)} />
            <Stat label="Errors" value={String(usage.totals.errors)} />
          </View>
        ) : (
          <EmptyState title="No usage yet" body="Usage appears once the team has answered." />
        )}
      </Card>

      {usage && usage.byBot.length > 0 ? (
        <>
          <View style={{ height: 20 }} />
          <SectionHeader title="By bot" />
          <Card>
            {usage.byBot.map((bot) => (
              <View key={bot.botId} style={[styles.botRow, { borderBottomColor: theme.colors.line }]}>
                <Text style={[styles.botName, { color: theme.colors.ink }]}>{bot.name}</Text>
                <Text style={[styles.botMeta, { color: theme.colors.muted }]}>
                  {bot.turns} turns · {bot.tools} tools
                </Text>
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <View style={{ height: 20 }} />
      <SectionHeader title={`Schedules (${schedules.length})`} />
      {schedules.length === 0 ? (
        <Card>
          <EmptyState title="No schedules" body="A schedule runs a prompt for a bot on a timer." />
        </Card>
      ) : (
        schedules.map((schedule) => (
          <Card key={schedule.scheduleId} style={styles.item}>
            <View style={styles.itemHeader}>
              <Text style={[styles.itemTitle, { color: theme.colors.ink }]}>{schedule.name}</Text>
              <Pill label={schedule.enabled ? 'on' : 'off'} tone={schedule.enabled ? 'success' : 'neutral'} />
            </View>
            <Text style={[styles.itemMeta, { color: theme.colors.muted }]}>
              {schedule.kind} · {schedule.spec}
              {schedule.nextRunAt ? ` · next ${new Date(schedule.nextRunAt).toLocaleString()}` : ''}
            </Text>
          </Card>
        ))
      )}

      <View style={{ height: 20 }} />
      <SectionHeader title={`Team tools (${diagnostics.toolCount})`} />
      <Card>
        {tools.length === 0 ? (
          <EmptyState
            title="The team is not linked"
            body="Open MiniMax Bot on your desktop so the bridge can reach the team tools."
          />
        ) : (
          tools.map((tool) => (
            <View key={tool.name} style={[styles.botRow, { borderBottomColor: theme.colors.line }]}>
              <Text style={[styles.botName, { color: theme.colors.ink }]}>{tool.tool}</Text>
              <Text style={[styles.botMeta, { color: theme.colors.muted }]} numberOfLines={1}>
                {tool.description ?? tool.server}
              </Text>
            </View>
          ))
        )}
      </Card>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color: theme.colors.ink }]}>{value}</Text>
      <Text style={[styles.statLabel, { color: theme.colors.subtle }]}>{label}</Text>
    </View>
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
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  stat: {
    alignItems: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '600',
  },
  statLabel: {
    fontSize: 11,
    marginTop: 2,
  },
  item: {
    marginBottom: 10,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  itemTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  itemMeta: {
    fontSize: 13,
    marginTop: 4,
  },
  botRow: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  botName: {
    fontSize: 14,
    fontWeight: '500',
  },
  botMeta: {
    fontSize: 12,
    marginTop: 2,
  },
});
