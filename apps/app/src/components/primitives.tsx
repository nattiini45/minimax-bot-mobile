import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

/** A surface panel, matching the skin's cards. */
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.colors.surface, borderColor: theme.colors.line },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A small tag, used for status and metadata. */
export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const theme = useTheme();
  const color =
    tone === 'success'
      ? theme.colors.success
      : tone === 'warning'
        ? theme.colors.warning
        : tone === 'danger'
          ? theme.colors.danger
          : theme.colors.muted;
  return (
    <View style={[styles.pill, { backgroundColor: theme.colors.tag }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <Text style={[styles.sectionTitle, { color: theme.colors.subtle }]}>{title.toUpperCase()}</Text>
      {action}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  icon = '·',
}: {
  title: string;
  body?: string;
  icon?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <Text style={[styles.emptyIcon, { color: theme.colors.subtle }]}>{icon}</Text>
      <Text style={[styles.emptyTitle, { color: theme.colors.ink }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: theme.colors.muted }]}>{body}</Text> : null}
    </View>
  );
}

export function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.colors.line }]} />;
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
  },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 40,
    paddingHorizontal: 24,
  },
  emptyIcon: {
    fontSize: 28,
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 4,
    lineHeight: 19,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
});
