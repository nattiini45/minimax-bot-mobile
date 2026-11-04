import React from 'react';
import renderer from 'react-test-renderer';
import { FlatList, Text } from 'react-native';
import ChatScreen from '../app/chat/[id]';
import ToolboxScreen from '../app/toolbox';
import { useAppStore } from '../src/state/store';

let mockParams: { id?: string; chat?: string } = { id: 'group:a' };
const mockRouter = { push: jest.fn(), back: jest.fn() };
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams, useRouter: () => mockRouter }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('../src/native/haptics', () => ({ tapLight: jest.fn(), tapMedium: jest.fn() }));
const initial = useAppStore.getState();
let trees: renderer.ReactTestRenderer[] = [];
async function draw(element = <ChatScreen />) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(element); });
  trees.push(tree);
  return tree;
}
function control(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(n => n.props.accessibilityLabel === label && n.props.onPress)[0]!;
}
function field(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll(n => n.props.accessibilityLabel === 'Message' && n.props.onChangeText)[0]!;
}
async function press(tree: renderer.ReactTestRenderer, label: string) {
  await renderer.act(async () => { control(tree, label).props.onPress(); });
}
async function write(tree: renderer.ReactTestRenderer, text: string) {
  await renderer.act(async () => { field(tree).props.onChangeText(text); });
}
async function close(tree: renderer.ReactTestRenderer) {
  await renderer.act(async () => tree.unmount());
  trees = trees.filter(t => t !== tree);
}
beforeEach(() => {
  mockParams = { id: 'group:a' };
  jest.clearAllMocks();
  useAppStore.setState({ ...initial, messages: {}, activity: {}, drafts: {}, composerInsert: null, groups: [{ groupId: 'a', name: 'Team', memberIds: ['b'] }], bots: [{ botId: 'b', name: 'Builder' }],
    requestAsync: jest.fn(async () => ({})), sendChatMessage: jest.fn() });
});
afterEach(async () => { await renderer.act(async () => trees.forEach(t => t.unmount())); trees = []; jest.restoreAllMocks(); });
it.each(['bot:50%', 'bot:literal%2F', 'bot:日本語/one'])('uses the already decoded router chat id %s without interpreting it again', async chatId => {
  mockParams = { id: chatId };
  const tree = await draw();
  await write(tree, 'Hello');
  await press(tree, 'Send');
  expect(useAppStore.getState().requestAsync).toHaveBeenCalledWith('op.list_history', { chatId });
  expect(useAppStore.getState().sendChatMessage).toHaveBeenCalledWith(chatId, 'Hello', []);
});
it.each(['bot:50%', 'bot:literal%2F', 'bot:日本語/one'])('inserts a skill into the exact decoded toolbox chat %s', async chatId => {
  mockParams = { chat: chatId };
  useAppStore.setState({ requestAsync: jest.fn(async () => ({ skills: [{ id: 'plan', name: 'Plan' }], plugins: [], agents: [], mcp: [] })) });
  const tree = await draw(<ToolboxScreen />);
  await press(tree, 'Use plan');
  expect(useAppStore.getState().composerInsert?.chatId).toBe(chatId);
});
it('follows initial history and own sends but does not jump while older history is being read', async () => {
  const tree = await draw();
  const list = tree.root.findAllByType(FlatList)[0]!;
  const scroll = jest.spyOn(list.instance, 'scrollToEnd').mockImplementation(() => {});
  await renderer.act(async () => list.props.onContentSizeChange(300, 2000));
  expect(scroll).toHaveBeenCalled();
  scroll.mockClear();
  expect(list.props.onScroll).toBeDefined();
  await renderer.act(async () => list.props.onScroll({ nativeEvent: { contentSize: { height: 2000 }, layoutMeasurement: { height: 500 }, contentOffset: { y: 100 } } }));
  await renderer.act(async () => list.props.onContentSizeChange(300, 2200));
  expect(scroll).not.toHaveBeenCalled();
  await write(tree, 'My next message');
  await press(tree, 'Send');
  await renderer.act(async () => list.props.onContentSizeChange(300, 2300));
  expect(scroll).toHaveBeenCalledWith({ animated: true });
  scroll.mockClear();
  await renderer.act(async () => list.props.onScroll({ nativeEvent: { contentSize: { height: 2300 }, layoutMeasurement: { height: 500 }, contentOffset: { y: 1780 } } }));
  await renderer.act(async () => list.props.onContentSizeChange(300, 2340));
  expect(scroll).toHaveBeenCalled();
});
it.each([false, true])('keeps a failed message recoverable without automatic execution (uncertain=%s)', async uncertain => {
  useAppStore.setState({ messages: { 'group:a': [{ messageId: 'failed', chatId: 'group:a', role: 'user', text: 'Recover this', ts: 1, mentions: ['b'], deliveryError: 'No confirmation', deliveryUncertain: uncertain, retryable: !uncertain }] } });
  const tree = await draw();
  expect(tree.root.findAllByType(Text).map(n => n.props.children).flat().join(' ')).toContain(uncertain ? 'Delivery uncertain' : 'Not sent');
  expect(useAppStore.getState().sendChatMessage).not.toHaveBeenCalled();
  await press(tree, 'Edit message draft');
  expect(field(tree).props.value).toBe('Recover this');
  expect(control(tree, 'Mention Builder').props.accessibilityState.selected).toBe(true);
  expect(useAppStore.getState().sendChatMessage).not.toHaveBeenCalled();
  expect(control(tree, 'Retry message') === undefined).toBe(uncertain);
});
it('does not present failed history as a brand-new empty conversation', async () => {
  useAppStore.setState({ requestAsync: jest.fn(async () => { throw new Error('History unavailable'); }) });
  const tree = await draw();
  const text = tree.root.findAllByType(Text).map(n => n.props.children).flat().join(' ');
  expect(text).toContain('History unavailable');
  expect(text).not.toContain('Say hello');
});
it('retains a refused send through the real store and restores its text and mentions only on request', async () => {
  useAppStore.setState({ sendChatMessage: initial.sendChatMessage, request: jest.fn(() => 'send-refused') });
  const tree = await draw();
  await write(tree, 'Important message');
  await press(tree, 'Mention Builder');
  await press(tree, 'Send');
  expect(field(tree).props.value).toBe('');
  await renderer.act(async () => { useAppStore.getState().applyFrame({ v: 1, id: 'error', ts: 1, type: 'err', source: 'bridge', payload: { opId: 'send-refused', code: 'REFUSED', message: 'Not accepted' } }); });
  expect(tree.root.findAllByType(Text).map(n => n.props.children).flat().join(' ')).toContain('Not accepted');
  await press(tree, 'Edit message draft');
  expect(field(tree).props.value).toBe('Important message');
  expect(control(tree, 'Mention Builder').props.accessibilityState.selected).toBe(true);
  expect(useAppStore.getState().request).toHaveBeenCalledTimes(1);
});
it('consumes a toolbox insertion once so send and remount cannot resurrect it', async () => {
  useAppStore.getState().insertIntoComposer('group:a', '/plan');
  let tree = await draw();
  expect(field(tree).props.value).toBe('/plan');
  await press(tree, 'Send');
  await close(tree);
  tree = await draw();
  expect(field(tree).props.value).toBe('');
  expect(useAppStore.getState().composerInsert).toBeNull();
});
it('keeps each conversation draft and mentions across unmounts without mixing chats', async () => {
  let tree = await draw();
  await write(tree, 'Draft for the team');
  await press(tree, 'Mention Builder');
  await close(tree);
  mockParams = { id: 'bot:b' };
  tree = await draw();
  expect(field(tree).props.value).toBe('');
  await write(tree, 'Private draft');
  await close(tree);
  mockParams = { id: 'group:a' };
  tree = await draw();
  expect(field(tree).props.value).toBe('Draft for the team');
  expect(control(tree, 'Mention Builder').props.accessibilityState.selected).toBe(true);
  await press(tree, 'Send');
  expect(useAppStore.getState().sendChatMessage).toHaveBeenCalledWith('group:a', 'Draft for the team', ['b']);
  expect(useAppStore.getState().drafts['bot:b']?.text).toBe('Private draft');
});
