import React from 'react';
import renderer from 'react-test-renderer';

import { PAIRING_CODE_TTL_MS } from '@minimax-bot/protocol';

import PairScreen from '../app/pair';

/**
 * The window the pairing screen quotes.
 *
 * The screen used to say "ninety seconds" in a sentence somebody wrote by
 * hand, and the relay moved on to five minutes without the sentence moving
 * with it: the app told the person holding a code that it was worth less than
 * it was. The number now comes from the protocol, so the sentence cannot fall
 * behind the relay — and this test is what stops that from being an accident.
 */

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), navigate: jest.fn(), back: jest.fn() }),
}));

jest.mock('../src/native/haptics', () => ({
  notifySuccess: jest.fn(),
  tapMedium: jest.fn(),
}));

jest.mock('../src/state/store', () => {
  const actual = jest.requireActual('../src/state/store');
  return { ...actual, connectRelay: jest.fn() };
});

/**
 * Every piece of text the screen renders.
 *
 * The hint is one element whose children are a string, a space, the number of
 * minutes and another string, so the text has to be collected from the
 * rendered output rather than from the props of the element that holds it.
 */
function textOf(tree: renderer.ReactTestRenderer): string {
  const collected: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string' || typeof node === 'number') {
      collected.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(tree.toJSON());
  // The pieces are joined with a space and the whitespace is collapsed, so
  // "valid for" + "5" + "minutes" reads as one sentence.
  return collected.join(' ').replace(/\s+/g, ' ');
}

describe('the pairing screen', () => {
  it('quotes the window the protocol says', async () => {
    let tree!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tree = renderer.create(<PairScreen />);
    });

    const minutes = Math.round(PAIRING_CODE_TTL_MS / 60_000);
    expect(textOf(tree)).toContain(`${minutes} minutes`);
    // And it says the window, not a number that was true when it was written.
    expect(textOf(tree)).not.toContain('ninety seconds');
  });
});
