import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ChatNotifier } from '../src/components/ChatNotifier';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { configureNotifications, onNotificationOpened, requestNotificationPermission } from '../src/native/notifications';
import { chatPath } from '../src/nav/paths';
import { ThemeProvider, useTheme } from '../src/theme';
import { connectRelay, loadOutbox, loadSession, useAppStore } from '../src/state/store';
import { OwnerBoundary } from '../src/state/OwnerBoundary';

/**
 * The width the app is laid out at.
 *
 * The app is a phone app that also runs in a browser, and a phone app stretched
 * across a desktop screen is a wide, empty thing with a chat bubble in the middle
 * of it. On a wide screen the app therefore keeps the shape it was designed for:
 * one column, the width a phone is, centred.
 */
const APP_COLUMN_WIDTH = 520;

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
  const router = useRouter();
  const pathname = usePathname();
  const session = useAppStore((state) => state.session);
  const { width } = useWindowDimensions();
  const wide = width > 760;

  useEffect(() => {
    configureNotifications();
    void requestNotificationPermission();
    const current = useAppStore.getState();
    if (current.session) return;
    const generation = current.ownerGeneration;
    let alive = true;
    const authoritative = () => alive && useAppStore.getState().ownerGeneration === generation;
    // Fence the whole combined read, not just loadSession: pairing/logout can occur
    // after the session has resolved while its outbox read is still pending.
    void Promise.all([loadSession(), loadOutbox()]).then(([session, outbox]) => {
      if (!authoritative()) return;
      if (!session) { useAppStore.setState({ outbox: [] }); return; }
      useAppStore.setState({ outbox });
      useAppStore.getState().setSession(session);
      connectRelay(session);
    }).catch(() => {
      if (authoritative()) useAppStore.getState().setError('The saved account link could not be restored. Pair this phone again.');
    });
    return () => { alive = false; };
  }, []);

  useEffect(
    () =>
      // A notification names the conversation it is about, so opening it opens that
      // conversation rather than wherever the app happened to be.
      onNotificationOpened((chatId) => {
        if (chatId) router.push(chatPath(chatId));
      }),
    [router],
  );

  return (
    <>
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <View style={[styles.shell, { backgroundColor: theme.dark ? '#08090b' : '#e9edf2' }]}>
        <View
          style={[
            styles.column,
            {
              maxWidth: APP_COLUMN_WIDTH,
              backgroundColor: theme.colors.bg,
              borderLeftColor: theme.colors.line,
              borderRightColor: theme.colors.line,
              borderLeftWidth: wide ? StyleSheet.hairlineWidth : 0,
              borderRightWidth: wide ? StyleSheet.hairlineWidth : 0,
            },
          ]}
        >
          <OwnerBoundary>
          <ChatNotifier />
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
            <Stack.Screen name="chat/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="bot/[id]" options={{ title: 'Bot' }} />
            <Stack.Screen name="group/[id]" options={{ title: 'Group' }} />
            <Stack.Screen name="toolbox" options={{ title: 'Toolbox' }} />
          </Stack>
          <ConnectionBanner
            showConnection={pathname !== '/' && pathname !== '/settings'}
            showError={pathname !== '/' || Boolean(session)}
          />
          </OwnerBoundary>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  shell: {
    flex: 1,
    alignItems: 'center',
  },
  column: {
    flex: 1,
    width: '100%',
  },
});
