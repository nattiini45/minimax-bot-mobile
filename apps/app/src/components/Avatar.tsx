import React from 'react';
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

/**
 * Bot avatar.
 *
 * MiniMax gives every Bot an octopus. The official skins are image assets, so this
 * draws the same motif in code: a rounded body with two eyes, tinted by the Bot's look.
 */

const LOOKS: Record<string, string> = {
  fuzzy: '#8ab4f8',
  bubble: '#f7b2e3',
  glass: '#a5d8ff',
  gold: '#f2c14e',
  jade: '#7fd1ae',
  plush: '#f0a58f',
  waffle: '#e0b46b',
  pixel: '#9aa0a6',
  smiley: '#ffd166',
  toys: '#ef8354',
  moon: '#b8b8d1',
  ocean: '#5aa9e6',
  sky: '#8ecae6',
  teal: '#4ecdc4',
  green: '#7bc96f',
  lime: '#cde77f',
  yellow: '#ffd166',
  orange: '#f4845f',
  red: '#e07a5f',
  pink: '#f28cab',
  violet: '#b088f9',
  indigo: '#6c63ff',
  graphite: '#8a8f98',
};

export interface AvatarProps {
  name: string;
  skin?: string;
  color?: string;
  size?: number;
  style?: ViewStyle;
}

export function Avatar({ name, skin, color, size = 40, style }: AvatarProps) {
  const theme = useTheme();
  const tint = LOOKS[color ?? ''] ?? LOOKS[skin ?? ''] ?? theme.colors.muted;
  const initial = name.trim().charAt(0).toUpperCase() || '?';

  return (
    <View
      accessible
      accessibilityLabel={`${name} avatar`}
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tint,
          borderColor: theme.colors.line,
        },
        style,
      ]}
    >
      <View style={[styles.eye, { left: size * 0.31, top: size * 0.42 }]} />
      <View style={[styles.eye, { left: size * 0.55, top: size * 0.42 }]} />
      <Text style={[styles.initial, { fontSize: size * 0.26, color: 'rgba(0,0,0,0.55)' }]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  eye: {
    position: 'absolute',
    width: 5,
    height: 7,
    borderRadius: 3,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  initial: {
    position: 'absolute',
    bottom: 2,
    fontWeight: '600',
  },
});
