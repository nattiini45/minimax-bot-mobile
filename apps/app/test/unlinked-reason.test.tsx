import React from 'react';
import renderer from 'react-test-renderer';

import TeamScreen from '../app/(tabs)/index';
import { useAppStore } from '../src/state/store';

/**
 * What the phone says when it has lost its link.
 *
 * A phone that was unpaired on the desktop is bounced to the pairing screen. The
 * reason it lost the link is the one thing the user needs to know, so it is shown
 * rather than only recorded.
 */

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

describe('a phone with no desktop linked', () => {
  beforeEach(() => {
    useAppStore.setState({ session: null, lastError: null, bots: [], groups: [] });
  });

  it('says why it lost the link', async () => {
    useAppStore.getState().setError('The relay no longer knows this phone — it may have restarted. Pair it again.');

    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<TeamScreen />);
    });
    const text = JSON.stringify(tree.toJSON());

    expect(text).toContain('Pair it again');
    expect(text).toContain('No desktop linked yet');
  });

  it('does not invent a reason when there is none', async () => {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<TeamScreen />);
    });
    const text = JSON.stringify(tree.toJSON());

    expect(text).toContain('No desktop linked yet');
    expect(text).not.toContain('Pair it again');
  });
});
