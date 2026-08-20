import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionActivity } from '@zterm/shared/protocol';

const { scheduleNotification } = vi.hoisted(() => ({
  scheduleNotification: vi.fn(async () => undefined),
}));

vi.mock('./notification-helper', () => ({
  scheduleNotification,
}));

import { createSessionActivityNotifier } from './session-activity-notify';

function activity(name: string, stopped: boolean, lastLiveActivityAt?: number): SessionActivity {
  return {
    name,
    lastLiveActivityAt: lastLiveActivityAt ?? (stopped ? 0 : Date.now()),
    stopped,
  };
}

describe('createSessionActivityNotifier', () => {
  beforeEach(() => {
    scheduleNotification.mockClear();
  });

  it('pulses the matching connected session notification action once', () => {
    const pulseTarget = vi.fn();
    const notifier = createSessionActivityNotifier({
      resolveTarget: (sessionName) => sessionName === 'demo'
        ? { targetKey: 'daemon:one', channelId: 'channel-demo' }
        : null,
      pulseTarget,
    });

    notifier.handleActivity(activity('demo', true, 5_000));
    notifier.handleActivity(activity('demo', true, 5_000));

    expect(pulseTarget).toHaveBeenCalledTimes(1);
    expect(pulseTarget).toHaveBeenCalledWith({
      targetKey: 'daemon:one',
      channelId: 'channel-demo',
    });
  });

  it('notifies once when a session transitions into stopped', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('demo', true));
    expect(scheduleNotification).toHaveBeenCalledTimes(1);
    expect(scheduleNotification).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('demo'),
    }));

    // Repeated stopped facts must not re-notify.
    notifier.handleActivity(activity('demo', true));
    notifier.handleActivity(activity('demo', true));
    expect(scheduleNotification).toHaveBeenCalledTimes(1);
  });

  it('does not re-notify on idle-edge jitter without real resumed activity', () => {
    const notifier = createSessionActivityNotifier();
    const stoppedAt = 5_000;
    notifier.handleActivity(activity('demo', true, stoppedAt));
    expect(scheduleNotification).toHaveBeenCalledTimes(1);

    // Daemon briefly reports !stopped, but lastLiveActivityAt did NOT advance
    // past the notification point (idle-edge jitter).
    notifier.handleActivity(activity('demo', false, stoppedAt));
    notifier.handleActivity(activity('demo', false, stoppedAt - 1));
    // Back to stopped — must stay silent: the session never really resumed.
    notifier.handleActivity(activity('demo', true, stoppedAt));
    expect(scheduleNotification).toHaveBeenCalledTimes(1);
  });

  it('re-arms only after the session resumes with real new activity', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('demo', true, 5_000));
    expect(scheduleNotification).toHaveBeenCalledTimes(1);

    // Real resumed output: lastLiveActivityAt advances past the notification point.
    notifier.handleActivity(activity('demo', false, 6_000));
    notifier.handleActivity(activity('demo', true, 6_000));
    expect(scheduleNotification).toHaveBeenCalledTimes(2);
  });

  it('keeps reporting resumed activity updates without spamming while active', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('demo', false, 1_000));
    notifier.handleActivity(activity('demo', false, 2_000));
    notifier.handleActivity(activity('demo', false, 3_000));
    expect(scheduleNotification).not.toHaveBeenCalled();
  });

  it('tracks sessions independently', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('demo', true, 1_000));
    notifier.handleActivity(activity('other', true, 2_000));
    expect(scheduleNotification).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown/empty activities', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('', true));
    notifier.handleActivity({} as SessionActivity);
    expect(scheduleNotification).not.toHaveBeenCalled();
  });
});
