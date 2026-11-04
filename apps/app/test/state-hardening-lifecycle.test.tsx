import React from 'react';
import renderer from 'react-test-renderer';
import RootLayout from '../app/_layout';
import BotScreen from '../app/bot/[id]';
import { ApprovalCard, QuestionCard } from '../src/components/cards';
import * as Store from '../src/state/store';

jest.mock('expo-router', () => {
  const React = require('react'); const { View } = require('react-native');
  return { useLocalSearchParams: () => ({ id: 'b' }), usePathname: () => '/',
    useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
    Stack: Object.assign(({ children }: any) => React.createElement(View, {}, children), { Screen: () => null }) };
});
jest.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: require('react-native').View }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: require('react-native').View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../src/native/notifications', () => ({ configureNotifications: jest.fn(), requestNotificationPermission: jest.fn(async () => false), onNotificationOpened: () => () => {}, notify: jest.fn() }));
jest.mock('../src/native/haptics', () => ({ tapLight: jest.fn(), tapMedium: jest.fn() }));
jest.mock('../src/state/store', () => {
  const actual = jest.requireActual('../src/state/store');
  return { ...actual, loadSession: jest.fn(actual.loadSession), loadOutbox: jest.fn(actual.loadOutbox), connectRelay: jest.fn() };
});
const { useAppStore } = Store;
const A = { relayUrl: 'https://a.example', accountId: 'default', deviceId: 'a', deviceToken: 'secret-a', deviceName: 'Phone' };
const B = { ...A, relayUrl: 'https://b.example', deviceId: 'b', deviceToken: 'secret-b' };
let trees: renderer.ReactTestRenderer[] = [];
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
async function mount(element: React.ReactElement) { let tree!: renderer.ReactTestRenderer; await renderer.act(async () => { tree = renderer.create(element); }); trees.push(tree); return tree; }
function control(tree: renderer.ReactTestRenderer, label: string) { return tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]!; }
function field(tree: renderer.ReactTestRenderer, label: string) { return tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function')[0]!; }
beforeEach(() => { jest.clearAllMocks(); useAppStore.getState().setSession(null); useAppStore.setState(useAppStore.getInitialState(), true); });
afterEach(async () => { await renderer.act(async () => { trees.forEach(t => t.unmount()); trees = []; useAppStore.getState().setSession(null); }); jest.restoreAllMocks(); });

test.each([{ name: 'same credential after logout', session: A }, { name: 'different credential', session: B }])('$name: editor preserves only current-owner private state and rejects old submit callbacks', async ({ session }) => {
  useAppStore.getState().setSession(A);
  const readA = jest.fn(async (type: string) => type === 'op.recall' ? { entries: [{ id: 'a', text: 'A private memory', createdAt: 1 }] } : null);
  useAppStore.setState({ bots: [{ botId: 'b', name: 'A bot', instructions: 'A instructions' }], requestAsync: readA });
  const tree = await mount(<BotScreen />);
  await renderer.act(async () => { field(tree, 'Instructions').props.onChangeText('A private draft'); field(tree, 'New memory').props.onChangeText('A private note'); });
  const oldSave = control(tree, 'Save').props.onPress;
  const oldRemember = control(tree, 'Remember').props.onPress;
  await renderer.act(async () => { useAppStore.setState({ bots: [{ botId: 'b', name: 'A roster update', instructions: 'A remote edit' }] }); });
  expect(field(tree, 'Instructions').props.value).toBe('A private draft');
  const mutationB = jest.fn(() => 'b-update');
  const readB = jest.fn(async (type: string) => type === 'op.recall' ? { entries: [{ id: 'b', text: 'B memory', createdAt: 2 }] } : null);
  await renderer.act(async () => {
    useAppStore.getState().setSession(null);
    useAppStore.getState().setSession(session);
    useAppStore.setState({ bots: [{ botId: 'b', name: 'B bot', instructions: 'B instructions' }], request: mutationB, requestAsync: readB });
  });
  expect(field(tree, 'Instructions').props.value).toBe('B instructions');
  expect(field(tree, 'New memory').props.value).toBe('');
  expect(JSON.stringify(tree.toJSON())).not.toContain('A private');
  expect(JSON.stringify(tree.toJSON())).toContain('B memory');
  await renderer.act(async () => { oldSave(); oldRemember(); });
  expect(mutationB).not.toHaveBeenCalled();
  expect(readB.mock.calls.some(([type]) => type === 'op.remember')).toBe(false);
  await renderer.act(async () => { control(tree, 'Save').props.onPress(); });
  expect(mutationB).toHaveBeenCalledWith('op.update_bot', expect.objectContaining({ botId: 'b', instructions: 'B instructions' }));
});

test('late old-owner memory cannot replace the current owner memory', async () => {
  const old = deferred<{ entries: { id: string; text: string; createdAt: number }[] }>();
  useAppStore.getState().setSession(A);
  useAppStore.setState({ bots: [{ botId: 'b', name: 'A' }], requestAsync: jest.fn(type => type === 'op.recall' ? old.promise : Promise.resolve(null)) });
  const tree = await mount(<BotScreen />);
  await renderer.act(async () => {
    useAppStore.getState().setSession(B);
    useAppStore.setState({ bots: [{ botId: 'b', name: 'B' }], requestAsync: jest.fn(async type => type === 'op.recall' ? { entries: [{ id: 'b', text: 'Current B memory', createdAt: 2 }] } : null) });
  });
  await renderer.act(async () => { old.resolve({ entries: [{ id: 'a', text: 'Forbidden A memory', createdAt: 1 }] }); });
  expect(JSON.stringify(tree.toJSON())).not.toContain('Forbidden A memory');
  expect(JSON.stringify(tree.toJSON())).toContain('Current B memory');
});

test.each(['permission', 'question'] as const)('uncertain %s card is honest and offers no second answer', async kind => {
  const props = { request: { requestId: 'r', sessionId: 's', toolName: 'shell', reason: 'Approval', title: 'Question', steps: [] }, decided: 'uncertain' };
  const tree = await mount(kind === 'permission' ? <ApprovalCard {...props} onDecide={jest.fn()} /> : <QuestionCard {...props} onAnswer={jest.fn()} />);
  const output = JSON.stringify(tree.toJSON());
  expect(output).toContain('uncertain');
  expect(output).not.toContain('You answered this.');
  expect(output).not.toContain('You allowed this once.');
  expect(control(tree, kind === 'permission' ? 'Allow once' : 'Send answer')).toBeUndefined();
});

test.each([false, true])('Root hydration errors cannot mutate a newer owner (changed=%s)', async changed => {
  const failed = deferred<Store.OutboxItem[]>();
  jest.mocked(Store.loadSession).mockResolvedValueOnce(A);
  jest.mocked(Store.loadOutbox).mockReturnValueOnce(failed.promise);
  await mount(<RootLayout />);
  await renderer.act(async () => { if (changed) useAppStore.getState().setSession(B); failed.reject(new Error('private old read failed')); });
  expect(useAppStore.getState().lastError).toBe(changed ? null : 'The saved account link could not be restored. Pair this phone again.');
  expect(Store.connectRelay).not.toHaveBeenCalled();
});

test.each(['pair', 'logout', 'null-result', 'unmount'] as const)('real Root startup hydration cannot regain authority after %s', async mode => {
  const outbox = deferred<Store.OutboxItem[]>();
  jest.mocked(Store.loadSession).mockResolvedValueOnce(mode === 'null-result' ? null : A);
  jest.mocked(Store.loadOutbox).mockReturnValueOnce(outbox.promise);
  const tree = await mount(<RootLayout />);
  await renderer.act(async () => {
    if (mode === 'unmount') { tree.unmount(); trees = trees.filter(t => t !== tree); }
    else useAppStore.getState().setSession(mode === 'logout' ? null : B);
  });
  const currentSession = useAppStore.getState().session;
  await renderer.act(async () => { outbox.resolve([{ opId: 'old-a', type: 'op.forget', payload: { id: 'old' }, accountId: 'default', queuedAt: 1 }]); });
  expect(useAppStore.getState().session).toEqual(currentSession);
  expect(useAppStore.getState().outbox).toEqual([]);
  expect(Store.connectRelay).not.toHaveBeenCalled();
});
