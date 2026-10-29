import { Platform } from 'react-native';

/**
 * Local notifications.
 *
 * A turn that finishes while the app is in the background, or a permission request that
 * needs an answer, should reach the phone even when the app is not open. Push is a
 * progressive enhancement: everything still works in the foreground without it.
 *
 * The web build has no local notifications: `expo-notifications` warns on every call
 * there, so the module does nothing on that platform.
 */

type NotificationsModule = typeof import('expo-notifications');

/**
 * `expo-notifications` is optional at runtime, and its module body can throw.
 *
 * The package requires native modules at import time, and not every host ships the
 * matching native module: Expo Go for SDK 58 bundles an older `expo-notifications`
 * native module than the SDK's JavaScript package expects, so a plain import throws
 * `Cannot find native module 'ExpoTopicSubscriptionModule'` before a single line of
 * app code runs. That is a launch crash, not a degraded feature.
 *
 * The import is therefore guarded. If the native side is missing or out of step, the
 * app runs without notifications instead of not running at all.
 */
function loadNotifications(): NotificationsModule | null {
  try {
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

const notifications = loadNotifications();

let configured = false;

function supported(): boolean {
  return Platform.OS !== 'web' && notifications !== null;
}

export function configureNotifications(): void {
  if (configured || !supported()) return;
  configured = true;

  notifications?.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!supported()) return false;
  try {
    const current = await notifications!.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const asked = await notifications!.requestPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}

/**
 * The body of every notification.
 *
 * A notification's content is shown on the lock screen, to anyone who can see the
 * phone, and the text of a message from the team can be work detail the owner
 * would not put there. So the body says what happened and not what was said: the
 * title still names the chat, so the notification is worth acting on, and the
 * message itself is read in the app.
 */
const NOTIFICATION_BODY = 'New message';

/**
 * Schedules a notification.
 *
 * There is no body parameter, and there is not going to be one: the only way to
 * keep the text of a conversation off the lock screen is for the text never to
 * reach the notification in the first place.
 */
export async function notify(title: string): Promise<void> {
  if (!supported()) return;
  try {
    await notifications!.scheduleNotificationAsync({
      content: { title, body: NOTIFICATION_BODY },
      trigger: null,
    });
  } catch {
    /* notifications are best effort */
  }
}
