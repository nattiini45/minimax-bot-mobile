import assert from 'node:assert/strict';
import React from 'react';
import renderer from 'react-test-renderer';

import { GROUP_LAYOUTS, GroupMark, groupMembers } from '../src/components/GroupMark';
import { useAppStore } from '../src/state/store';
import type { AppBot, AppGroup } from '../src/state/store';

/**
 * The pile that is a group's picture.
 *
 * The desktop shows a group as up to three of its members stacked into one picture,
 * the admin in front. The phone draws the same pile, so a group looks like itself on
 * both screens — and the phone's own icon is the same pile.
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

/** The pieces of the pile: the boxes the members are placed in. */
function pieces(tree: renderer.ReactTestRenderer) {
  // Only the host nodes: a composite one carries the same props as the host it
  // renders, and would be counted twice.
  return tree.root.findAll((node) => node.props?.style?.zIndex !== undefined, { deep: false });
}

const CHIEF: AppBot = { botId: 'bot_chief', name: 'Chief', skin: 'fuzzy' };
const ENGINEER: AppBot = { botId: 'bot_engineer', name: 'Engineer', skin: 'pixel' };
const REVIEWER: AppBot = { botId: 'bot_reviewer', name: 'Reviewer', skin: 'jade' };
const WRITER: AppBot = { botId: 'bot_writer', name: 'Writer', skin: 'glass' };

const STUDIO: AppGroup = {
  groupId: 'grp_studio',
  name: 'Studio',
  admin: 'bot_chief',
  memberIds: ['bot_chief', 'bot_engineer', 'bot_reviewer', 'bot_writer'],
};

test('the layout is the desktop’s own', () => {
  // Copied from the desktop's `octopus.js` (`groupMark`): a picture that is nearly
  // the same is not the same.
  assert.deepEqual(GROUP_LAYOUTS[1], [[0.08, 0.08, 0.84]]);
  assert.deepEqual(GROUP_LAYOUTS[2], [
    [0, 0, 0.66],
    [0.36, 0.34, 0.64],
  ]);
  assert.deepEqual(GROUP_LAYOUTS[3], [
    [0.2, 0, 0.6],
    [0, 0.44, 0.54],
    [0.46, 0.44, 0.54],
  ]);
});

test('the admin leads the pile, and is not in it twice', () => {
  const members = groupMembers(STUDIO, [CHIEF, ENGINEER, REVIEWER, WRITER]);
  assert.deepEqual(
    members.map((bot) => bot.botId),
    ['bot_chief', 'bot_engineer', 'bot_reviewer', 'bot_writer'],
  );
});

test('a group without an admin keeps the order the group lists', () => {
  const members = groupMembers({ ...STUDIO, admin: undefined }, [CHIEF, ENGINEER]);
  assert.deepEqual(
    members.map((bot) => bot.botId),
    ['bot_chief', 'bot_engineer'],
  );
});

test('a member the roster does not know is left out', () => {
  const members = groupMembers(STUDIO, [CHIEF]);
  assert.deepEqual(
    members.map((bot) => bot.botId),
    ['bot_chief'],
  );
});

test('the pile holds three members, laid out as the desktop lays them out', async () => {
  const tree = await render(
    <GroupMark
      size={40}
      members={[
        { botId: 'bot_chief', name: 'Chief' },
        { botId: 'bot_engineer', name: 'Engineer' },
        { botId: 'bot_reviewer', name: 'Reviewer' },
        { botId: 'bot_writer', name: 'Writer' },
      ]}
    />,
  );

  const boxes = pieces(tree);
  assert.equal(boxes.length, 3, 'a pile shows three members, however many the group has');

  // The first member sits on top in the middle, the other two below it.
  assert.equal(boxes[0].props.style.left, 8);
  assert.equal(boxes[0].props.style.top, 0);
  assert.equal(boxes[0].props.style.width, 24);
  assert.equal(boxes[0].props.style.zIndex, 3, 'the first member is in front');

  assert.equal(boxes[1].props.style.left, 0);
  assert.equal(boxes[1].props.style.top, 40 * 0.44);
  assert.equal(boxes[1].props.style.width, 40 * 0.54);
  assert.equal(boxes[1].props.style.zIndex, 2);
});

test('a pile of two members is laid out as the desktop lays it out', async () => {
  const tree = await render(
    <GroupMark
      size={36}
      members={[
        { botId: 'bot_chief', name: 'Chief' },
        { botId: 'bot_engineer', name: 'Engineer' },
      ]}
    />,
  );

  const boxes = pieces(tree);
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0].props.style.width, 36 * 0.66);
  assert.equal(boxes[1].props.style.left, 36 * 0.36);
  assert.equal(boxes[1].props.style.top, 36 * 0.34);
});

test('the members are drawn whole, with a halo in the ground’s colour', async () => {
  const tree = await render(
    <GroupMark
      size={40}
      haloColor="#ffffff"
      members={[{ botId: 'bot_chief', name: 'Chief', picture: 'data:image/png;base64,AAAA' }]}
    />,
  );

  const images = tree.root.findAll((node) => node.props?.source?.uri !== undefined, { deep: false });
  assert.ok(images.length >= 2, 'the picture is drawn twice: the halo and the picture');
  // The desktop draws the artwork whole — `object-fit: contain` — and separates the
  // pieces with a soft edge in the colour of the ground they sit on.
  assert.ok(
    images.every((image) => image.props.resizeMode === 'contain'),
    'the artwork is not cropped',
  );
  assert.ok(
    images.some((image) => image.props.tintColor === '#ffffff'),
    'the halo takes the colour of the ground',
  );
});

test('a group with no members has a picture of its own', async () => {
  const tree = await render(<GroupMark size={40} members={[]} />);
  assert.equal(pieces(tree).length, 0);
  assert.ok(tree.toJSON(), 'something is drawn');
});

test('the pictures the desktop sent for the members are the ones shown', async () => {
  renderer.act(() => {
    useAppStore.setState({ pictures: { bot_chief: 'data:image/png;base64,CHIEF' } });
  });

  const tree = await render(
    <GroupMark size={40} members={[{ botId: 'bot_chief', name: 'Chief' }]} />,
  );

  const text = JSON.stringify(tree.toJSON());
  assert.ok(text.includes('CHIEF'), "the desktop's own picture is shown");

  renderer.act(() => {
    useAppStore.setState({ pictures: {} });
  });
});
