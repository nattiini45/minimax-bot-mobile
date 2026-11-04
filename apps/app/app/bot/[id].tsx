import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ModelCatalog, ModelOption } from '@minimax-bot/protocol';

import { Avatar, useBotSkins } from '../../src/components/Avatar';
import { Button } from '../../src/components/Button';
import { Card, EmptyState, Pill, SectionHeader, Segmented } from '../../src/components/primitives';
import { Picker, type PickerOption } from '../../src/components/Picker';
import { tapMedium } from '../../src/native/haptics';
import { chatPath } from '../../src/nav/paths';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';
import { OwnerBoundary, useOwnerGuard } from '../../src/state/OwnerBoundary';

/**
 * The catalog entry a Bot's model setting points at.
 *
 * The desktop names a model as `provider/model`, and `default` for the one the desktop
 * itself uses. The entry is found by either name, so a Bot that was set on the desktop
 * is recognised.
 */
function entryFor(catalog: ModelCatalog | null, model: string): ModelOption | undefined {
  if (!catalog) return undefined;
  const wanted = String(model ?? '').trim();
  if (!wanted || wanted === 'default') return catalog.default;
  const lower = wanted.toLowerCase();
  return (
    catalog.models.find((entry) => entry.id.toLowerCase() === lower) ??
    catalog.models.find((entry) => entry.modelId.toLowerCase() === lower) ??
    catalog.models.find((entry) => entry.name.toLowerCase() === lower)
  );
}

/** The label of an effort level. */
function effortLabel(effort: string): string {
  if (effort === 'off') return 'Off';
  if (effort === 'default') return 'Default';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/**
 * One line of a Bot's profile.
 *
 * The label is what the field is; the value is what the desktop says about it. A
 * value the desktop does not have is not shown at all, rather than shown as a blank.
 */
function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const theme = useTheme();
  return (
    <View style={[styles.detailRow, { borderBottomColor: theme.colors.line }]}>
      <Text style={[styles.detailLabel, { color: theme.colors.muted }]}>{label}</Text>
      <Text
        style={[
          styles.detailValue,
          { color: theme.colors.ink },
          mono ? { fontFamily: theme.font.mono, fontSize: 13 } : null,
        ]}
        numberOfLines={2}
      >
        {value}
      </Text>
    </View>
  );
}

/** A Bot: its identity, its memory, and the team actions that apply to it. */
export default function BotScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  return <OwnerBoundary><BotEditor key={String(params.id ?? '')} /></OwnerBoundary>;
}

