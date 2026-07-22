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
    const lastServerActivityAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
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
      lastServerActivityAtRef,
      clientPingIntervalMs: 2000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(staleHandle);
    expect(pingIntervalsRef.current.get(sessionId)).not.toBe(staleHandle);
    expect(pingIntervalsRef.current.has(sessionId)).toBe(true);
  });

  it('fails and closes an OPEN socket once after three consecutive server-activity misses', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const pingIntervalsRef = { current: new Map<string, ReturnType<typeof setInterval>>() };
    const lastPongAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const lastServerActivityAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
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
      lastServerActivityAtRef,
      clientPingIntervalMs: 2000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });

    vi.advanceTimersByTime(4000);
    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);

    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(finalizeFailure).toHaveBeenCalledTimes(1);
    expect(finalizeFailure).toHaveBeenCalledWith('heartbeat server activity timeout', true);
    expect(ws.close).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);
    expect(finalizeFailure).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('reports route failure before client-closing a stale heartbeat socket', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const pingIntervalsRef = { current: new Map<string, ReturnType<typeof setInterval>>() };
    const lastPongAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const lastServerActivityAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const reportFailure = vi.fn();
    const ws = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      reportFailure,
    } as unknown as { readyState: number; close: () => void; reportFailure: (reason: string) => void };

    startSocketHeartbeat({
      sessionId,
      ws: ws as any,
      finalizeFailure,
      pingIntervalsRef,
      lastPongAtRef,
      lastServerActivityAtRef,
      clientPingIntervalMs: 2000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });

    vi.advanceTimersByTime(6000);

    expect(reportFailure).toHaveBeenCalledWith('heartbeat server activity timeout');
    expect(reportFailure.mock.invocationCallOrder[0]).toBeLessThan(finalizeFailure.mock.invocationCallOrder[0]);
    expect(finalizeFailure).toHaveBeenCalledWith('heartbeat server activity timeout', true);
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it('resets consecutive misses when any server activity advances without a pong', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const pingIntervalsRef = { current: new Map<string, ReturnType<typeof setInterval>>() };
    const lastPongAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const lastServerActivityAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId, ws, finalizeFailure, pingIntervalsRef, lastPongAtRef, lastServerActivityAtRef,
      clientPingIntervalMs: 2000, maxConsecutiveMisses: 3, sendSocketPayload,
    });

    vi.advanceTimersByTime(4000);
    lastServerActivityAtRef.current.set(sessionId, Date.now());
    vi.advanceTimersByTime(4000);

    expect(sendSocketPayload).toHaveBeenCalledTimes(4);
    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('resets consecutive misses when pong truth advances on an idle terminal', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const pingIntervalsRef = { current: new Map<string, ReturnType<typeof setInterval>>() };
    const lastPongAtRef = { current: new Map<string, number>([[sessionId, Date.now()]]) };
    const lastServerActivityAtRef = { current: new Map<string, number>() };
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId, ws, finalizeFailure, pingIntervalsRef, lastPongAtRef, lastServerActivityAtRef,
      clientPingIntervalMs: 2000, maxConsecutiveMisses: 3, sendSocketPayload,
    });

    vi.advanceTimersByTime(4000);
    lastPongAtRef.current.set(sessionId, Date.now());
    vi.advanceTimersByTime(4000);

    expect(sendSocketPayload).toHaveBeenCalledTimes(4);
    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('does not send or fail while the socket is not OPEN', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.CLOSING, close: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId, ws, finalizeFailure,
      pingIntervalsRef: { current: new Map() },
      lastPongAtRef: { current: new Map([[sessionId, Date.now()]]) },
      lastServerActivityAtRef: { current: new Map([[sessionId, Date.now()]]) },
      clientPingIntervalMs: 2000, maxConsecutiveMisses: 3, sendSocketPayload,
    });

    vi.advanceTimersByTime(10000);
    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('keys mux heartbeat activity by physical target instead of logical session id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const sessionId = 'session-anchor';
    const heartbeatKey = 'target:mac-studio';
    const pingIntervalsRef = { current: new Map<string, ReturnType<typeof setInterval>>() };
    const lastPongAtRef = { current: new Map<string, number>() };
    const lastServerActivityAtRef = { current: new Map<string, number>() };
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn(), reportFailure: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId,
      heartbeatKey,
      ws,
      finalizeFailure,
      pingIntervalsRef,
      lastPongAtRef,
      lastServerActivityAtRef,
      clientPingIntervalMs: 1000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    } as any);

    vi.advanceTimersByTime(2000);
    vi.setSystemTime(2500);
    lastServerActivityAtRef.current.set(heartbeatKey, Date.now());
    vi.advanceTimersByTime(3000);

    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    expect(pingIntervalsRef.current.has(heartbeatKey)).toBe(true);
    expect(pingIntervalsRef.current.has(sessionId)).toBe(false);
  });

  it('keeps only one heartbeat timer when multiple logical sessions share the same physical target', () => {
    vi.useFakeTimers();
    const heartbeatKey = 'target:mac-studio';
    const pingIntervalsRef = { current: new Map<string, ReturnType<typeof setInterval>>() };
    const refs = {
      pingIntervalsRef,
      lastPongAtRef: { current: new Map<string, number>() },
      lastServerActivityAtRef: { current: new Map<string, number>() },
    };
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId: 'session-a',
      heartbeatKey,
      ws,
      finalizeFailure,
      ...refs,
      clientPingIntervalMs: 1000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    } as any);
    const firstTimer = pingIntervalsRef.current.get(heartbeatKey);
    startSocketHeartbeat({
      sessionId: 'session-b',
      heartbeatKey,
      ws,
      finalizeFailure,
      ...refs,
      clientPingIntervalMs: 1000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    } as any);

    expect(pingIntervalsRef.current.size).toBe(1);
    expect(pingIntervalsRef.current.has(heartbeatKey)).toBe(true);
    expect(pingIntervalsRef.current.get(heartbeatKey)).not.toBe(firstTimer);
    expect(pingIntervalsRef.current.has('session-a')).toBe(false);
    expect(pingIntervalsRef.current.has('session-b')).toBe(false);
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
