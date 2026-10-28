import * as Haptics from 'expo-haptics';

/**
 * Haptics.
 *
 * Haptics are the cheapest way to make an app feel native on iOS and Android, so they
 * are used for the moments a finger expects feedback: sending a message, a reply
 * arriving, a permission prompt, and a destructive action.
 */

export function tapLight(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function tapMedium(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}

export function tapHeavy(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
}

export function notifySuccess(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

export function notifyWarning(): void {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
}

export function selection(): void {
  void Haptics.selectionAsync().catch(() => {});
}