function BotEditor() {
  const isCurrentOwner = useOwnerGuard();
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const botId = String(params.id ?? '');

  const bots = useAppStore((state) => state.bots);
  const bot = bots.find((entry) => entry.botId === botId);
  // Every Bot on the roster gets a face of its own.
  const skins = useBotSkins(bots);
  const requestAsync = useAppStore((state) => state.requestAsync);

  const [memory, setMemory] = useState<{ id: string; text: string; createdAt: number }[]>([]);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const remembering = useRef(false);
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const updateBot = useAppStore((state) => state.updateBot);
  const setBotMode = useAppStore((state) => state.setBotMode);

  // The settings being edited. They start as the Bot stands and are only sent when
  // the user says so: a phone that wrote to the Bot on every keystroke would change
  // the Bot while the user is still typing.
  const [draft, setDraft] = useState({ role: '', model: 'default', effort: 'default', instructions: '' });
  const dirty = useRef<Partial<Record<keyof typeof draft, boolean>>>({});
  const draftBot = useRef<string | undefined>(undefined);
  const edit = (field: keyof typeof draft, value: string) => {
    dirty.current[field] = true;
    setDraft((state) => ({ ...state, [field]: value }));
  };

  // The models the desktop offers, and the efforts the chosen one has.
  //
  // The list comes from the desktop, not from the phone: a model that is not in the
  // catalog cannot be picked, and a model cannot be asked for an effort it does not
  // have.
  const modelOptions = useMemo<PickerOption[]>(() => {
    if (!catalog?.supported) return [];
    const options: PickerOption[] = [
      {
        value: 'default',
        label: catalog.default ? `Default (${catalog.default.name})` : 'Default',
        description: catalog.default?.id,
      },
      ...catalog.models.map((entry) => ({
        value: entry.id,
        label: entry.name,
        description: entry.id,
      })),
    ];
    // A model the Bot has but the desktop does not list any more is kept, flagged, so
    // that saving the screen does not quietly drop it.
    const wanted = String(draft.model ?? '');
    if (wanted && wanted !== 'default' && !options.some((option) => option.value === wanted)) {
      options.push({ value: wanted, label: wanted, flagged: true });
    }
    return options;
  }, [catalog, draft.model]);

  const effortOptions = useMemo<PickerOption[]>(() => {
    const entry = entryFor(catalog, draft.model);
    const levels = entry?.efforts ?? [];
    // A model whose own default is 'default' has no level to name, so it is just
    // "Default".
    const modelDefault =
      entry?.defaultEffort && entry.defaultEffort !== 'default' ? entry.defaultEffort : undefined;
    const options: PickerOption[] = [
      {
        value: 'default',
        label: modelDefault ? `Default (${effortLabel(modelDefault)})` : 'Default',
      },
      ...levels.map((level) => ({ value: level, label: effortLabel(level) })),
    ];
    // The desktop may work a Bot at an effort the chosen model does not offer — it was
    // set on another model — so it stays in the list instead of being dropped.
    const wanted = String(draft.effort ?? '');
    if (wanted && wanted !== 'default' && !options.some((option) => option.value === wanted)) {
      options.push({ value: wanted, label: effortLabel(wanted), flagged: true });
    }
    return options;
  }, [catalog, draft.model, draft.effort]);

  const load = useCallback(async () => {
    if (!isCurrentOwner()) return;
    setBusy(true);
    setMemoryError(null);
    try {
      // The team's memory tool reads at most twenty entries per page.
      const result = (await requestAsync('op.recall', { botId, query: '', limit: 20 })) as {
        entries?: { id: string; text: string; createdAt: number }[];
      } | null;
      if (isCurrentOwner()) setMemory(result?.entries ?? []);
    } catch (error) {
      if (isCurrentOwner()) {
        setMemory([]);
        setMemoryError(error instanceof Error ? error.message : 'Memory could not be loaded.');
      }
    } finally {
      if (isCurrentOwner()) setBusy(false);
    }
  }, [botId, requestAsync, isCurrentOwner]);

  useEffect(() => {
    void load();
  }, [load]);

  // The models the desktop offers.
  //
  // They are read once when the screen opens: the catalog changes rarely, and the
  // phone asks the desktop what it has rather than carrying its own list.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = (await requestAsync('op.list_models', {})) as ModelCatalog | null;
        if (alive && isCurrentOwner()) setCatalog(result);
      } catch {
        // The desktop did not answer. The pickers say so instead of showing a list
        // that is not the desktop's.
        if (alive && isCurrentOwner()) setCatalog(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [requestAsync, isCurrentOwner]);

  // The draft follows the Bot, so a roster that changed on the desktop is not
  // overwritten by what was typed here.
  useEffect(() => {
    if (!bot) return;
    if (draftBot.current !== bot.botId) {
      dirty.current = {};
      draftBot.current = bot.botId;
    }
    setDraft((state) => {
      const remote = { role: bot.role ?? '', model: bot.model ?? 'default', effort: bot.effort ?? 'default', instructions: bot.instructions ?? '' };
      const next = { ...state };
      for (const field of Object.keys(remote) as (keyof typeof draft)[]) {
        // Once roster data matches the edit, later roster changes can follow
        // again. A genuinely different dirty value remains untouched.
        if (remote[field] === state[field]) dirty.current[field] = false;
        if (!dirty.current[field]) next[field] = remote[field];
      }
      return next;
    });
  }, [bot?.botId, bot?.role, bot?.model, bot?.effort, bot?.instructions]);

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
        <View style={[styles.halo, { backgroundColor: bot.isMain ? theme.colors.accentSoft : theme.colors.tag }]}>
          <Avatar
            name={bot.name}
            botId={bot.botId}
            skin={bot.skin ?? skins[bot.botId]}
            color={bot.color}
            avatar={bot.avatar}
            size={64}
            ring={bot.isMain}
          />
        </View>
        <Text style={[styles.name, { color: theme.colors.ink }]}>{bot.name}</Text>
        <Text style={[styles.role, { color: theme.colors.muted }]}>{bot.role ?? 'Bot'}</Text>
        {bot.isMain ? <Pill label="main" tone="accent" align="center" /> : null}
      </View>

      <View style={styles.actions}>
        <Button
          label="Open chat"
          variant="primary"
          onPress={() => router.push(chatPath(`bot:${bot.botId}`))}
          style={styles.openChat}
        />
      </View>

      {/* The Bot's own settings are edited in one place: the card below. Repeating
          them here would show the same text twice, and twice is worse than once —
          the second copy is the one that is true. Only the look is read-only. */}
      {bot.skin ? (
        <>
          <SectionHeader title="Profile" />
          <Card flush>
            <DetailRow label="Look" value={bot.skin} />
          </Card>
          <View style={{ height: 20 }} />
        </>
      ) : null}

      <SectionHeader title="Settings" />
      <Card>
        <Text style={[styles.settingLabel, { color: theme.colors.muted }]}>Where its turns run</Text>
        <Segmented
          accessibilityLabel="Where this bot's turns run"
          value={bot.runMode === 'hosted' ? 'hosted' : 'team'}
          options={[
            { value: 'hosted', label: 'On this desktop' },
            { value: 'team', label: 'In the team' },
          ]}
          onChange={(mode) => {
            if (!isCurrentOwner()) return;
            tapMedium();
            setBotMode(bot.botId, mode);
          }}
        />
        <Text style={[styles.settingNote, { color: theme.colors.muted }]}>
          {bot.runMode === 'hosted'
            ? 'The bridge runs a separate conversation on this desktop. You can answer its permission checks and questions on your phone. It is not added to the desktop Bot app.'
            : 'The team runs the turn in the desktop Bot app. Your phone shows progress while it works, then loads recorded narration, replies and tool calls at turn end.'}
        </Text>

        <View style={[styles.divider, { backgroundColor: theme.colors.line }]} />

        <Text style={[styles.settingLabel, { color: theme.colors.muted }]}>Role</Text>
        <TextInput
          value={draft.role}
          onChangeText={(value) => edit('role', value)}
          placeholder="What this Bot is for"
          placeholderTextColor={theme.colors.subtleText}
          style={[
            styles.input,
            {
              backgroundColor: theme.colors.bg,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: theme.minInputFontSize,
            },
          ]}
          accessibilityLabel="Role"
        />

        <Picker
          label="Model"
          value={draft.model}
          options={modelOptions}
          onChange={(model) => edit('model', model)}
          emptyLabel="The desktop does not let a Bot pick its model"
          accessibilityLabel="Model"
        />

        <Picker
          label="Effort"
          value={draft.effort}
          options={effortOptions}
          onChange={(effort) => edit('effort', effort)}
          emptyLabel="This model does not offer an effort"
          accessibilityLabel="Effort"
        />

        <Text style={[styles.settingLabel, { color: theme.colors.muted }]}>Instructions</Text>
        <TextInput
          value={draft.instructions}
          onChangeText={(value) => edit('instructions', value)}
          placeholder="What this Bot is for, in its own words"
          placeholderTextColor={theme.colors.subtleText}
          multiline
          style={[
            styles.input,
            styles.bioInput,
            {
              backgroundColor: theme.colors.bg,
              borderColor: theme.colors.line,
              color: theme.colors.ink,
              fontSize: theme.minInputFontSize,
            },
          ]}
          accessibilityLabel="Instructions"
        />

        <View style={styles.actions}>
          <Button
            label="Save"
            variant="primary"
            onPress={() => {
              if (!isCurrentOwner()) return;
              tapMedium();
              // The effort has to be one the chosen model offers: the desktop refuses
              // a level the model does not have, and the model's own default is the
              // answer when the level does not fit.
              const entry = catalog?.supported ? entryFor(catalog, draft.model) : undefined;
              // Missing catalog data is not evidence that an existing setting is invalid.
              const effort = entry && draft.effort !== 'default' && !entry.efforts.includes(draft.effort)
                ? 'default'
                : draft.effort;
              // The team owns the Bot, so the change is made on the Bot itself.
              updateBot(bot.botId, {
                role: draft.role.trim(),
                model: draft.model.trim(),
                effort,
                instructions: draft.instructions.trim(),
              });
            }}
          />
        </View>
      </Card>

      <View style={{ height: 20 }} />
      <SectionHeader title="Memory" />
      <Card>
        {memoryError ? (
          <>
            <Text accessibilityRole="alert" style={{ color: theme.colors.ink }}>{memoryError}</Text>
            <Button label="Retry memory" variant="ghost" size="sm" onPress={() => void load()} />
          </>
        ) : null}
        {memory.length === 0 ? (
          memoryError ? null : <EmptyState title={busy ? 'Reading memory…' : 'Nothing remembered yet'} body="Notes you add here stay with this bot." />
        ) : (
          memory.map((entry) => (
            <View key={entry.id} style={[styles.memoryRow, { borderBottomColor: theme.colors.line }]}>
              <Text style={[styles.memoryText, { color: theme.colors.ink }]}>{entry.text}</Text>
              <Button
                label="Forget"
                variant="ghost"
                size="sm"
                onPress={() => {
                  if (!isCurrentOwner()) return;
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
          placeholderTextColor={theme.colors.subtleText}
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
        {noteError ? (
          <Text accessibilityRole="alert" style={[styles.settingNote, { color: theme.colors.ink }]}>
            {noteError} Your note is still here; you can try again.
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            label="Remember"
            variant="secondary"
            busy={busy}
            disabled={!note.trim()}
            onPress={() => {
              if (!isCurrentOwner()) return;
              tapMedium();
              const text = note.trim();
              if (!text || remembering.current) return;
              remembering.current = true;
              setBusy(true);
              setNoteError(null);
              // Keep the text until the desktop confirms the write. A failure must
              // leave a recoverable note, and a later edit must not be cleared.
              const submitted = note;
              void (async () => {
                try {
                  await requestAsync('op.remember', { botId, text });
                  if (!isCurrentOwner()) return;
                  setNote((current) => current === submitted ? '' : current);
                  await load();
                } catch (error) {
                  if (isCurrentOwner()) setNoteError(error instanceof Error ? error.message : 'The note could not be saved.');
                } finally {
                  remembering.current = false;
                  if (isCurrentOwner()) setBusy(false);
                }
              })();
            }}
          />
        </View>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({  screen: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: 16,
  },
  halo: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.3,
    marginTop: 10,
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
  openChat: {
    flex: 1,
  },
  meta: {
    fontSize: 14,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  detailLabel: {
    fontSize: 13,
  },
  detailValue: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'right',
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
  bioInput: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  settingLabel: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginTop: 14,
  },
  settingNote: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 8,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginTop: 14,
  },
});
