import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { Icon } from './Icon';
import { useReducedMotion } from './useReducedMotion';
import { useTheme } from '../theme';

/**
 * The line that says the team is working.
 *
 * A turn the team runs can take a long time — the desktop's own Bot works through the
 * whole of it, and the desktop says so while it does. The phone cannot be silent until
 * the answer arrives, so the line breathes while the work goes on and says how long it
 * has been going on, which is what the desktop's own shimmer says there.
 */
export function WorkingIndicator({
  activeTurn,
  actorName,
  workingOn,
  startedAt,
}: {
  /** The turn that is running. Without one there is nothing to report. */
  activeTurn?: string;
  /** Who is doing the work. */
  actorName?: string;
  /** What the work is about, as far as the phone can tell. */
  workingOn?: string;
  /** When the turn began, so the phone can say how long it has been running. */
  startedAt?: number;
}) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  const [now, setNow] = useState(() => Date.now());

  // The line breathes for as long as the turn runs. A turn can take many minutes, so
  // the loop is stopped when the turn ends and when the screen goes away.
  useEffect(() => {
    if (!activeTurn || reducedMotion) {
      pulse.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [activeTurn, pulse, reducedMotion]);

  // The clock that says how long the work has been going on.
  useEffect(() => {
    if (!activeTurn) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activeTurn]);

  if (!activeTurn) return null;

  const elapsed = typeof startedAt === 'number' ? Math.max(0, now - startedAt) : undefined;

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.line,
        },
      ]}
      accessibilityRole="text"
      // The line changes every second, and a screen reader should say so rather than
      // stay silent while the work goes on.
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${actorName ?? 'The team'} is working`}
    >
      <View style={styles.headerLeft}>
        <Animated.View style={{ opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 1] }) }}>
          <Icon name="pulse" size={16} color={theme.colors.accent} />
        </Animated.View>
        <Animated.Text
          numberOfLines={2}
          style={[styles.title, { color: theme.colors.ink, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) }]}
        >
          {actorName ?? 'The team'} is working{workingOn ? ` on “${workingOn}”` : ''}
        </Animated.Text>
        {elapsed !== undefined ? (
          <Text style={[styles.meta, { color: theme.colors.subtleText }]}>{formatElapsed(elapsed)}</Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * How long the work has been going on.
 *
 * Seconds under a minute, then minutes and seconds, then hours and minutes — the same
 * shape the desktop's own skin uses for a duration.
 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 1,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  meta: {
    fontSize: 12,
    marginLeft: 'auto',
  },
});
