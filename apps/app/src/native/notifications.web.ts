/** Web intentionally has no local notifications. Do not import the native SDK here:
 * its module body registers a push listener even when every caller is platform-guarded.
 */
export function configureNotifications(): void {}
export async function requestNotificationPermission(): Promise<boolean> { return false; }
export async function notify(_title: string, _chatId?: string): Promise<void> {}
export function onNotificationOpened(_handler: (chatId: string | undefined) => void): () => void {
  return () => {};
}
