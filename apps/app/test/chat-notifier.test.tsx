import React from 'react';
import renderer from 'react-test-renderer';

let mockPathname = '/chats';

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
}));

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: false })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

import { AppState } from 'react-native';
import { scheduleNotificationAsync } from 'expo-notifications';

import { ChatNotifier } from '../src/components/ChatNotifier';
import { useAppStore } from '../src/state/store';

/**
 * The notifications the phone sends itself.
 *
 * A notification is for a message the user has not seen: one the team wrote, one that
 * arrived while the app was in the background, in a conversation that is not the one on
 * screen. Everything else is noise, and noise that repeats itself is the kind of thing
 * a person turns off — and then they miss the messages that matter.
 */

let mounted: renderer.ReactTestRenderer | null = null;

async function render(): Promise<renderer.ReactTestRenderer> {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<ChatNotifier />);
  });
  mounted = tree;
  return tree;
}

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) {
    renderer.act(() => {
      tree.unmount();
    });
  }
  (scheduleNotificationAsync as jest.Mock).mockClear();
  useAppStore.setState({ messages: {}, bots: [], groups: [] });
  mockPathname = '/chats';
});

/** Puts the app in the background, which is when a notification is due. */
function background(): void {
  Object.defineProperty(AppState, 'currentState', { get: () => 'background', configurable: true });
}

function foreground(): void {
  Object.defineProperty(AppState, 'currentState', { get: () => 'active', configurable: true });
}

const BOTS = [{ botId: 'bot_b1', name: 'Chief', role: 'Leads', skin: 'octopus', color: '#f00', isMain: true }];

function message(chatId: string, messageId: string, role: 'user' | 'assistant') {
  return { messageId, chatId, role, text: 'hi', ts: 1 };
}

describe('a notification', () => {
  beforeEach(() => {
    background();
    useAppStore.setState({ bots: BOTS });
  });

  it('is not sent for a thread the phone is reading for the first time', async () => {
    useAppStore.setState({ messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant')] } });

    await render();

    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('is sent when the team writes while the phone is in the background', async () => {
    useAppStore.setState({ messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant')] } });
    const tree = await render();

    await renderer.act(async () => {
      useAppStore.setState({
        messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant'), message('bot:bot_b1', 'm2', 'assistant')] },
      });
    });

    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    expect(scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ title: 'Chief', data: { chatId: 'bot:bot_b1' } }),
      }),
    );
    expect(tree).toBeTruthy();
  });

  it('is not sent for the phone’s own message', async () => {
    useAppStore.setState({ messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant')] } });
    await render();

    await renderer.act(async () => {
      useAppStore.setState({
        messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant'), message('bot:bot_b1', 'm2', 'user')] },
      });
    });

    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('is not sent while the app is open', async () => {
    useAppStore.setState({ messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant')] } });
    // The app is open when the thread is read, and it stays open.
    foreground();
    await render();

    await renderer.act(async () => {
      useAppStore.setState({
        messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant'), message('bot:bot_b1', 'm2', 'assistant')] },
      });
    });

    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('is not sent for the conversation on screen', async () => {
    useAppStore.setState({ messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant')] } });
    await render();
    mockPathname = `/chat/${encodeURIComponent('bot:bot_b1')}`;

    await renderer.act(async () => {
      useAppStore.setState({
        messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant'), message('bot:bot_b1', 'm2', 'assistant')] },
      });
    });

    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('is sent once for the same message', async () => {
    useAppStore.setState({ messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant')] } });
    await render();

    await renderer.act(async () => {
      useAppStore.setState({
        messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant'), message('bot:bot_b1', 'm2', 'assistant')] },
      });
    });
    await renderer.act(async () => {
      useAppStore.setState({
        messages: { 'bot:bot_b1': [message('bot:bot_b1', 'm1', 'assistant'), message('bot:bot_b1', 'm2', 'assistant')] },
      });
    });

    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});
