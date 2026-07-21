// @vitest-environment jsdom

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLifecycleRefreshTargets,
  buildPassiveVisibleRefreshTargets,
  collectNewlyMaterializedLiveSessionIds,
  collectNewlyVisibleLiveSessionIds,
  shouldScheduleActiveTickRefresh,
  shouldSchedulePassiveVisibleTickRefresh,
  useSessionContextLifecycle,
} from './session-context-lifecycle';

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
      lastServerActivityAtRef: { current: new Map() },
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
      lastServerActivityAtRef: { current: new Map() },
      headStalePingMs: 200,
      now: 10_000,
    })).toBe(false);

    expect(shouldSchedulePassiveVisibleTickRefresh({
      state,
      sessionId: 'passive-pane',
      lastServerActivityAtRef: { current: new Map() },
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
          transportRuntimeStoreRef: { current: { sessions: new Map() } },
          sessionPullStateRef: { current: new Map() },
          lastActivatedSessionIdRef: { current: 's1' },
          lastActiveReentryAtRef: { current: new Map() },
          lastConnectedBaselineAtRef: { current: new Map() },
          lastServerActivityAtRef: { current: new Map() },
          remoteScreenshotRuntimeRef: { current: { dispose: () => undefined } },
          remoteWindowMessageRuntimeRef: { current: { dispose: () => undefined } },
          pingIntervalsRef: { current: new Map() },
          handshakeTimeoutsRef: { current: new Map() },
          reconnectRuntimesRef: { current: new Map() },
          manualCloseRef: { current: new Set() },
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
      transportRuntimeStoreRef: { current: { sessions: new Map() } },
      sessionPullStateRef: { current: new Map() },
      lastActivatedSessionIdRef: { current: 's1' },
      lastActiveReentryAtRef: { current: new Map() },
      lastConnectedBaselineAtRef: { current: new Map() },
      lastServerActivityAtRef: { current: new Map() },
      remoteScreenshotRuntimeRef: { current: { dispose: () => undefined } },
      remoteWindowMessageRuntimeRef: { current: { dispose: () => undefined } },
      pingIntervalsRef: { current: new Map() },
      handshakeTimeoutsRef: { current: new Map() },
      reconnectRuntimesRef: { current: new Map() },
      manualCloseRef: { current: new Set<string>() },
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
          transportRuntimeStoreRef: { current: { sessions: new Map() } },
          sessionPullStateRef: { current: new Map() },
          lastActivatedSessionIdRef: { current: 's1' },
          lastActiveReentryAtRef: { current: new Map() },
          lastConnectedBaselineAtRef: { current: new Map() },
          lastServerActivityAtRef: { current: new Map() },
          remoteScreenshotRuntimeRef: { current: { dispose: () => undefined } },
          remoteWindowMessageRuntimeRef: { current: { dispose: () => undefined } },
          pingIntervalsRef: { current: new Map() },
          handshakeTimeoutsRef: { current: new Map() },
          reconnectRuntimesRef: { current: new Map() },
          manualCloseRef: { current: new Set() },
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
