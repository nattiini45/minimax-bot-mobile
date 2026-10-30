import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '../../src/components/Avatar';
import { Button } from '../../src/components/Button';
import { Card, EmptyState, Pill, SectionHeader } from '../../src/components/primitives';
import { tapMedium } from '../../src/native/haptics';
import { chatPath } from '../../src/nav/paths';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/** A Bot: its identity, its memory, and the team actions that apply to it. */
export default function BotScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const botId = String(params.id ?? '');

  const bots = useAppStore((state) => state.bots);
  const bot = bots.find((entry) => entry.botId === botId);
  const requestAsync = useAppStore((state) => state.requestAsync);

  const [memory, setMemory] = useState<{ id: string; text: string; createdAt: number }[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      // The team's memory tool reads at most twenty entries per page.
      const result = (await requestAsync('op.recall', { botId, query: '', limit: 20 })) as {
        entries?: { id: string; text: string; createdAt: number }[];
      } | null;
      setMemory(result?.entries ?? []);
    } catch {
      setMemory([]);
    } finally {
      setBusy(false);
    }
  }, [botId, requestAsync]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!bot) {
    return (
      <View style={styles.screen}>
        <EmptyState title="This bot is not available" body="It may have been removed on the desktop." />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Avatar name={bot.name} skin={bot.skin} color={bot.color} size={56} />
        <Text style={[styles.name, { color: theme.colors.ink }]}>{bot.name}</Text>
        <Text style={[styles.role, { color: theme.colors.muted }]}>{bot.role ?? 'Bot'}</Text>
        {bot.isMain ? <Pill label="main" /> : null}
      </View>

      <View style={styles.actions}>
        <Button
          label="Open chat"
          variant="primary"
          onPress={() => router.push(chatPath(`bot:${bot.botId}`))}
        />
      </View>

      {bot.model ? (
        <>
          <SectionHeader title="Model" />
          <Card>
            <Text style={[styles.meta, { color: theme.colors.ink }]}>{bot.model}</Text>
          </Card>
        </>
      ) : null}

      <View style={{ height: 20 }} />
      <SectionHeader title="Memory" />
      <Card>
        {memory.length === 0 ? (
          <EmptyState title="Nothing remembered yet" body="Notes you add here stay with this bot." />
        ) : (
          memory.map((entry) => (
            <View key={entry.id} style={[styles.memoryRow, { borderBottomColor: theme.colors.line }]}>
              <Text style={[styles.memoryText, { color: theme.colors.ink }]}>{entry.text}</Text>
              <Button
                label="Forget"
                variant="ghost"
                size="sm"
                onPress={() => {
                  tapMedium();
                  // As with remembering, the list is read back once the entry is gone.
                  void (async () => {
                    try {
                      await requestAsync('op.forget', { botId, id: entry.id });
                    } catch {
                      // The store already carries the failure.
                    }
                    await load();
                  })();
                }}
              />
            </View>
          ))
        )}

        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Remember something"
          placeholderTextColor={theme.colors.subtle}
          multiline
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.bg,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: theme.minInputFontSize,
            },
          ]}
          accessibilityLabel="New memory"
        />
        <View style={styles.actions}>
          <Button
            label="Remember"
            variant="secondary"
            busy={busy}
            disabled={!note.trim()}
            onPress={() => {
              tapMedium();
              const text = note.trim();
              if (!text) return;
              setNote('');
              // The list is read back only once the note has actually been written:
              // reloading on a timer would race the write and show an empty list.
              void (async () => {
                try {
                  await requestAsync('op.remember', { botId, text });
                } catch {
                  // The store already carries the failure.
                }
                await load();
              })();
            }}
          />
        </View>
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
  name: {
    fontSize: 20,
    fontWeight: '600',
    marginTop: 8,
  },
  role: {
    fontSize: 13,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 12,
  },
  meta: {
    fontSize: 14,
  },
  memoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memoryText: {
    flex: 1,
    fontSize: 14,
  },
  input: {
    marginTop: 14,
    minHeight: 44,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 11,
    paddingBottom: 11,
  },
});
