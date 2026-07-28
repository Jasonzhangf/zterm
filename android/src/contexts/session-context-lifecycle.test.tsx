// @vitest-environment jsdom

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLifecycleRefreshTargets,
  buildPassiveVisibleRefreshTargets,
  collectNewlyMaterializedLiveSessionIds,
  collectNewlyVisibleLiveSessionIds,
  selectNextPassiveVisibleRefreshCandidate,
  shouldScheduleActiveTickRefresh,
  shouldSchedulePassiveVisibleTickRefresh,
  useSessionContextLifecycle,
} from './session-context-lifecycle';
import { createSessionHeartbeatStore } from '../lib/session-heartbeat-store';
import { createSessionReconnectStore } from '../lib/session-reconnect-store';

describe('session-context-lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collects newly visible live pane sessions as reentry targets', () => {
    expect(collectNewlyVisibleLiveSessionIds(['s1'], ['s1', 's2'])).toEqual(['s2']);
    expect(collectNewlyVisibleLiveSessionIds(['s1', 's2'], ['s1', 's2'])).toEqual([]);
  });

  it('builds active tick refresh targets from active only', () => {
    expect(buildLifecycleRefreshTargets({
      activeSessionId: 's1',
      liveSessionIds: ['s1', 's2', 's3'],
    } as any)).toEqual(['s1']);
    expect(buildLifecycleRefreshTargets({
      activeSessionId: null,
      liveSessionIds: ['s2'],
    } as any)).toEqual([]);
  });

  it('builds passive visible refresh targets without the active session', () => {
    expect(buildPassiveVisibleRefreshTargets({
      activeSessionId: 's1',
      liveSessionIds: ['s1', 's2', 's3', 's2'],
    } as any)).toEqual(['s2', 's3']);
    expect(buildPassiveVisibleRefreshTargets({
      activeSessionId: null,
      liveSessionIds: ['s2'],
    } as any)).toEqual(['s2']);
  });

  it('selects one passive visible pane refresh per tick in round-robin order', () => {
    const first = selectNextPassiveVisibleRefreshCandidate(['s2', 's3', 's4'], 0, () => true);
    expect(first).toEqual({ sessionId: 's2', nextCursor: 1 });

    const second = selectNextPassiveVisibleRefreshCandidate(['s2', 's3', 's4'], first.nextCursor, () => true);
    expect(second).toEqual({ sessionId: 's3', nextCursor: 2 });

    const skipped = selectNextPassiveVisibleRefreshCandidate(
      ['s2', 's3', 's4'],
      second.nextCursor,
      (sessionId) => sessionId !== 's4',
    );
    expect(skipped).toEqual({ sessionId: 's2', nextCursor: 1 });
  });

  it('advances the passive visible cursor past the selected stale pane after skipping fresh panes', () => {
    const first = selectNextPassiveVisibleRefreshCandidate(
      ['fresh-a', 'stale-b', 'stale-c'],
      0,
      (sessionId) => sessionId !== 'fresh-a',
    );
    expect(first).toEqual({ sessionId: 'stale-b', nextCursor: 2 });

    const second = selectNextPassiveVisibleRefreshCandidate(
      ['fresh-a', 'stale-b', 'stale-c'],
      first.nextCursor,
      (sessionId) => sessionId !== 'fresh-a',
    );
    expect(second).toEqual({ sessionId: 'stale-c', nextCursor: 0 });
  });

  it('rejects invalid passive visible refresh cursors instead of coercing them to the first pane', () => {
    expect(() => selectNextPassiveVisibleRefreshCandidate(['s2'], Number.NaN, () => true)).toThrow(
      '[session-context-lifecycle] passive visible refresh cursor must be a non-negative integer.',
    );
    expect(() => selectNextPassiveVisibleRefreshCandidate(['s2'], -1, () => true)).toThrow(
      '[session-context-lifecycle] passive visible refresh cursor must be a non-negative integer.',
    );
    expect(() => selectNextPassiveVisibleRefreshCandidate(['s2'], 0.5, () => true)).toThrow(
      '[session-context-lifecycle] passive visible refresh cursor must be a non-negative integer.',
    );
  });

  it('schedules active tick only for non-connected or stale-silent sessions', () => {
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordTerminalActivity('connected-fresh', 9_900);
    heartbeatStore.recordTerminalActivity('connected-stale', 9_700);
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
      heartbeatStore,
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(false);

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'connected-stale',
      heartbeatStore,
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(true);

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'connecting',
      heartbeatStore,
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(true);
  });

  it('schedules active tick from terminal render freshness instead of generic server activity', () => {
    const state = {
      sessions: [{ id: 'session-1', state: 'connected' }],
      activeSessionId: 'session-1',
      liveSessionIds: ['session-1'],
    } as any;
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordServerActivity('session-1', 9_950);
    heartbeatStore.recordTerminalActivity('session-1', 9_000);

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'session-1',
      heartbeatStore,
      headStalePingMs: 200,
      now: 10_000,
    } as any)).toBe(true);
  });

  it('uses connected baseline only as a bounded initial head freshness window', () => {
    const state = {
      sessions: [{ id: 'session-1', state: 'connected' }],
      activeSessionId: 'session-1',
      liveSessionIds: ['session-1'],
    } as any;
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordServerActivity('session-1', 9_990);
    const lastConnectedBaselineAtRef = { current: new Map<string, number>([
      ['session-1', 9_900],
    ]) };

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'session-1',
      heartbeatStore,
      lastConnectedBaselineAtRef,
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(false);

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'session-1',
      heartbeatStore,
      lastConnectedBaselineAtRef,
      headStalePingMs: 200,
      now: 10_101,
    })).toBe(true);
  });

  it('keeps passive visible pane sessions refreshing before first server activity on the slow lane', () => {
    const state = {
      sessions: [
        { id: 'active-pane', state: 'connected' },
        { id: 'passive-pane', state: 'connected' },
      ],
      activeSessionId: 'active-pane',
      liveSessionIds: ['active-pane', 'passive-pane'],
    } as any;

    expect(shouldSchedulePassiveVisibleTickRefresh({
      state,
      sessionId: 'passive-pane',
      heartbeatStore: createSessionHeartbeatStore(),
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(true);
  });

  it('does not treat visible non-active panes as active tick refresh targets before first server activity', () => {
    const state = {
      sessions: [
        { id: 'active-pane', state: 'connected' },
        { id: 'passive-pane', state: 'connected' },
      ],
      activeSessionId: 'active-pane',
      liveSessionIds: ['active-pane', 'passive-pane'],
    } as any;

    expect(shouldScheduleActiveTickRefresh({
      state,
      sessionId: 'passive-pane',
      heartbeatStore: createSessionHeartbeatStore(),
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(false);

    expect(shouldSchedulePassiveVisibleTickRefresh({
      state,
      sessionId: 'passive-pane',
      heartbeatStore: createSessionHeartbeatStore(),
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(true);
  });

  it('treats the first live pane id snapshot as newly visible so split cold start opens non-active panes', () => {
    expect(collectNewlyVisibleLiveSessionIds([], ['s1', 's2'])).toEqual(['s1', 's2']);
  });

  it('treats later runtime shell materialization as a live pane resume target', () => {
    expect(collectNewlyMaterializedLiveSessionIds(
      ['s1'],
      ['s1', 's2'],
      ['s1', 's2'],
    )).toEqual(['s2']);
    expect(collectNewlyMaterializedLiveSessionIds(
      ['s1'],
      ['s1', 's2'],
      ['s1'],
    )).toEqual([]);
  });

  it('triggers explicit resume refresh exactly once when app foreground truth flips back to active', async () => {
    vi.useFakeTimers();
    const ensureActiveSessionFresh = vi.fn(() => true);

    function Harness({ appForegroundActive }: { appForegroundActive: boolean }) {
      useSessionContextLifecycle({
        appForegroundActive,
        state: {
          sessions: [{ id: 's1', state: 'connected' } as any],
          activeSessionId: 's1',
          liveSessionIds: [],
        } as any,
        scheduleStates: {},
        refs: {
          foregroundActiveRef: { current: appForegroundActive },
          stateRef: {
            current: {
              sessions: [{ id: 's1', state: 'connected' } as any],
              activeSessionId: 's1',
              liveSessionIds: [],
            } as any,
          },
          scheduleStatesRef: { current: {} },
          sessionDebugMetricsStoreRef: { current: { refresh: () => ({}) } },
          transportRuntimeStoreRef: { current: { targets: new Map(), sessions: new Map() } },
          sessionPullStateRef: { current: new Map() },
          lastActivatedSessionIdRef: { current: 's1' },
          lastActiveReentryAtRef: { current: new Map() },
          lastConnectedBaselineAtRef: { current: new Map() },
          heartbeatStore: createSessionHeartbeatStore(),
          remoteScreenshotRuntimeRef: { current: { dispose: () => undefined } },
          remoteWindowMessageRuntimeRef: { current: { dispose: () => undefined } },
          handshakeTimeoutsRef: { current: new Map() },
          reconnectStore: createSessionReconnectStore(),
        },
        flushRuntimeDebugLogs: () => undefined,
        clientRuntimeDebugFlushIntervalMs: 10_000,
        ensureActiveSessionFresh,
        resolveActiveHeadRefreshTickMs: () => 10_000,
        resolveHeadStalePingMs: () => 10_000,
        clearSessionHandshakeTimeout: () => undefined,
        cleanupSocket: () => undefined,
        cleanupControlSocket: () => undefined,
      });
      return null;
    }

    const view = render(<Harness appForegroundActive={false} />);
    expect(ensureActiveSessionFresh).not.toHaveBeenCalled();

    view.rerender(<Harness appForegroundActive />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureActiveSessionFresh).toHaveBeenCalledTimes(1);
    expect(ensureActiveSessionFresh).toHaveBeenCalledWith({
      sessionId: 's1',
      source: 'explicit-resume',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });

    view.rerender(<Harness appForegroundActive />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureActiveSessionFresh).toHaveBeenCalledTimes(1);
  });

  it('triggers explicit resume refresh when a foreground resume event arrives without a boolean edge', async () => {
    vi.useFakeTimers();
    const ensureActiveSessionFresh = vi.fn(() => true);

    function Harness({ foregroundResumeEpoch }: { foregroundResumeEpoch: number }) {
      useSessionContextLifecycle({
        appForegroundActive: true,
        foregroundResumeEpoch,
        state: {
          sessions: [{ id: 's1', state: 'connected' } as any],
          activeSessionId: 's1',
          liveSessionIds: [],
        } as any,
        scheduleStates: {},
        refs: {
          foregroundActiveRef: { current: true },
          stateRef: {
            current: {
              sessions: [{ id: 's1', state: 'connected' } as any],
              activeSessionId: 's1',
              liveSessionIds: [],
            } as any,
          },
          scheduleStatesRef: { current: {} },
          sessionDebugMetricsStoreRef: { current: { refresh: () => ({}) } },
          transportRuntimeStoreRef: { current: { targets: new Map(), sessions: new Map() } },
          sessionPullStateRef: { current: new Map() },
          lastActivatedSessionIdRef: { current: 's1' },
          lastActiveReentryAtRef: { current: new Map() },
          lastConnectedBaselineAtRef: { current: new Map() },
          heartbeatStore: createSessionHeartbeatStore(),
          remoteScreenshotRuntimeRef: { current: { dispose: () => undefined } },
          remoteWindowMessageRuntimeRef: { current: { dispose: () => undefined } },
          handshakeTimeoutsRef: { current: new Map() },
          reconnectStore: createSessionReconnectStore(),
        },
        flushRuntimeDebugLogs: () => undefined,
        clientRuntimeDebugFlushIntervalMs: 10_000,
        ensureActiveSessionFresh,
        resolveActiveHeadRefreshTickMs: () => 10_000,
        resolveHeadStalePingMs: () => 10_000,
        clearSessionHandshakeTimeout: () => undefined,
        cleanupSocket: () => undefined,
        cleanupControlSocket: () => undefined,
      });
      return null;
    }

    const view = render(<Harness foregroundResumeEpoch={0} />);
    expect(ensureActiveSessionFresh).not.toHaveBeenCalled();

    view.rerender(<Harness foregroundResumeEpoch={1} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureActiveSessionFresh).toHaveBeenCalledTimes(1);
    expect(ensureActiveSessionFresh).toHaveBeenCalledWith({
      sessionId: 's1',
      source: 'explicit-resume',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });

    view.rerender(<Harness foregroundResumeEpoch={1} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureActiveSessionFresh).toHaveBeenCalledTimes(1);
  });

  it('marks resume-tail when the active session changes through lifecycle reentry', async () => {
    vi.useFakeTimers();
    const ensureActiveSessionFresh = vi.fn(() => true);
    const lifecycleRefs = {
      foregroundActiveRef: { current: true },
      stateRef: {
        current: {
          sessions: [{ id: 's1', state: 'connected' } as any, { id: 's2', state: 'connected' } as any],
          activeSessionId: 's1',
          liveSessionIds: [],
        } as any,
      },
      scheduleStatesRef: { current: {} },
      sessionDebugMetricsStoreRef: { current: { refresh: () => ({}) } },
      transportRuntimeStoreRef: { current: { targets: new Map(), sessions: new Map() } },
      sessionPullStateRef: { current: new Map() },
      lastActivatedSessionIdRef: { current: 's1' },
      lastActiveReentryAtRef: { current: new Map() },
      lastConnectedBaselineAtRef: { current: new Map() },
      heartbeatStore: createSessionHeartbeatStore(),
      remoteScreenshotRuntimeRef: { current: { dispose: () => undefined } },
      remoteWindowMessageRuntimeRef: { current: { dispose: () => undefined } },
      handshakeTimeoutsRef: { current: new Map() },
      reconnectStore: createSessionReconnectStore(),
    };

    function Harness({ activeSessionId }: { activeSessionId: string }) {
      const state = {
        sessions: [{ id: 's1', state: 'connected' } as any, { id: 's2', state: 'connected' } as any],
        activeSessionId,
        liveSessionIds: [],
      } as any;
      useSessionContextLifecycle({
        appForegroundActive: true,
        state,
        scheduleStates: {},
        refs: lifecycleRefs,
        flushRuntimeDebugLogs: () => undefined,
        clientRuntimeDebugFlushIntervalMs: 10_000,
        ensureActiveSessionFresh,
        resolveActiveHeadRefreshTickMs: () => 10_000,
        resolveHeadStalePingMs: () => 10_000,
        clearSessionHandshakeTimeout: () => undefined,
        cleanupSocket: () => undefined,
        cleanupControlSocket: () => undefined,
      });
      return null;
    }

    const view = render(<Harness activeSessionId="s1" />);
    expect(ensureActiveSessionFresh).not.toHaveBeenCalled();

    view.rerender(<Harness activeSessionId="s2" />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(ensureActiveSessionFresh).toHaveBeenCalledTimes(1);
    expect(ensureActiveSessionFresh).toHaveBeenCalledWith({
      sessionId: 's2',
      source: 'active-reentry',
      forceHead: true,
      markResumeTail: true,
      allowReconnectIfUnavailable: true,
    });
  });

  it('does not start debug or refresh timers while app foreground truth is false', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const ensureActiveSessionFresh = vi.fn(() => true);

    function Harness() {
      useSessionContextLifecycle({
        appForegroundActive: false,
        state: {
          sessions: [{ id: 's1', state: 'connected' } as any],
          activeSessionId: 's1',
          liveSessionIds: ['s1'],
        } as any,
        scheduleStates: {},
        refs: {
          foregroundActiveRef: { current: false },
          stateRef: {
            current: {
              sessions: [{ id: 's1', state: 'connected' } as any],
              activeSessionId: 's1',
              liveSessionIds: ['s1'],
            } as any,
          },
          scheduleStatesRef: { current: {} },
          sessionDebugMetricsStoreRef: { current: { refresh: () => ({}) } },
          transportRuntimeStoreRef: { current: { targets: new Map(), sessions: new Map() } },
          sessionPullStateRef: { current: new Map() },
          lastActivatedSessionIdRef: { current: 's1' },
          lastActiveReentryAtRef: { current: new Map() },
          lastConnectedBaselineAtRef: { current: new Map() },
          heartbeatStore: createSessionHeartbeatStore(),
          remoteScreenshotRuntimeRef: { current: { dispose: () => undefined } },
          remoteWindowMessageRuntimeRef: { current: { dispose: () => undefined } },
          handshakeTimeoutsRef: { current: new Map() },
          reconnectStore: createSessionReconnectStore(),
        },
        flushRuntimeDebugLogs: () => undefined,
        clientRuntimeDebugFlushIntervalMs: 10_000,
        ensureActiveSessionFresh,
        resolveActiveHeadRefreshTickMs: () => 16,
        resolveHeadStalePingMs: () => 10_000,
        clearSessionHandshakeTimeout: () => undefined,
        cleanupSocket: () => undefined,
        cleanupControlSocket: () => undefined,
      });
      return null;
    }

    render(<Harness />);

    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(ensureActiveSessionFresh).not.toHaveBeenCalled();
  });
});
