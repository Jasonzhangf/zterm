import { describe, expect, it } from 'vitest';
import {
  buildLifecycleRefreshTargets,
  collectNewlyVisibleLiveSessionIds,
  shouldScheduleActiveTickRefresh,
} from './session-context-lifecycle';

describe('session-context-lifecycle', () => {
  it('collects newly visible live pane sessions as reentry targets', () => {
    expect(collectNewlyVisibleLiveSessionIds(['s1'], ['s1', 's2'])).toEqual(['s2']);
    expect(collectNewlyVisibleLiveSessionIds(['s1', 's2'], ['s1', 's2'])).toEqual([]);
  });

  it('builds active tick refresh targets from active + visible live panes', () => {
    expect(buildLifecycleRefreshTargets({
      activeSessionId: 's1',
      liveSessionIds: ['s1', 's2', 's3'],
    } as any)).toEqual(['s1', 's2', 's3']);
    expect(buildLifecycleRefreshTargets({
      activeSessionId: null,
      liveSessionIds: ['s2'],
    } as any)).toEqual(['s2']);
  });

  it('schedules active tick only for non-connected or stale-silent sessions', () => {
    const lastServerActivityAtRef = { current: new Map<string, number>([
      ['connected-fresh', 9_900],
      ['connected-stale', 9_700],
    ]) };
    const state = {
      sessions: [
        { id: 'connected-fresh', state: 'connected' },
        { id: 'connected-stale', state: 'connected' },
        { id: 'connecting', state: 'connecting' },
      ],
    } as any;

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'connected-fresh',
      lastServerActivityAtRef,
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(false);

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'connected-stale',
      lastServerActivityAtRef,
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(true);

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'connecting',
      lastServerActivityAtRef,
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(true);
  });
});
