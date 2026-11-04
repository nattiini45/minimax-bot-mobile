import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { Icon, type IconName } from './Icon';
import { useTheme } from '../theme';

/** A surface panel, matching the skin's cards. */
export function Card({
  children,
  style,
  /** Removes the card's padding, for a card that holds rows of its own. */
  flush = false,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  flush?: boolean;
}) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        flush ? styles.cardFlush : null,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
          ...theme.elevation.card,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A small tag, used for status and metadata. */
export function Pill({
  label,
  tone = 'neutral',
  align = 'flex-start',
}: {
  label: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  /**
   * Where the tag sits in its parent.
   *
   * A tag in a row belongs at the start of the row; a tag under a name belongs with
   * the name, so the caller says which it is.
   */
  align?: 'flex-start' | 'center';
}) {
  const theme = useTheme();
  const color =
    tone === 'success'
      ? theme.colors.successText
      : tone === 'warning'
        ? theme.colors.warningText
        : tone === 'danger'
          ? theme.colors.dangerText
          : tone === 'accent'
            ? theme.colors.accentText
            : theme.colors.muted;
  const background =
    tone === 'neutral'
      ? theme.colors.tag
      : tone === 'success'
        ? 'rgba(22, 163, 74, 0.12)'
        : tone === 'warning'
          ? 'rgba(217, 119, 6, 0.13)'
          : tone === 'danger'
            ? 'rgba(229, 72, 77, 0.12)'
            : theme.colors.accentSoft;
  return (
    <View style={[styles.pill, { backgroundColor: background, alignSelf: align }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function SectionHeader({
  title,
  action,
  caption,
}: {
  title: string;
  action?: React.ReactNode;
  caption?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleRow}>
        <Text style={[styles.sectionTitle, { color: theme.colors.subtleText }]}>{title.toUpperCase()}</Text>
        {caption ? <Text style={[styles.sectionCaption, { color: theme.colors.subtleText }]}>{caption}</Text> : null}
      </View>
      {action}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  icon = 'spark',
}: {
  title: string;
  body?: string;
  icon?: IconName;
}) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyDisc, { backgroundColor: theme.colors.tag, borderColor: theme.colors.line }]}>
        <Icon name={icon} size={20} color={theme.colors.subtle} />
      </View>
      <Text style={[styles.emptyTitle, { color: theme.colors.ink }]}>{title}</Text>
      {body ? <Text style={[styles.emptyBody, { color: theme.colors.muted }]}>{body}</Text> : null}
    </View>
  );
}

export function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.colors.line }]} />;
}

/**
 * A choice between a few options, in one row.
 *
 * A setting with two or three answers is a choice, not a form: the options are shown
 * as they are, and the one in force is the one that is lit.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <View
      style={[styles.segmented, { backgroundColor: theme.colors.sunken, borderColor: theme.colors.line }]}
      accessibilityLabel={accessibilityLabel}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            style={({ pressed }) => [
              styles.segment,
              {
                backgroundColor: selected ? theme.colors.surface : pressed ? theme.colors.hover : 'transparent',
                borderColor: selected ? theme.colors.line : 'transparent',
              },
            ]}
          >
            <Text
              style={[
                styles.segmentLabel,
                { color: selected ? theme.colors.ink : theme.colors.muted },
              ]}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * A row that is pressed.
 *
 * The pressed state is a ground, not a border: a card that only changes its outline
 * reads as a link, and the rows of this app are links.
 */
export function PressableRow({
  children,
  onPress,
  style,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.pressableRow,
        { backgroundColor: pressed ? theme.colors.hover : 'transparent' },
        style,
      ]}
    >
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 16,
  },
  cardFlush: {
    padding: 0,
    overflow: 'hidden',
  },
  segmented: {
    flexDirection: 'row',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 7,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  segmentLabel: {
    fontSize: 13,
    fontWeight: '500',
  },
  pill: {
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pillText: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.2,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    marginTop: 6,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  sectionCaption: {
    fontSize: 11,
    fontWeight: '500',
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 36,
    paddingHorizontal: 24,
  },
  emptyDisc: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
  },
  emptyIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptyBody: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 5,
    lineHeight: 19,
    maxWidth: 320,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    width: '100%',
  },
  pressableRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
