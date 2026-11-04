import React from 'react';
import renderer from 'react-test-renderer';

import TasksScreen from '../app/(tabs)/tasks';
import { useAppStore } from '../src/state/store';

/**
 * A task that is waiting for the user.
 *
 * The team's states are made for the desktop's own screens. `waiting_for_user` says
 * what happened, but a phone that only says that leaves the reader to work out what
 * to do about it — and the answer is not on this screen.
 */

let mounted: renderer.ReactTestRenderer | null = null;

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (!tree) return;
  renderer.act(() => {
    tree.unmount();
  });
  useAppStore.setState({ tasks: [], helpers: [] });
});

async function draw(): Promise<string> {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<TasksScreen />);
  });
  mounted = tree;
  return JSON.stringify(tree.toJSON());
}

test('a task waiting for the user says where the answer goes', async () => {
  useAppStore.setState({
    tasks: [
      {
        taskId: 'task_1',
        state: 'waiting_for_user',
        title: 'phone-proof-2026',
        updatedAt: 1,
      },
    ],
  });

  const text = await draw();

  expect(text).toContain('waiting for you');
  expect(text).toContain('Open MiniMax Bot on the desktop');
});

test('a task that is only running says nothing about answering', async () => {
  useAppStore.setState({
    tasks: [{ taskId: 'task_2', state: 'running', title: 'Build the release', updatedAt: 1 }],
  });

  const text = await draw();

  expect(text).toContain('running');
  expect(text).not.toContain('Open MiniMax Bot on the desktop');
});
