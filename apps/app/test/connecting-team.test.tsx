import React from 'react';
import renderer from 'react-test-renderer';

import TeamScreen from '../app/(tabs)/index';
import { useAppStore } from '../src/state/store';

/**
 * What the phone says while the desktop has not answered yet.
 *
 * A phone that has just paired is linked but early: the relay is replaying the
 * frames it missed, and the desktop has not yet said what the team looks like.
 * Saying the team is not linked then would be a guess, and the wrong one most of
 * the time — the desktop is usually up, and the team is right there.
 */

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const session = {
  relayUrl: 'https://relay.example.workers.dev',
  accountId: 'default',
  deviceId: 'device-1',
  deviceToken: 'the-device-token',
  deviceName: 'Phone',
};

let mounted: renderer.ReactTestRenderer | null = null;

async function render(): Promise<string> {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<TeamScreen />);
  });
  mounted = tree;
  return JSON.stringify(tree.toJSON());
}

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (!tree) return;
  renderer.act(() => {
    tree.unmount();
  });
});

describe('a phone that has not heard from the desktop yet', () => {
  beforeEach(() => {
    useAppStore.setState({
      session,
      desktopKnown: false,
      bridgeOnline: false,
      bots: [],
      groups: [],
      diagnostics: { agentAvailable: false, teamToolsAvailable: false, toolCount: 0, partial: false },
    });
  });

  it('says it is connecting', async () => {
    const text = await render();

    expect(text).toContain('Connecting to your desktop');
    expect(text).not.toContain('The team is not linked');
  });

  it('says the desktop is offline once the relay has said so', async () => {
    useAppStore.setState({ desktopKnown: true, bridgeOnline: false });
    const text = await render();

    expect(text).toContain('Your desktop is offline');
    expect(text).not.toContain('The team is not linked');
  });
});

describe('a desktop that says the team is not there', () => {
  beforeEach(() => {
    useAppStore.setState({
      session,
      desktopKnown: true,
      bridgeOnline: true,
      bots: [],
      groups: [],
      diagnostics: {
        agentAvailable: true,
        teamToolsAvailable: false,
        toolCount: 0,
        partial: true,
        reason:
          'The @minimax-bot team is not running. Open MiniMax Bot on this desktop to link it.',
      },
    });
  });

  it('says so, and says why', async () => {
    const text = await render();

    expect(text).toContain('The team is not linked');
    expect(text).toContain('Open MiniMax Bot on this desktop');
  });
});
