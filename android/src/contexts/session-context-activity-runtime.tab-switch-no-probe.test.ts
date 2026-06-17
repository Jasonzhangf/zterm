import { describe, expect, it, vi } from 'vitest';
import { probeOrReconnectStaleSessionTransportRuntime } from './session-context-activity-runtime';

describe('P3 tab switch no-probe', () => {
  it('skips probe when lastServerActivityAt is fresh (< 2x headStalePingMs)', () => {
    const now = 1_000_000;
    const sessionId = 'session-fresh';
    const lastServerActivityAt = now - 200; // 200ms ago
    const staleTransportProbeAtRef = { current: new Map<string, number>() };
    const lastServerActivityAtRef = { current: new Map<string, number>([[sessionId, lastServerActivityAt]]) };
    const stateRef = { current: { activeSessionId: sessionId } };
    const runtimeDebug = vi.fn();
    const resetSessionTransportPullBookkeeping = vi.fn();
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const ws = { readyState: 1, bufferedAmount: 0 } as any;

    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const result = probeOrReconnectStaleSessionTransportRuntime({
        sessionId,
        ws,
        reason: 'active-reentry',
        refs: {
          lastServerActivityAtRef,
          staleTransportProbeAtRef,
          stateRef,
        },
        runtimeDebug,
        resetSessionTransportPullBookkeeping,
        requestSessionBufferHead,
        reconnectSession,
        activeTransportProbeWaitMs: 2000,
      });
      // Expect: 'recovered' or new 'fresh' result indicating we skipped probe entirely
      expect(result).not.toBe('probed');
      expect(resetSessionTransportPullBookkeeping).not.toHaveBeenCalled();
    } finally {
      Date.now = originalNow;
    }
  });

  it('still probes when lastServerActivityAt is stale (>= 2x headStalePingMs)', () => {
    const now = 1_000_000;
    const sessionId = 'session-stale';
    const lastServerActivityAt = now - 5_000; // 5s ago
    const staleTransportProbeAtRef = { current: new Map<string, number>() };
    const lastServerActivityAtRef = { current: new Map<string, number>([[sessionId, lastServerActivityAt]]) };
    const stateRef = { current: { activeSessionId: sessionId } };
    const runtimeDebug = vi.fn();
    const resetSessionTransportPullBookkeeping = vi.fn();
    const requestSessionBufferHead = vi.fn(() => true);
    const reconnectSession = vi.fn();
    const ws = { readyState: 1, bufferedAmount: 0 } as any;

    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const result = probeOrReconnectStaleSessionTransportRuntime({
        sessionId,
        ws,
        reason: 'active-reentry',
        refs: {
          lastServerActivityAtRef,
          staleTransportProbeAtRef,
          stateRef,
        },
        runtimeDebug,
        resetSessionTransportPullBookkeeping,
        requestSessionBufferHead,
        reconnectSession,
        activeTransportProbeWaitMs: 2000,
      });
      // Stale activity -> probe should still fire
      expect(result).toBe('probed');
      expect(resetSessionTransportPullBookkeeping).toHaveBeenCalled();
    } finally {
      Date.now = originalNow;
    }
  });

  it('does not call requestSessionBufferHead when transport is fresh', () => {
    const now = 1_000_000;
    const sessionId = 'session-fresh-2';
    const lastServerActivityAt = now - 100;
    const lastServerActivityAtRef = { current: new Map<string, number>([[sessionId, lastServerActivityAt]]) };
    const staleTransportProbeAtRef = { current: new Map<string, number>() };
    const stateRef = { current: { activeSessionId: sessionId } };
    const requestSessionBufferHead = vi.fn(() => true);
    const ws = { readyState: 1, bufferedAmount: 0 } as any;

    const originalNow = Date.now;
    Date.now = () => now;
    try {
      probeOrReconnectStaleSessionTransportRuntime({
        sessionId,
        ws,
        reason: 'active-reentry',
        refs: { lastServerActivityAtRef, staleTransportProbeAtRef, stateRef },
        runtimeDebug: vi.fn(),
        resetSessionTransportPullBookkeeping: vi.fn(),
        requestSessionBufferHead,
        reconnectSession: vi.fn(),
        activeTransportProbeWaitMs: 2000,
      });
      expect(requestSessionBufferHead).not.toHaveBeenCalled();
    } finally {
      Date.now = originalNow;
    }
  });
});
