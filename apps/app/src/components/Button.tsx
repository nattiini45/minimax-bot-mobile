import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type ViewStyle,
} from 'react-native';

import { useTheme } from '../theme';

/**
 * Button.
 *
 * The press feedback is on `onPressIn`, not `onPress`: a native button reacts the
 * moment a finger lands, and a button that only reacts on release reads as lag.
 */

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
  accessibilityHint?: string;
}

export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  disabled = false,
  busy = false,
  style,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();
  const isPrimary = variant === 'primary';
  const isDanger = variant === 'danger';
  const isGhost = variant === 'ghost';

  const background = isPrimary
    ? theme.colors.user
    : isDanger
      ? theme.colors.danger
      : isGhost
        ? 'transparent'
        : theme.colors.surface;

  const foreground = isPrimary
    ? theme.colors.userInk
    : isDanger
      ? '#ffffff'
      : theme.colors.ink;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === 'sm' ? styles.sm : styles.md,
        {
          backgroundColor: background,
          borderColor: isGhost ? 'transparent' : theme.colors.lineStrong,
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={foreground} /> : null}
      <Text style={[styles.label, { color: foreground, fontSize: size === 'sm' ? 13 : 15 }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  sm: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    minHeight: 32,
  },
  md: {
    paddingHorizontal: 18,
    paddingVertical: 11,
    minHeight: 44,
  },
  label: {
    fontWeight: '600',
  },
});
