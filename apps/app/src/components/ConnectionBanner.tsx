import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../theme';
import { useAppStore } from '../state/store';

/**
 * Connection banner.
 *
 * The phone is a projection of the desktop, so the state of that link is the first thing
 * a user needs to know. The banner is deliberately loud only when something is wrong.
 */
export function ConnectionBanner() {
  const theme = useTheme();
  const status = useAppStore((state) => state.status);
  const bridgeOnline = useAppStore((state) => state.bridgeOnline);
  const session = useAppStore((state) => state.session);
  const outbox = useAppStore((state) => state.outbox);

  if (!session) return null;

  let message: string | null = null;
  let tone: 'info' | 'warning' | 'danger' = 'info';

  if (status === 'offline') {
    message = 'Relay unreachable. Messages you send will queue.';
    tone = 'danger';
  } else if (status === 'connecting') {
    message = 'Connecting to the relay…';
    tone = 'info';
  } else if (!bridgeOnline) {
    message = 'Your desktop is offline. Start MiniMax Code to reach the team.';
    tone = 'warning';
  }

  if (!message && outbox.length > 0) {
    message = `${outbox.length} message${outbox.length > 1 ? 's' : ''} waiting to send.`;
    tone = 'warning';
  }

  if (!message) return null;

  const background =
    tone === 'danger'
      ? theme.colors.danger
      : tone === 'warning'
        ? theme.colors.warning
        : theme.colors.tag;
  const foreground = tone === 'info' ? theme.colors.muted : '#ffffff';

  return (
    <View style={[styles.banner, { backgroundColor: background }]}>
      <Text style={[styles.text, { color: foreground }]}>{message}</Text>
    </View>
  );
}

/** A row that navigates somewhere. */
export function NavRow({
  title,
  subtitle,
  onPress,
  accessory,
}: {
  title: string;
  subtitle?: string;
  onPress: () => void;
  accessory?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          borderBottomColor: theme.colors.line,
          backgroundColor: pressed ? theme.colors.hover : 'transparent',
        },
      ]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: theme.colors.ink }]}>{title}</Text>
        {subtitle ? <Text style={[styles.rowSubtitle, { color: theme.colors.muted }]}>{subtitle}</Text> : null}
      </View>
      {accessory}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  text: {
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  rowText: {
    flex: 1,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '500',
  },
  rowSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
});
