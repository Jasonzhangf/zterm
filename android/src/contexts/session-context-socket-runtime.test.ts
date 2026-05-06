import { describe, expect, it, vi, afterEach } from 'vitest';
import { clearTailRefreshRuntime, startSocketHeartbeat } from './session-context-socket-runtime';

describe('session-context-socket-runtime heartbeat lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears any existing heartbeat interval before starting a replacement heartbeat for the same session', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const pingIntervalsRef = { current: new Map<string, ReturnType<typeof setInterval>>() };
    const lastPongAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();

    const staleHandle = setInterval(() => undefined, 9999);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    pingIntervalsRef.current.set(sessionId, staleHandle);

    const ws = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
    } as unknown as { readyState: number; close: () => void };

    startSocketHeartbeat({
      sessionId,
      ws: ws as any,
      finalizeFailure,
      pingIntervalsRef,
      lastPongAtRef,
      clientPingIntervalMs: 30000,
      clientPongTimeoutMs: 70000,
      sendSocketPayload,
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(staleHandle);
    expect(pingIntervalsRef.current.get(sessionId)).not.toBe(staleHandle);
    expect(pingIntervalsRef.current.has(sessionId)).toBe(true);
  });

  it('clears stale tail-refresh markers together with head throttle state during socket cleanup prep', () => {
    const sessionId = 'session-1';
    const sessionBufferHeadsRef = { current: new Map([[sessionId, { revision: 5, latestEndIndex: 88, seenAt: 1 }]]) };
    const sessionRevisionResetRef = { current: new Map([[sessionId, { revision: 4, latestEndIndex: 77, seenAt: 1 }]]) };
    const lastHeadRequestAtRef = { current: new Map([[sessionId, 123]]) };
    const pendingInputTailRefreshRef = { current: new Map([[sessionId, { requestedAt: 5, localRevision: 3 }]]) };
    const pendingConnectTailRefreshRef = { current: new Set([sessionId]) };
    const pendingResumeTailRefreshRef = { current: new Set([sessionId]) };

    clearTailRefreshRuntime({
      sessionId,
      sessionBufferHeadsRef,
      sessionRevisionResetRef,
      lastHeadRequestAtRef,
      pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef,
    });

    expect(sessionBufferHeadsRef.current.has(sessionId)).toBe(false);
    expect(sessionRevisionResetRef.current.has(sessionId)).toBe(false);
    expect(lastHeadRequestAtRef.current.has(sessionId)).toBe(false);
    expect(pendingInputTailRefreshRef.current.has(sessionId)).toBe(false);
    expect(pendingConnectTailRefreshRef.current.has(sessionId)).toBe(false);
    expect(pendingResumeTailRefreshRef.current.has(sessionId)).toBe(false);
  });
});
