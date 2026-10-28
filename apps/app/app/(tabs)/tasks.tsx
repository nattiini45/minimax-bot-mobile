import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '../../src/components/Button';
import { Card, EmptyState, Pill, SectionHeader } from '../../src/components/primitives';
import { tapMedium } from '../../src/native/haptics';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

const STATE_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  queued: 'neutral',
  running: 'warning',
  waiting_for_tasks: 'warning',
  waiting_for_user: 'warning',
  paused: 'neutral',
  unknown: 'danger',
  done: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  stopped: 'neutral',
  interrupted: 'neutral',
  blocked: 'warning',
  error: 'danger',
};

/** Background work: dispatched tasks and the helpers that run on their own. */
export default function TasksScreen() {
  const theme = useTheme();
  const tasks = useAppStore((state) => state.tasks);
  const tasksNote = useAppStore((state) => state.tasksNote);
  const helpers = useAppStore((state) => state.helpers);
  const request = useAppStore((state) => state.request);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <SectionHeader title={`Tasks (${tasks.length})`} />
      {tasksNote ? (
        <Text style={[styles.note, { color: theme.colors.muted }]}>{tasksNote}</Text>
      ) : null}
      {tasks.length === 0 ? (
        <Card>
          <EmptyState title="No tasks yet" body="Dispatch work to your team from any chat." />
        </Card>
      ) : (
        tasks.map((task) => (
          <Card key={task.taskId} style={styles.item}>
            <View style={styles.itemHeader}>
              <Text style={[styles.itemTitle, { color: theme.colors.ink }]} numberOfLines={1}>
                {task.title ?? task.taskId}
              </Text>
              <Pill label={task.state} tone={STATE_TONE[task.state] ?? 'neutral'} />
            </View>
            {task.botIds?.length ? (
              <Text style={[styles.itemMeta, { color: theme.colors.muted }]}>
                {task.botIds.length} bot{task.botIds.length === 1 ? '' : 's'}
              </Text>
            ) : null}
            {task.state === 'running' || task.state === 'queued' ? (
              <View style={styles.actions}>
                <Button
                  label="Cancel"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    tapMedium();
                    request('op.cancel_task', { taskId: task.taskId });
                  }}
                />
              </View>
            ) : null}
          </Card>
        ))
      )}

      <View style={{ height: 20 }} />
      <SectionHeader title={`Helpers (${helpers.length})`} />
      {helpers.length === 0 ? (
        <Card>
          <EmptyState title="No helpers running" body="Helpers are background assistants such as a daily digest." />
        </Card>
      ) : (
        helpers.map((helper) => (
          <Card key={helper.helperId} style={styles.item}>
            <View style={styles.itemHeader}>
              <Text style={[styles.itemTitle, { color: theme.colors.ink }]} numberOfLines={1}>
                {helper.title ?? helper.helperId}
              </Text>
              <Pill label={helper.state} tone={STATE_TONE[helper.state] ?? 'neutral'} />
            </View>
            {helper.nextRunAt ? (
              <Text style={[styles.itemMeta, { color: theme.colors.muted }]}>
                Next run {new Date(helper.nextRunAt).toLocaleString()}
              </Text>
            ) : null}
            {helper.state === 'running' ? (
              <View style={styles.actions}>
                <Button
                  label="Stop"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    tapMedium();
                    request('op.stop_helper', { helperId: helper.helperId });
                  }}
                />
              </View>
            ) : null}
          </Card>
        ))
      )}
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
  item: {
    marginBottom: 10,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  itemTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  itemMeta: {
    fontSize: 13,
    marginTop: 4,
  },
  note: {
    fontSize: 12,
    marginBottom: 8,
    lineHeight: 17,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 10,
  },
});
