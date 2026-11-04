/**
 * The notification's content is shown on the lock screen.
 *
 * Anyone who can see the phone can read it, so it must not carry the text of a
 * message from the team. The title says which chat it is; the body says that
 * there is a new message and nothing more. The conversation travels with it, so that
 * opening the notification opens the conversation it is about — an id, never a text.
 */

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: false })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
}));

import { scheduleNotificationAsync } from 'expo-notifications';

import { notify } from '../src/native/notifications';

describe('a notification', () => {
  beforeEach(() => {
    (scheduleNotificationAsync as jest.Mock).mockClear();
  });

  it('does not carry the text of the message', async () => {
    await notify('Chief');

    expect(scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { title: 'Chief', body: 'New message' },
      }),
    );
  });

  it('names the conversation it is about, so opening it opens that conversation', async () => {
    await notify('Chief', 'bot:bot_b1');

    expect(scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: { title: 'Chief', body: 'New message', data: { chatId: 'bot:bot_b1' } },
      }),
    );
  });

  it('has no way to carry it', async () => {
    // The helper takes a title and the id of a conversation. There is no body to fill
    // with the text of a conversation, so a caller cannot put one there by accident.
    expect(notify.length).toBe(2);
  });
});
