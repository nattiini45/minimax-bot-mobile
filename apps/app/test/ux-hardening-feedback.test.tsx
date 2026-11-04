import React from 'react';
import renderer from 'react-test-renderer';
import { Text } from 'react-native';
import InsightsScreen from '../app/(tabs)/insights';
import { useAppStore } from '../src/state/store';

import RootLayout from '../app/_layout';
import TabsLayout from '../app/(tabs)/_layout';
import * as Store from '../src/state/store';

let mockPath = '/insights';
const mockRouter = { push: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Stack = Object.assign(({ children }: any) => React.createElement(View, null, children), { Screen: () => null });
  const Tabs = Object.assign(({ screenOptions, children }: any) => React.createElement(View, null, screenOptions.headerRight?.(), children), { Screen: () => null });
  return { Stack, Tabs, useRouter: () => mockRouter, usePathname: () => mockPath };
});
jest.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: ({ children }: any) => children }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: ({ children }: any) => children, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../src/components/ChatNotifier', () => ({ ChatNotifier: () => null }));
jest.mock('../src/native/notifications', () => ({ configureNotifications: jest.fn(), requestNotificationPermission: jest.fn(), onNotificationOpened: () => () => {} }));
const initial = useAppStore.getState();
let trees: renderer.ReactTestRenderer[] = [];
async function draw(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(element); });
  trees.push(tree);
  return tree;
}
function words(tree: renderer.ReactTestRenderer) { return tree.root.findAllByType(Text).map(n => n.props.children).flat().join(' '); }
beforeEach(() => {
  mockPath = '/insights';
  jest.spyOn(Store, 'loadSession').mockResolvedValue(null);
  jest.spyOn(Store, 'loadOutbox').mockResolvedValue([]);
  useAppStore.setState({ ...initial, lastError: null, requestAsync: jest.fn(async () => ({})) });
});
afterEach(async () => { await renderer.act(async () => trees.forEach(t => t.unmount())); trees = []; });
it('shows and dismisses operation failures from the app shell, including unpaired screens', async () => {
  useAppStore.setState({ lastError: 'Operation refused' });
  const tree = await draw(<RootLayout />);
  expect(words(tree)).toContain('Operation refused');
  expect(tree.root.findAll(n => n.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
  const dismiss = tree.root.findAll(n => n.props.accessibilityLabel === 'Dismiss error' && n.props.onPress)[0]!;
  await renderer.act(async () => dismiss.props.onPress());
  expect(useAppStore.getState().lastError).toBeNull();
  expect(words(tree)).not.toContain('Operation refused');
});
it('makes Settings reachable from an ordinary tab header without adding another tab', async () => {
  const tree = await draw(<TabsLayout />);
  const settings = tree.root.findAll(n => n.props.accessibilityLabel === 'Settings' && n.props.onPress)[0]!;
  expect(settings).toBeDefined();
  await renderer.act(async () => settings.props.onPress());
  expect(mockRouter.push).toHaveBeenCalledWith('/settings');
});
it.each(['/', '/settings', '/insights'])('avoids duplicate connection summaries on %s', async path => {
  mockPath = path;
  useAppStore.setState({ session: { relayUrl: 'https://example.invalid', accountId: 'account', deviceId: 'device', deviceToken: 'token', deviceName: 'Test' }, status: 'offline' });
  const tree = await draw(<RootLayout />);
  expect(words(tree).includes('Relay unreachable')).toBe(path === '/insights');
});
it('distinguishes a refused usage read from an empty account and can refresh successfully', async () => {
  let refused = true;
  useAppStore.setState({ requestAsync: jest.fn(async () => {
    if (refused) throw new Error('Usage refused');
    return { totals: { turns: 7, chars: 2, tools: 0, errors: 0 }, byBot: [] };
  }) });
  const tree = await draw(<InsightsScreen />);
  expect(words(tree)).toContain('Usage refused');
  expect(words(tree)).not.toContain('No usage yet');
  refused = false;
  const refresh = tree.root.findAll(n => n.props.accessibilityLabel === 'Refresh' && n.props.onPress)[0]!;
  await renderer.act(async () => refresh.props.onPress());
  expect(words(tree)).not.toContain('Usage refused');
  expect(words(tree)).toContain('7');
});
