import { describe, expect, it, vi } from 'vitest';
import {
  recordSessionRx,
  resetSessionTransportPullBookkeeping,
} from './session-context-pull-runtime';

describe('session-context-pull-runtime', () => {
  it('keeps a head probe pending when only non-render server activity arrives', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const refs = {
      sessionDebugMetricsStoreRef: { current: { recordRxBytes: vi.fn() } },
      lastServerActivityAtRef: { current: new Map<string, number>() },
      lastTerminalActivityAtRef: { current: new Map<string, number>() },
      staleTransportProbeAtRef: { current: new Map<string, number>([['session-1', 9_000]]) },
    };

    try {
      recordSessionRx({
        sessionId: 'session-1',
        data: JSON.stringify({ type: 'title', payload: 'still alive but not render truth' }),
        refs: refs as any,
      });

      expect(refs.lastServerActivityAtRef.current.get('session-1')).toBe(10_000);
      expect(refs.lastTerminalActivityAtRef.current.has('session-1')).toBe(false);
      expect(refs.staleTransportProbeAtRef.current.get('session-1')).toBe(9_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears a head probe only when buffer head or body truth arrives', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const refs = {
      sessionDebugMetricsStoreRef: { current: { recordRxBytes: vi.fn() } },
      lastServerActivityAtRef: { current: new Map<string, number>() },
      lastTerminalActivityAtRef: { current: new Map<string, number>() },
      staleTransportProbeAtRef: { current: new Map<string, number>([['session-1', 9_000]]) },
    };

    try {
      recordSessionRx({
        sessionId: 'session-1',
        data: JSON.stringify({
          type: 'mux-channel-message',
          payload: {
            channelId: 'channel-1',
            message: {
              type: 'buffer-head',
              payload: { revision: 3, latestEndIndex: 42 },
            },
          },
        }),
        refs: refs as any,
      });

      expect(refs.lastServerActivityAtRef.current.get('session-1')).toBe(10_000);
      expect(refs.lastTerminalActivityAtRef.current.get('session-1')).toBe(10_000);
      expect(refs.staleTransportProbeAtRef.current.has('session-1')).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears both in-flight pull state and sync debounce truth on bookkeeping reset', () => {
    const sessionId = 'session-2';
    const sessionPullStateRef = {
      current: new Map([
        [sessionId, {
          'tail-refresh': {
            purpose: 'tail-refresh',
            startedAt: 100,
            targetHeadRevision: 6,
            targetStartIndex: 120,
            targetEndIndex: 121,
            requestKnownRevision: 5,
            requestLocalStartIndex: 0,
            requestLocalEndIndex: 120,
          },
        }],
      ]),
    };
    const lastSyncRequestAtRef = {
      current: new Map([
        [`${sessionId}:tail-refresh`, {
          sentAt: 120,
          requestStartIndex: 120,
          requestEndIndex: 121,
          knownRevision: 5,
          localStartIndex: 0,
          localEndIndex: 120,
          targetHeadRevision: 6,
        }],
        [`${sessionId}:reading-repair`, {
          sentAt: 121,
          requestStartIndex: 40,
          requestEndIndex: 60,
          knownRevision: 5,
          localStartIndex: 40,
          localEndIndex: 60,
          targetHeadRevision: 6,
        }],
      ]),
    };
    const pendingInputTailRefreshRef = {
      current: new Map([
        [sessionId, { requestedAt: 122, localRevision: 5 }],
      ]),
    };
    const runtimeDebug = vi.fn();

    resetSessionTransportPullBookkeeping({
      sessionId,
      reason: 'active-reentry',
      activeSessionId: sessionId,
      sessionPullStateRef: sessionPullStateRef as any,
      pendingInputTailRefreshRef: pendingInputTailRefreshRef as any,
      lastSyncRequestAtRef: lastSyncRequestAtRef as any,
      runtimeDebug,
    });

    expect(sessionPullStateRef.current.has(sessionId)).toBe(false);
    expect(pendingInputTailRefreshRef.current.has(sessionId)).toBe(false);
    expect(lastSyncRequestAtRef.current.has(`${sessionId}:tail-refresh`)).toBe(false);
    expect(lastSyncRequestAtRef.current.has(`${sessionId}:reading-repair`)).toBe(false);
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.pull.reset',
      expect.objectContaining({
        sessionId,
        reason: 'active-reentry',
        hadPendingInputTailRefresh: true,
        hadTailRefreshDebounce: true,
        hadReadingRepairDebounce: true,
      }),
    );
  });

  it('also clears pending input tail refresh bookkeeping on bookkeeping reset', () => {
    const sessionId = 'session-3';
    const pendingInputTailRefreshRef = {
      current: new Map([
        [sessionId, { requestedAt: 122, localRevision: 5 }],
      ]),
    };
    const runtimeDebug = vi.fn();

    resetSessionTransportPullBookkeeping({
      sessionId,
      reason: 'tab-switch-in',
      activeSessionId: sessionId,
      sessionPullStateRef: { current: new Map() } as any,
      pendingInputTailRefreshRef: pendingInputTailRefreshRef as any,
      lastSyncRequestAtRef: { current: new Map() } as any,
      runtimeDebug,
    });

    expect(pendingInputTailRefreshRef.current.has(sessionId)).toBe(false);
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.buffer.pull.reset',
      expect.objectContaining({
        sessionId,
        reason: 'tab-switch-in',
        hadPendingInputTailRefresh: true,
      }),
    );
  });
});
