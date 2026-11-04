import { Tabs, useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View, type ColorValue } from 'react-native';

import { Icon, type IconName } from '../../src/components/Icon';
import { useTheme } from '../../src/theme';
import { useAppStore } from '../../src/state/store';

/** The tabs are drawn from the same shapes as the rest of the app, not from glyphs. */
function TabIcon({ name, color }: { name: IconName; color: ColorValue }) {
  return (
    <View style={styles.icon}>
      <Icon name={name} size={22} color={color} />
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
  const router = useRouter();

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.bg },
        headerTintColor: theme.colors.ink,
        headerTitleStyle: { fontSize: 17, fontWeight: '600' },
        headerShadowVisible: false,
        headerRight: () => (
          <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={() => router.push('/settings')} style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ color: theme.colors.ink, fontSize: 14 }}>Settings</Text>
          </Pressable>
        ),
        sceneStyle: { backgroundColor: theme.colors.bg },
        // The active tab is the one accent in the bar, so the eye finds it without
        // the label having to shout.
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.subtleText,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.line,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '500' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Team',
          tabBarIcon: ({ color }) => <TabIcon name="team" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: 'Chats',
          tabBarIcon: ({ color }) => <TabIcon name="chats" color={color} />,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: 'Tasks',
          tabBarIcon: ({ color }) => <TabIcon name="tasks" color={color} />,
        }}
      />
      <Tabs.Screen
        name="insights"
        options={{
          title: 'Insights',
          tabBarIcon: ({ color }) => <TabIcon name="insights" color={color} />,
        }}
      />
      <Tabs.Screen
        name="approvals"
        options={{
          title: 'Approvals',
          tabBarIcon: ({ color }) => (
            <View>
              <TabIcon name="approvals" color={color} />
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
