import React from 'react';
import renderer from 'react-test-renderer';

import { Avatar, resolveSkin } from '../src/components/Avatar';
import { useAppStore } from '../src/state/store';

/**
 * The faces of the team.
 *
 * A Bot's look has to survive three things: the roster not naming one, the phone
 * being rebuilt, and a Bot carrying a picture the phone cannot load. The first two
 * are about stability — the same Bot is the same octopus everywhere — and the third
 * is about the fallback: a picture that cannot be shown must not become a broken
 * frame.
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

function draw(element: React.ReactElement): Promise<string> {
  return render(element).then((tree) => JSON.stringify(tree.toJSON()));
}

/** A store change that re-renders what is on screen. */
function act(body: () => void): void {
  renderer.act(body);
}

describe('the look a Bot is drawn with', () => {
  it('is the look the roster names', () => {
    expect(resolveSkin({ skin: 'moon' })).toBe(resolveSkin({ skin: 'moon' }));
    expect(resolveSkin({ skin: 'moon' }).body).not.toBe(resolveSkin({ skin: 'fuzzy' }).body);
  });

  it('is the legacy colour when only a colour is named', () => {
    expect(resolveSkin({ color: 'ocean' }).body).toBe(resolveSkin({ skin: 'ocean' }).body);
  });

  it('does not change when the roster names none', () => {
    // The same Bot is the same octopus on every screen and after every restart.
    const first = resolveSkin({ seed: 'bot_abc123' });
    const second = resolveSkin({ seed: 'bot_abc123' });
    expect(first).toBe(second);
  });

  it('gives two Bots their own faces', () => {
    const a = resolveSkin({ seed: 'bot_abc123' });
    const b = resolveSkin({ seed: 'bot_xyz789' });
    expect(a).not.toBe(b);
  });
});

describe('a Bot with a picture of its own', () => {
  it('shows the picture', async () => {
    const text = await draw(<Avatar name="Chief" avatar="https://cdn.example.com/chief.png" size={40} />);
    expect(text).toContain('https://cdn.example.com/chief.png');
  });

  it('falls back to the octopus when the picture is a path on the desktop', async () => {
    // The phone cannot read the desktop's disk, so a path must not become a frame
    // that never loads.
    const text = await draw(<Avatar name="Chief" avatar="/Users/someone/chief.png" size={40} />);
    expect(text).not.toContain('/Users/someone/chief.png');
    expect(text).toContain('Chief avatar');
  });

  it('draws the octopus when there is no picture', async () => {
    const text = await draw(<Avatar name="Chief" botId="bot_abc123" size={40} />);
    expect(text).not.toContain('"Image"');
    expect(text).toContain('Chief avatar');
  });
});

describe('the picture the desktop sent', () => {
  afterEach(() => {
    act(() => {
      useAppStore.setState({ pictures: {} });
    });
  });

  it('shows the picture the desktop sent for that Bot', async () => {
    // The artwork is not in the app: the desktop keeps it and sends it, and the phone
    // shows what it sent.
    act(() => {
      useAppStore.setState({ pictures: { bot_abc123: 'data:image/png;base64,AAAA' } });
    });
    const text = await draw(<Avatar name="Chief" botId="bot_abc123" size={40} />);
    expect(text).toContain('data:image/png;base64,AAAA');
  });

  it('does not show one Bot picture on another Bot', async () => {
    act(() => {
      useAppStore.setState({ pictures: { bot_other: 'data:image/png;base64,AAAA' } });
    });
    const text = await draw(<Avatar name="Chief" botId="bot_abc123" size={40} />);
    expect(text).not.toContain('data:image/png;base64,AAAA');
    expect(text).toContain('Chief avatar');
  });

  it('draws the octopus while the picture is on its way', async () => {
    const text = await draw(<Avatar name="Chief" botId="bot_abc123" size={40} />);
    expect(text).not.toContain('"Image"');
  });
});
