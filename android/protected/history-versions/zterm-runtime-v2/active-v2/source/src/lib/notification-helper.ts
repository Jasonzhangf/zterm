import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

/**
 * Shared notification permission helper (Android 13+ runtime permission).
 * No-op on non-Android platforms and when permission is already granted.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') {
      return true;
    }
    const status = await LocalNotifications.checkPermissions();
    if (status.display === 'granted') {
      return true;
    }
    const requested = await LocalNotifications.requestPermissions();
    return requested.display === 'granted';
  } catch (err) {
    console.warn('[notifications] permission request failed:', err);
    return false;
  }
}

/**
 * Schedule a notification if permission allows; failures are logged, never thrown.
 */
let notificationSequence = 0;

/** 返回自增的 Java int 通知 id（Android LocalNotifications 拒绝超出 int 范围的值） */
export function nextNotificationId(): number {
  return ++notificationSequence;
}

export async function scheduleNotification(options: {
  title: string;
  body: string;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    const granted = await ensureNotificationPermission();
    if (!granted) {
      return;
    }
    await LocalNotifications.schedule({
      notifications: [{
        title: options.title,
        body: options.body,
        id: nextNotificationId(),
        ...(options.extra ? { extra: options.extra } : {}),
      }],
    });
  } catch (err) {
    console.warn('[notifications] schedule failed:', err);
  }
}
