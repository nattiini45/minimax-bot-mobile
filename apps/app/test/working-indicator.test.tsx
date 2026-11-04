import React from 'react';
import renderer from 'react-test-renderer';

import { WorkingIndicator } from '../src/components/WorkingIndicator';

/**
 * The line that says the team is working.
 *
 * A turn the desktop's own engine runs reports its work only when it ends, and it can
 * take many minutes. The phone must still say that the Bot is working: a silent phone
 * looks like a broken one.
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

test('a running turn says what is being worked on', async () => {
  const text = await draw(
    <WorkingIndicator activeTurn="turn-1" actorName="Chief" workingOn="Note-check" />,
  );

  expect(text).toContain('is working');
  expect(text).toContain('Chief');
  expect(text).toContain('Note-check');
});

test('a turn without a message to name still says that work is going on', async () => {
  const text = await draw(<WorkingIndicator activeTurn="turn-1" actorName="Chief" />);

  expect(text).toContain('is working');
  expect(text).toContain('Chief');
});

test('an idle chat shows nothing at all', async () => {
  const text = await draw(<WorkingIndicator actorName="Chief" />);

  expect(text).toBe('null');
});

test('the line says how long the work has been going on', async () => {
  const text = await draw(
    <WorkingIndicator
      activeTurn="turn-1"
      actorName="Chief"
      startedAt={Date.now() - 192_000}
    />,
  );

  // The clock runs, so the exact second is not fixed: the minutes are.
  expect(text).toMatch(/3m \d\ds/);
});

test('the line animates, so that the phone is not silent while the work goes on', async () => {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<WorkingIndicator activeTurn="turn-1" actorName="Chief" />);
  });
  mounted = tree;

  // The pulse is an animated value, so it is there to be driven: the line breathes
  // rather than sitting still.
  const animated = tree.root.findAllByType(require('react-native').Animated.View);
  expect(animated.length).toBeGreaterThan(0);
  expect(animated[0].props.style).toBeDefined();
});
