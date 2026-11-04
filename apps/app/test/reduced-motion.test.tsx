import React from 'react';
import renderer from 'react-test-renderer';
import { AccessibilityInfo, Animated, Modal, Text } from 'react-native';
import { Picker } from '../src/components/Picker';
import { WorkingIndicator } from '../src/components/WorkingIndicator';

let trees: renderer.ReactTestRenderer[] = [];
async function draw(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(element); });
  trees.push(tree);
  return tree;
}
afterEach(() => {
  renderer.act(() => trees.forEach(tree => tree.unmount()));
  trees = [];
  jest.restoreAllMocks();
});
it('uses a static, informative working status initially and stops/resumes motion on preference changes', async () => {
  let change!: (enabled: boolean) => void;
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  const remove = jest.fn();
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((event, callback) => {
    if (event === 'reduceMotionChanged') change = callback;
    return { remove };
  });
  const start = jest.fn();
  const stop = jest.fn();
  jest.spyOn(Animated, 'loop').mockReturnValue({ start, stop, reset: jest.fn() });
  const tree = await draw(<WorkingIndicator activeTurn="turn" actorName="Chief" workingOn="the plan" startedAt={Date.now()} />);
  expect(start).not.toHaveBeenCalled();
  expect(JSON.stringify(tree.toJSON())).toContain('the plan');
  await renderer.act(async () => change(false));
  expect(start).toHaveBeenCalledTimes(1);
  await renderer.act(async () => change(true));
  expect(stop).toHaveBeenCalledTimes(1);
});
it('disables picker sliding for the initial preference and observes runtime changes', async () => {
  let change!: (enabled: boolean) => void;
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((event, callback) => {
    if (event === 'reduceMotionChanged') change = callback;
    return { remove: jest.fn() };
  });
  const tree = await draw(<Picker label="Model" value="one" options={[{ value: 'one', label: 'One' }]} onChange={() => {}} />);
  expect(tree.root.findByType(Modal).props.animationType).toBe('none');
  await renderer.act(async () => change(false));
  expect(tree.root.findByType(Modal).props.animationType).toBe('slide');
});
it('explains unavailable options without opening an empty picker', async () => {
  const change = jest.fn();
  const tree = await draw(<Picker label="Model" value="old" options={[]} emptyLabel="Catalog unavailable" onChange={change} />);
  const control = tree.root.findAll(n => n.props.accessibilityLabel === 'Model' && n.props.onPress)[0]!;
  expect(control.props.accessibilityState.disabled).toBe(true);
  expect(control.props.accessibilityHint).toBe('Catalog unavailable');
  expect(tree.root.findAllByType(Text).map(n => n.props.children).flat().join(' ')).toContain('Catalog unavailable');
  await renderer.act(async () => control.props.onPress());
  expect(tree.root.findByType(Modal).props.visible).toBe(false);
  expect(change).not.toHaveBeenCalled();
});
