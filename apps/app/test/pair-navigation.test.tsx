import React from 'react';
import renderer from 'react-test-renderer';

import PairScreen from '../app/pair';

/**
 * Where a phone goes once it has paired.
 *
 * The pairing screen used to call `router.back()`, which only works when there is a
 * screen behind the pairing screen. A phone that opens the pairing link directly -
 * which is what a stranger following a link does - has no such screen: it pairs
 * successfully and then stays on a pairing screen that is already finished. The
 * phone has to go to the team itself.
 */

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
  navigate: jest.fn(),
  back: jest.fn(),
};

/** The relay the phone knows, and the one the test pairs with. */
const RELAY_URL = 'https://relay.example.workers.dev';

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('../src/net/pairing', () => ({
  pairWithCode: jest.fn(async () => ({
    ok: true,
    deviceToken: 'device-token',
    expiresAt: 1796042721344,
  })),
}));

jest.mock('../src/native/haptics', () => ({
  notifySuccess: jest.fn(),
  tapMedium: jest.fn(),
}));

jest.mock('../src/state/credential-store', () => {
  const actual = jest.requireActual('../src/state/credential-store');
  // The relay this phone already knows. A code only goes to an address the phone
  // knows without being acknowledged, so the test pairs with a known relay.
  return { ...actual, loadLastRelayUrl: jest.fn(async () => RELAY_URL) };
});

jest.mock('../src/state/store', () => {
  const actual = jest.requireActual('../src/state/store');
  return { ...actual, connectRelay: jest.fn() };
});

/** Finds a node by the accessibility label it carries. */
function byLabel(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.onChangeText !== 'undefined',
    { deep: true },
  )[0];
}

/** The pressable that carries the given label. */
function pressable(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.findAll(
    (node) => node.props?.accessibilityLabel === label && typeof node.props?.onPress === 'function',
    { deep: true },
  )[0];
}

describe('a phone that has paired', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('goes to the team, not back to wherever it came from', async () => {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<PairScreen />);
    });

    await renderer.act(async () => {
      byLabel(tree, 'Relay URL').props.onChangeText(RELAY_URL);
    });
    await renderer.act(async () => {
      byLabel(tree, 'Pairing code').props.onChangeText('123456');
    });
    await renderer.act(async () => {
      pressable(tree, 'Pair').props.onPress();
    });

    // The team is where the phone belongs after pairing, and it has to be there
    // whether or not there was a screen behind the pairing screen.
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    expect(mockRouter.back).not.toHaveBeenCalled();
  });
});
