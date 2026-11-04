import React from 'react';
import type { ModelCatalog } from '@minimax-bot/protocol';
import renderer from 'react-test-renderer';
import ApprovalsScreen from '../app/(tabs)/approvals';
import BotScreen from '../app/bot/[id]';
import { useAppStore, type AppQuestion } from '../src/state/store';

const mockRouter = { push: jest.fn(), back: jest.fn() };
let mockParams = { id: 'a' };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));
jest.mock('../src/native/haptics', () => ({ tapLight: jest.fn(), tapMedium: jest.fn(), notifyWarning: jest.fn() }));
const initial = useAppStore.getState();
let trees: renderer.ReactTestRenderer[] = [];
async function draw(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(element); });
  trees.push(tree);
  return tree;
}
function control(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]!;
}
function field(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onChangeText === 'function')[0]!;
}
async function press(tree: renderer.ReactTestRenderer, label: string) {
  await renderer.act(async () => { control(tree, label).props.onPress(); });
}
async function write(tree: renderer.ReactTestRenderer, label: string, text: string) {
  await renderer.act(async () => { field(tree, label).props.onChangeText(text); });
}
beforeEach(() => {
  mockParams = { id: 'a' };
  jest.clearAllMocks();
  useAppStore.setState({ ...initial, bots: [{ botId: 'a', name: 'Chief', role: 'Original role', model: 'provider/legacy', effort: 'high', instructions: 'Original instructions' }], questions: [], approvals: [], decided: {},
    request: jest.fn(() => 'op-test'), requestAsync: jest.fn(async type => type === 'op.list_models' ? null : { entries: [] }), updateBot: jest.fn() });
});
afterEach(async () => {
  await renderer.act(async () => { trees.forEach(tree => tree.unmount()); });
  trees = [];
});
it('preserves dirty profile fields while updating untouched remote fields', async () => {
  const tree = await draw(<BotScreen />);
  await write(tree, 'Instructions', 'Unsaved instructions');
  await renderer.act(async () => {
    useAppStore.setState({ bots: [{ ...useAppStore.getState().bots[0]!, role: 'Remote role', instructions: 'Remote instructions' }] });
  });
  expect(field(tree, 'Instructions').props.value).toBe('Unsaved instructions');
  expect(field(tree, 'Role').props.value).toBe('Remote role');
});
it('follows later roster edits once the roster matches the local field value', async () => {
  const tree = await draw(<BotScreen />);
  await write(tree, 'Role', 'Saved role');
  await press(tree, 'Save');
  await renderer.act(async () => useAppStore.setState({ bots: [{ ...useAppStore.getState().bots[0]!, role: 'Saved role' }] }));
  await renderer.act(async () => useAppStore.setState({ bots: [{ ...useAppStore.getState().bots[0]!, role: 'Later remote role' }] }));
  expect(field(tree, 'Role').props.value).toBe('Later remote role');
});
it.each(['missing', 'error'])('preserves an existing model and effort when the catalog is %s', async (availability) => {
  if (availability === 'error') useAppStore.setState({ requestAsync: jest.fn(async type => {
    if (type === 'op.list_models') throw new Error('Catalog unavailable');
    return { entries: [] };
  }) });
  const tree = await draw(<BotScreen />);
  await write(tree, 'Role', 'New role');
  await press(tree, 'Save');
  expect(useAppStore.getState().updateBot).toHaveBeenCalledWith('a', expect.objectContaining({ role: 'New role', model: 'provider/legacy', effort: 'high' }));
});
it.each([
  { name: 'known incompatible', modelId: 'legacy', efforts: ['low'], expected: 'default' },
  { name: 'known compatible', modelId: 'legacy', efforts: ['low', 'high'], expected: 'high' },
  { name: 'unknown model', modelId: 'another-model', efforts: ['low'], expected: 'high' },
])('only normalizes effort for a $name catalog entry', async ({ modelId, efforts, expected }) => {
  const catalog: ModelCatalog = { supported: true, models: [{ providerId: 'provider', modelId, id: `provider/${modelId}`, name: 'Catalog model', efforts }] };
  useAppStore.setState({ requestAsync: jest.fn(async type => type === 'op.list_models' ? catalog : { entries: [] }) });
  const tree = await draw(<BotScreen />);
  await write(tree, 'Role', 'New role');
  await press(tree, 'Save');
  expect(useAppStore.getState().updateBot).toHaveBeenCalledWith('a', expect.objectContaining({ effort: expected }));
});
it('retains a refused memory note with an accessible error, then clears it after a successful retry', async () => {
  let refused = true;
  useAppStore.setState({ requestAsync: jest.fn(async type => {
    if (type === 'op.remember' && refused) throw new Error('Write refused');
    return type === 'op.list_models' ? null : { entries: [] };
  }) });
  const tree = await draw(<BotScreen />);
  await write(tree, 'New memory', 'Keep this note');
  await press(tree, 'Remember');
  expect(field(tree, 'New memory').props.value).toBe('Keep this note');
  expect(tree.root.findAll(n => n.props.accessibilityRole === 'alert' && JSON.stringify(n.props.children).includes('Write refused')).length).toBeGreaterThan(0);
  refused = false;
  await press(tree, 'Remember');
  expect(field(tree, 'New memory').props.value).toBe('');
});
it('distinguishes a refused memory read from a bot with no memories', async () => {
  useAppStore.setState({ requestAsync: jest.fn(async type => {
    if (type === 'op.recall') throw new Error('Memory unavailable');
    return null;
  }) });
  const tree = await draw(<BotScreen />);
  const text = tree.root.findAll(n => n.props.accessibilityRole === 'alert').map(n => n.props.children).flat().join(' ');
  expect(text).toContain('Memory unavailable');
  expect(JSON.stringify(tree.toJSON())).not.toContain('Nothing remembered yet');
});
const question: AppQuestion = { requestId: 'q', sessionId: 's', title: 'Plan the work', steps: [
  { id: 's1', question: 'Choose tools', selectionMode: 'multiple', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { id: 's2', question: 'Describe', selectionMode: 'single', options: [] },
  { id: 's3', question: 'Optional', selectionMode: 'single', options: [] },
] };
it('collects the full questionnaire in Approvals and submits only after confirmation, once', async () => {
  useAppStore.setState({ questions: [question] });
  const tree = await draw(<ApprovalsScreen />);
  await press(tree, 'A');
  await press(tree, 'B');
  expect(useAppStore.getState().request).not.toHaveBeenCalled();
  await write(tree, 'Your answer to: Describe', 'A careful plan');
  await press(tree, 'Send answer');
  expect(useAppStore.getState().request).toHaveBeenCalledWith('op.answer_question', { requestId: 'q', answers: [
    { stepId: 's1', selectedOptionIds: ['a', 'b'], selectedOther: false },
    { stepId: 's2', selectedOptionIds: [], selectedOther: true, otherText: 'A careful plan' },
    { stepId: 's3', selectedOptionIds: [], selectedOther: false, skipped: true },
  ] });
  expect(control(tree, 'Send answer')).toBeUndefined();
  useAppStore.getState().answerQuestion('q', []);
  expect(useAppStore.getState().request).toHaveBeenCalledTimes(1);
});
