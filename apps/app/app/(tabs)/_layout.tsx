import { Tabs } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';

import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/** Text glyphs keep the tab bar dependency-free and identical on every platform. */
function TabIcon({ glyph, color }: { glyph: string; color: ColorValue }) {
  return (
    <View style={styles.icon}>
      <Text style={{ fontSize: 18, color }}>{glyph}</Text>
    </View>
  );
}

function ApprovalsBadge() {
  const theme = useTheme();
  const approvals = useAppStore((state) => state.approvals);
  const questions = useAppStore((state) => state.questions);
  const count = approvals.length + questions.length;
  if (!count) return null;
  return (
    <View style={[styles.badge, { backgroundColor: theme.colors.danger }]}>
      <Text style={styles.badgeText}>{count > 9 ? '9+' : count}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const theme = useTheme();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTintColor: theme.colors.ink,
        headerTitleStyle: { fontSize: 17, fontWeight: '600' },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: theme.colors.bg },
        tabBarActiveTintColor: theme.colors.ink,
        tabBarInactiveTintColor: theme.colors.subtle,
        tabBarStyle: {
          backgroundColor: theme.colors.bg,
          borderTopColor: theme.colors.line,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Team',
          tabBarIcon: ({ color }) => <TabIcon glyph="◉" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color }) => <TabIcon glyph="✳" color={color} />,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Tasks',
          tabBarIcon: ({ color }) => <TabIcon glyph="◷" color={color} />,
        }}
      />
      <Tabs.Screen
        name="insights"
        options={{
          title: 'Insights',
          tabBarIcon: ({ color }) => <TabIcon glyph="◔" color={color} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Approvals',
          tabBarIcon: ({ color }) => (
            <View>
              <TabIcon glyph="⏻" color={color} />
              <ApprovalsBadge />
            </View>
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  icon: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -10,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
});
