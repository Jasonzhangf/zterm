import type { SessionActivity } from '@zterm/shared/protocol';
import { scheduleNotification } from './notification-helper';

/**
 * Session idle/stopped notification runtime (client side).
 *
 * Consumes `session-activity` facts published by the daemon and surfaces a
 * one-shot notification when a tmux session transitions into the "stopped"
 * state (no live screen activity for SESSION_IDLE_STOPPED_THRESHOLD_MS).
 * Daemon only publishes facts; this module owns client-side presentation and
 * de-dup.
 */
export interface SessionActivityNotifier {
  handleActivity: (activity: SessionActivity) => void;
  /** Clear all tracked state (e.g. on provider dispose). */
  dispose: () => void;
}

export function createSessionActivityNotifier(): SessionActivityNotifier {
  // sessionName -> has the "stopped" notification been shown already
  const notifiedStopped = new Map<string, boolean>();

  return {
    handleActivity(activity) {
      if (!activity || !activity.name) {
        return;
      }
      const wasNotified = notifiedStopped.get(activity.name) ?? false;
      if (activity.stopped && !wasNotified) {
        notifiedStopped.set(activity.name, true);
        void scheduleNotification({
          title: '⏹ 会话已停止',
          body: `tmux 会话 ${activity.name} 已停止输出（可能任务结束或卡住）`,
        });
      } else if (!activity.stopped) {
        // Activity resumed — allow a future stopped notification again.
        notifiedStopped.set(activity.name, false);
      }
    },
    dispose() {
      notifiedStopped.clear();
    },
  };
}
