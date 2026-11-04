import assert from 'node:assert/strict';
import React from 'react';
import renderer from 'react-test-renderer';

import { Picker, type PickerOption } from '../src/components/Picker';

/**
 * The choices a setting is made of.
 *
 * A model, a reasoning effort: the desktop decides what the choices are, and the phone
 * offers them. A free text field would let the user type a model the Host does not have
 * or an effort the model does not have, and the desktop would then refuse the change.
 */

let mounted: renderer.ReactTestRenderer | null = null;

async function render(element: React.ReactElement): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(element);
  });
  mounted = tree;
  return tree;
}

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (!tree) return;
  renderer.act(() => {
    tree.unmount();
  });
});

/** The control that carries a label. */
function control(tree: renderer.ReactTestRenderer, label: string) {
  const found = tree.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
  );
  return found[0];
}

const OPTIONS: PickerOption[] = [
  { value: 'default', label: 'Default (MiniMax M2.7)', description: 'minimax/MiniMax-M2.7' },
  { value: 'minimax/MiniMax-M3.1', label: 'MiniMax M3.1' },
];

test('the picker shows the choice that is in force', async () => {
  const tree = await render(
    <Picker label="Model" value="minimax/MiniMax-M3.1" options={OPTIONS} onChange={() => {}} />,
  );

  const shown = tree.root.findAll(
    (node) => typeof node.props?.children === 'string' && node.props.children === 'MiniMax M3.1',
  );
  assert.ok(shown.length > 0, 'the chosen model is on screen');
});

test('the choices are only listed once the picker is opened', async () => {
  const tree = await render(
    <Picker label="Model" value="default" options={OPTIONS} onChange={() => {}} />,
  );

  assert.equal(control(tree, 'MiniMax M3.1'), undefined);

  await renderer.act(async () => {
    control(tree, 'Model')?.props.onPress();
  });

  assert.ok(control(tree, 'MiniMax M3.1'), 'the list is open');
  assert.ok(control(tree, 'Default (MiniMax M2.7)'), 'every choice is listed');
});

test('choosing a choice reports it and closes the list', async () => {
  const chosen: string[] = [];
  const tree = await render(
    <Picker
      label="Model"
      value="default"
      options={OPTIONS}
      onChange={(value) => chosen.push(value)}
    />,
  );

  await renderer.act(async () => {
    control(tree, 'Model')?.props.onPress();
  });
  await renderer.act(async () => {
    control(tree, 'MiniMax M3.1')?.props.onPress();
  });

  assert.deepEqual(chosen, ['minimax/MiniMax-M3.1']);
  assert.equal(control(tree, 'MiniMax M3.1'), undefined, 'the list is closed again');
});

test('a choice the desktop does not offer any more is kept, and marked', async () => {
  const options: PickerOption[] = [
    ...OPTIONS,
    { value: 'someone/else', label: 'someone/else', flagged: true },
  ];
  const tree = await render(
    <Picker label="Model" value="someone/else" options={options} onChange={() => {}} />,
  );

  await renderer.act(async () => {
    control(tree, 'Model')?.props.onPress();
  });

  const warning = tree.root.findAll(
    (node) =>
      typeof node.props?.children === 'string' &&
      node.props.children.includes('does not offer this any more'),
  );
  assert.ok(warning.length > 0, 'the choice is marked as one the desktop dropped');
});

test('a setting the desktop cannot offer says so, instead of showing nothing', async () => {
  const tree = await render(
    <Picker
      label="Model"
      value="default"
      options={[]}
      onChange={() => {}}
      emptyLabel="The desktop does not let a Bot pick its model"
    />,
  );

  const shown = tree.root.findAll(
    (node) =>
      typeof node.props?.children === 'string' &&
      node.props.children === 'The desktop does not let a Bot pick its model',
  );
  assert.ok(shown.length > 0);
});
