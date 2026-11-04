import React from 'react';
import renderer from 'react-test-renderer';

import { Bubble } from '../src/components/Bubble';

/**
 * A message that was written on the desktop.
 *
 * The desktop marks the messages that arrive from the phone, so that a user can tell
 * which side of the conversation they are looking at. The phone marks the ones that
 * were written on the desktop the same way, because from the phone a message typed
 * there would otherwise be indistinguishable from one the phone sent.
 */

let mounted: renderer.ReactTestRenderer | null = null;

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (!tree) return;
  renderer.act(() => {
    tree.unmount();
  });
});

async function draw(element: React.ReactElement): Promise<string> {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(element);
  });
  mounted = tree;
  return JSON.stringify(tree.toJSON());
}

test('a message written on the desktop says where it came from', async () => {
  const text = await draw(<Bubble role="user" text="Typed on the desktop" origin="desktop" />);

  expect(text).toContain('From your desktop');
});

test('the phone’s own message says nothing about where it came from', async () => {
  const text = await draw(<Bubble role="user" text="Sent from the phone" />);

  expect(text).not.toContain('From your desktop');
});
