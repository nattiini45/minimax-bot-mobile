import React from 'react';
import { StyleSheet, View, type ColorValue, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

/**
 * Icons.
 *
 * They are drawn from plain views rather than pulled from an icon font or a package:
 * the app ships one bundle to the web and to the store, and a glyph that only exists
 * on one platform is a glyph that is missing on the other. Every icon here is a shape
 * on a 24 × 24 grid, scaled to the size it is asked for.
 */

export type IconName =
  | 'team'
  | 'chats'
  | 'tasks'
  | 'insights'
  | 'approvals'
  | 'send'
  | 'check'
  | 'close'
  | 'pulse'
  | 'chevron'
  | 'clock'
  | 'user'
  | 'bot'
  | 'link'
  | 'spark';

export interface IconProps {
  name: IconName;
  size?: number;
  /** The colour of the icon. Defaults to the theme's ink. */
  color?: ColorValue;
  /** Draws the icon as an outline rather than a solid shape. */
  outline?: boolean;
  style?: ViewStyle;
}

export function Icon({ name, size = 22, color, outline = false, style }: IconProps) {
  const theme = useTheme();
  const tint = color ?? theme.colors.ink;
  const scale = size / 24;
  const solid = { backgroundColor: tint } as const;
  const stroke = { borderColor: tint } as const;

  return (
    <View style={[{ width: size, height: size }, style]} accessibilityElementsHidden>
      {name === 'team' ? (
        <>
          <View style={[styles.circle, { width: 8 * scale, height: 8 * scale, borderRadius: 4 * scale, left: 8 * scale, top: 3 * scale, ...(outline ? { ...stroke, borderWidth: 1.8 * scale } : solid) }]} />
          <View style={[styles.shoulders, { width: 15 * scale, height: 8 * scale, borderTopLeftRadius: 7.5 * scale, borderTopRightRadius: 7.5 * scale, borderBottomLeftRadius: 3.5 * scale, borderBottomRightRadius: 3.5 * scale, left: 4.5 * scale, top: 13 * scale, ...(outline ? { ...stroke, borderWidth: 1.8 * scale, backgroundColor: 'transparent' } : solid) }]} />
        </>
      ) : null}

      {name === 'chats' ? (
        <>
          <View style={[styles.bubble, { width: 13 * scale, height: 10 * scale, borderRadius: 4 * scale, left: 2 * scale, top: 3 * scale, opacity: 0.45, ...solid }]} />
          <View style={[styles.bubble, { width: 12 * scale, height: 9.5 * scale, borderRadius: 4 * scale, left: 9 * scale, top: 10.5 * scale, ...solid }]} />
        </>
      ) : null}

      {name === 'tasks' ? (
        <>
          <View style={[styles.bar, { width: 2.2 * scale, height: 7 * scale, borderRadius: 1.1 * scale, left: 6 * scale, top: 13 * scale, transform: [{ rotate: '45deg' }], ...solid }]} />
          <View style={[styles.bar, { width: 2.2 * scale, height: 13 * scale, borderRadius: 1.1 * scale, left: 10.5 * scale, top: 6 * scale, transform: [{ rotate: '-45deg' }], ...solid }]} />
        </>
      ) : null}

      {name === 'insights' ? (
        <>
          <View style={[styles.bar, { width: 3.5 * scale, height: 8 * scale, borderRadius: 1.75 * scale, left: 4 * scale, top: 11 * scale, ...solid }]} />
          <View style={[styles.bar, { width: 3.5 * scale, height: 14 * scale, borderRadius: 1.75 * scale, left: 10.25 * scale, top: 5 * scale, ...solid }]} />
          <View style={[styles.bar, { width: 3.5 * scale, height: 10.5 * scale, borderRadius: 1.75 * scale, left: 16.5 * scale, top: 8.5 * scale, ...solid }]} />
        </>
      ) : null}

      {name === 'approvals' ? (
        <>
          <View style={[styles.ring, { width: 15 * scale, height: 15 * scale, borderRadius: 7.5 * scale, left: 4.5 * scale, top: 6 * scale, borderWidth: 2 * scale, ...stroke }]} />
          <View style={[styles.bar, { width: 2.2 * scale, height: 7 * scale, borderRadius: 1.1 * scale, left: 10.9 * scale, top: 2.5 * scale, ...solid }]} />
        </>
      ) : null}

      {name === 'send' ? (
        <>
          <View style={[styles.bar, { width: 2.4 * scale, height: 12 * scale, borderRadius: 1.2 * scale, left: 10.8 * scale, top: 9 * scale, ...solid }]} />
          <View style={[styles.triangle, { left: 6.8 * scale, top: 3.5 * scale, borderLeftWidth: 5.2 * scale, borderRightWidth: 5.2 * scale, borderBottomWidth: 8.5 * scale, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: tint }]} />
        </>
      ) : null}

      {name === 'check' ? (
        <>
          <View style={[styles.bar, { width: 2.2 * scale, height: 7 * scale, borderRadius: 1.1 * scale, left: 6 * scale, top: 13 * scale, transform: [{ rotate: '45deg' }], ...solid }]} />
          <View style={[styles.bar, { width: 2.2 * scale, height: 13 * scale, borderRadius: 1.1 * scale, left: 10.5 * scale, top: 6 * scale, transform: [{ rotate: '-45deg' }], ...solid }]} />
        </>
      ) : null}

      {name === 'close' ? (
        <>
          <View style={[styles.bar, { width: 2.2 * scale, height: 14 * scale, borderRadius: 1.1 * scale, left: 10.9 * scale, top: 5 * scale, transform: [{ rotate: '45deg' }], ...solid }]} />
          <View style={[styles.bar, { width: 2.2 * scale, height: 14 * scale, borderRadius: 1.1 * scale, left: 10.9 * scale, top: 5 * scale, transform: [{ rotate: '-45deg' }], ...solid }]} />
        </>
      ) : null}

      {name === 'pulse' ? (
        <View style={[styles.circle, { width: 9 * scale, height: 9 * scale, borderRadius: 4.5 * scale, left: 7.5 * scale, top: 7.5 * scale, ...solid }]} />
      ) : null}

      {name === 'chevron' ? (
        <View style={[styles.chevron, { width: 8 * scale, height: 8 * scale, left: 9 * scale, top: 8 * scale, borderWidth: 2 * scale, borderBottomWidth: 0, borderLeftWidth: 0, ...stroke }]} />
      ) : null}

      {name === 'clock' ? (
        <>
          <View style={[styles.ring, { width: 16 * scale, height: 16 * scale, borderRadius: 8 * scale, left: 4 * scale, top: 4 * scale, borderWidth: 1.9 * scale, ...stroke }]} />
          <View style={[styles.bar, { width: 1.8 * scale, height: 6 * scale, borderRadius: 0.9 * scale, left: 11.1 * scale, top: 6.5 * scale, ...solid }]} />
          <View style={[styles.bar, { width: 1.8 * scale, height: 5 * scale, borderRadius: 0.9 * scale, left: 11.1 * scale, top: 11.2 * scale, transform: [{ rotate: '90deg' }], ...solid }]} />
        </>
      ) : null}

      {name === 'user' ? (
        <>
          <View style={[styles.circle, { width: 8 * scale, height: 8 * scale, borderRadius: 4 * scale, left: 8 * scale, top: 3 * scale, ...(outline ? { ...stroke, borderWidth: 1.8 * scale } : solid) }]} />
          <View style={[styles.shoulders, { width: 15 * scale, height: 8 * scale, borderTopLeftRadius: 7.5 * scale, borderTopRightRadius: 7.5 * scale, borderBottomLeftRadius: 3.5 * scale, borderBottomRightRadius: 3.5 * scale, left: 4.5 * scale, top: 13 * scale, ...(outline ? { ...stroke, borderWidth: 1.8 * scale, backgroundColor: 'transparent' } : solid) }]} />
        </>
      ) : null}

      {name === 'bot' ? (
        <>
          <View style={[styles.ring, { width: 16 * scale, height: 16 * scale, borderRadius: 8 * scale, left: 4 * scale, top: 4 * scale, borderWidth: 1.9 * scale, ...stroke }]} />
          <View style={[styles.circle, { width: 2.6 * scale, height: 2.6 * scale, borderRadius: 1.3 * scale, left: 8.2 * scale, top: 10 * scale, ...solid }]} />
          <View style={[styles.circle, { width: 2.6 * scale, height: 2.6 * scale, borderRadius: 1.3 * scale, left: 13.2 * scale, top: 10 * scale, ...solid }]} />
        </>
      ) : null}

      {name === 'link' ? (
        <>
          <View style={[styles.ring, { width: 11 * scale, height: 7 * scale, borderRadius: 3.5 * scale, left: 2.5 * scale, top: 12 * scale, borderWidth: 1.9 * scale, transform: [{ rotate: '-35deg' }], ...stroke }]} />
          <View style={[styles.ring, { width: 11 * scale, height: 7 * scale, borderRadius: 3.5 * scale, left: 10.5 * scale, top: 5 * scale, borderWidth: 1.9 * scale, transform: [{ rotate: '-35deg' }], ...stroke }]} />
        </>
      ) : null}

      {name === 'spark' ? (
        <>
          <View style={[styles.bar, { width: 2 * scale, height: 15 * scale, borderRadius: 1 * scale, left: 11 * scale, top: 4.5 * scale, ...solid }]} />
          <View style={[styles.bar, { width: 2 * scale, height: 15 * scale, borderRadius: 1 * scale, left: 11 * scale, top: 4.5 * scale, transform: [{ rotate: '60deg' }], ...solid }]} />
          <View style={[styles.bar, { width: 2 * scale, height: 15 * scale, borderRadius: 1 * scale, left: 11 * scale, top: 4.5 * scale, transform: [{ rotate: '-60deg' }], ...solid }]} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: {
    position: 'absolute',
  },
  shoulders: {
    position: 'absolute',
  },
  bubble: {
    position: 'absolute',
  },
  bar: {
    position: 'absolute',
  },
  ring: {
    position: 'absolute',
  },
  chevron: {
    position: 'absolute',
    transform: [{ rotate: '45deg' }],
  },
  triangle: {
    position: 'absolute',
    width: 0,
    height: 0,
  },
});
