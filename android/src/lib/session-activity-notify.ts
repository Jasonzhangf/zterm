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
 *
 * De-dup rules (per session):
 * - A stopped notification is shown at most once.
 * - It is re-armed ONLY when the session shows real resumed activity, i.e.
 *   `lastLiveActivityAt` advances past the timestamp seen when the
 *   notification was shown. Merely toggling `stopped` back and forth (idle
 *   edge jitter from the daemon) must never re-notify.
 */
export interface SessionActivityNotifier {
  handleActivity: (activity: SessionActivity) => void;
  /** Clear all tracked state (e.g. on provider dispose). */
  dispose: () => void;
}

interface SessionNotifyState {
  /** Whether the stopped notification has been shown for the current idle run. */
  notified: boolean;
  /** lastLiveActivityAt seen when the notification was shown (0 = not notified). */
  notifiedAtActivity: number;
  /** Highest lastLiveActivityAt observed so far. */
  lastSeenActivityAt: number;
}

export function createSessionActivityNotifier(): SessionActivityNotifier {
  // sessionName -> per-session notification state
  const state = new Map<string, SessionNotifyState>();

  return {
    handleActivity(activity) {
      if (!activity || !activity.name) {
        return;
      }
      const current = state.get(activity.name) ?? {
        notified: false,
        notifiedAtActivity: 0,
        lastSeenActivityAt: 0,
      };
      const lastLiveActivityAt = Math.max(0, activity.lastLiveActivityAt || 0);

      if (activity.stopped) {
        if (!current.notified) {
          state.set(activity.name, {
            notified: true,
            notifiedAtActivity: lastLiveActivityAt,
            lastSeenActivityAt: Math.max(current.lastSeenActivityAt, lastLiveActivityAt),
          });
          void scheduleNotification({
            title: '⏹ 会话已停止',
            body: `tmux 会话 ${activity.name} 已停止输出（可能任务结束或卡住）`,
            extra: { kind: 'session-stopped', sessionName: activity.name },
          });
        } else {
          // Already notified for this idle run — stay silent even if the
          // daemon keeps publishing stopped facts (no recovery update yet).
          state.set(activity.name, {
            ...current,
            lastSeenActivityAt: Math.max(current.lastSeenActivityAt, lastLiveActivityAt),
          });
        }
        return;
      }

      // Not stopped. Re-arm only when there is REAL new activity after the
      // notification point; a plain !stopped fact without advancing
      // lastLiveActivityAt (idle-edge jitter) must not reset the de-dup.
      const hasRealResume =
        lastLiveActivityAt > 0
        && current.notified
        && lastLiveActivityAt > current.notifiedAtActivity;
      if (hasRealResume || (!current.notified && lastLiveActivityAt > current.lastSeenActivityAt)) {
        state.set(activity.name, {
          notified: false,
          notifiedAtActivity: 0,
          lastSeenActivityAt: lastLiveActivityAt,
        });
      } else {
        state.set(activity.name, {
          ...current,
          lastSeenActivityAt: Math.max(current.lastSeenActivityAt, lastLiveActivityAt),
        });
      }
    },
    dispose() {
      state.clear();
    },
  };
}
