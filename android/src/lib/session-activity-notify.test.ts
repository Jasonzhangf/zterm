import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SessionActivity } from '@zterm/shared/protocol';

const { scheduleNotification } = vi.hoisted(() => ({
  scheduleNotification: vi.fn(async () => undefined),
}));

vi.mock('./notification-helper', () => ({
  scheduleNotification,
}));

import { createSessionActivityNotifier } from './session-activity-notify';

function activity(name: string, stopped: boolean): SessionActivity {
  return { name, lastLiveActivityAt: stopped ? 0 : Date.now(), stopped };
}

describe('createSessionActivityNotifier', () => {
  beforeEach(() => {
    scheduleNotification.mockClear();
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

  it('re-arms after the session resumes activity', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('demo', true));
    notifier.handleActivity(activity('demo', false));
    notifier.handleActivity(activity('demo', true));
    expect(scheduleNotification).toHaveBeenCalledTimes(2);
  });

  it('tracks sessions independently', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('demo', true));
    notifier.handleActivity(activity('other', true));
    expect(scheduleNotification).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown/empty activities', () => {
    const notifier = createSessionActivityNotifier();
    notifier.handleActivity(activity('', true));
    notifier.handleActivity({} as SessionActivity);
    expect(scheduleNotification).not.toHaveBeenCalled();
  });
});
