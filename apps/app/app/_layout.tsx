import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { configureNotifications, requestNotificationPermission } from '../src/native/notifications';
import { ThemeProvider, useTheme } from '../src/theme';
import { connectRelay, loadOutbox, loadSession, useAppStore } from '../src/state/store';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <Shell />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Shell() {
  const theme = useTheme();

  useEffect(() => {
    configureNotifications();
    void requestNotificationPermission();
    // The outbox is restored before the connection opens, so a message composed while
    // the desktop was unreachable is sent as soon as the relay is reachable again.
    void Promise.all([loadSession(), loadOutbox()]).then(([session, outbox]) => {
      useAppStore.setState({ outbox });
      if (!session) return;
      useAppStore.getState().setSession(session);
      connectRelay(session);
    });
  }, []);

  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.colors.bg },
          headerTintColor: theme.colors.ink,
          headerTitleStyle: { fontSize: 17, fontWeight: '600' },
          contentStyle: { backgroundColor: theme.colors.bg },
          headerShadowVisible: false,
          // Without this the web back button is announced as "(tabs), back": the route
          // group's name leaks into the accessible name of the control.
          headerBackTitle: 'Back',
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: 'Settings', presentation: 'modal' }} />
        <Stack.Screen name="pair" options={{ title: 'Pair a phone', presentation: 'modal' }} />
        <Stack.Screen name="chat/[id]" options={{ title: 'Chat' }} />
        <Stack.Screen name="bot/[id]" options={{ title: 'Bot' }} />
        <Stack.Screen name="group/[id]" options={{ title: 'Group' }} />
      </Stack>
    </>
  );
}
