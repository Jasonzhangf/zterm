import { describe, expect, it, vi } from 'vitest';
import {
  recordSessionRx,
  resetSessionTransportPullBookkeeping,
} from './session-context-pull-runtime';
import { createSessionHeartbeatStore } from '../lib/session-heartbeat-store';
import { createSessionReconnectStore } from '../lib/session-reconnect-store';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';

describe('session-context-pull-runtime', () => {
  it('keeps a head probe pending when only non-render server activity arrives', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const refs = {
      sessionDebugMetricsStoreRef: { current: { recordRxBytes: vi.fn() } },
      heartbeatStore: createSessionHeartbeatStore(),
      reconnectStore: (() => { const store = createSessionReconnectStore(); store.markStaleTransportProbe('session-1', 9_000); return store; })(),
    };

    try {
      recordSessionRx({
        sessionId: 'session-1',
        data: JSON.stringify({ type: 'title', payload: 'still alive but not render truth' }),
        refs: refs as any,
      });

      expect(refs.heartbeatStore.readLastServerActivityAt('session-1')).toBe(10_000);
      expect(refs.heartbeatStore.readLastTerminalActivityAt('session-1')).toBe(0);
      expect(refs.reconnectStore.readStaleTransportProbeAt('session-1')).toBe(9_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears a head probe only when buffer head or body truth arrives', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const refs = {
      sessionDebugMetricsStoreRef: { current: { recordRxBytes: vi.fn() } },
      heartbeatStore: createSessionHeartbeatStore(),
      reconnectStore: (() => { const store = createSessionReconnectStore(); store.markStaleTransportProbe('session-1', 9_000); return store; })(),
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

      expect(refs.heartbeatStore.readLastServerActivityAt('session-1')).toBe(10_000);
      expect(refs.heartbeatStore.readLastTerminalActivityAt('session-1')).toBe(10_000);
      expect(refs.reconnectStore.readStaleTransportProbeAt('session-1')).toBe(0);
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
    const tailRefreshStore = createSessionTailRefreshStore();
    tailRefreshStore.recordSyncRequest(sessionId, 'tail-refresh', {
      sentAt: 120,
      requestStartIndex: 120,
      requestEndIndex: 121,
      knownRevision: 5,
      localStartIndex: 0,
      localEndIndex: 120,
      targetHeadRevision: 6,
      repairSignature: '',
    });
    tailRefreshStore.recordSyncRequest(sessionId, 'reading-repair', {
      sentAt: 121,
      requestStartIndex: 40,
      requestEndIndex: 60,
      knownRevision: 5,
      localStartIndex: 40,
      localEndIndex: 60,
      targetHeadRevision: 6,
      repairSignature: '',
    });
    tailRefreshStore.markPendingInputTailRefresh(sessionId, 5, 122);
    const runtimeDebug = vi.fn();

    resetSessionTransportPullBookkeeping({
      sessionId,
      reason: 'active-reentry',
      activeSessionId: sessionId,
      sessionPullStateRef: sessionPullStateRef as any,
      tailRefreshStore,
      runtimeDebug,
    });

    expect(sessionPullStateRef.current.has(sessionId)).toBe(false);
    expect(tailRefreshStore.hasPendingInputTailRefresh(sessionId)).toBe(false);
    expect(tailRefreshStore.hasSyncRequest(sessionId, 'tail-refresh')).toBe(false);
    expect(tailRefreshStore.hasSyncRequest(sessionId, 'reading-repair')).toBe(false);
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
    const tailRefreshStore = createSessionTailRefreshStore();
    tailRefreshStore.markPendingInputTailRefresh(sessionId, 5, 122);
    const runtimeDebug = vi.fn();

    resetSessionTransportPullBookkeeping({
      sessionId,
      reason: 'tab-switch-in',
      activeSessionId: sessionId,
      sessionPullStateRef: { current: new Map() } as any,
      tailRefreshStore,
      runtimeDebug,
    });

    expect(tailRefreshStore.hasPendingInputTailRefresh(sessionId)).toBe(false);
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
