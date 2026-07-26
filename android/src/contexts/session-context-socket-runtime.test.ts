import { describe, expect, it, vi, afterEach } from 'vitest';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { clearTailRefreshRuntime, startSocketHeartbeat } from './session-context-socket-runtime';
import { createSessionHeartbeatStore } from '../lib/session-heartbeat-store';

describe('session-context-socket-runtime heartbeat lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears any existing heartbeat interval before starting a replacement heartbeat for the same session', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordPong(sessionId, Date.now());
    heartbeatStore.recordServerActivity(sessionId, Date.now());
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();

    const staleHandle = setInterval(() => undefined, 9999);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    heartbeatStore.setPingInterval(sessionId, staleHandle);

    const ws = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
    } as unknown as { readyState: number; close: () => void };

    startSocketHeartbeat({
      sessionId,
      ws: ws as any,
      finalizeFailure,
      heartbeatStore,
      clientPingIntervalMs: 2000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });

    expect(clearIntervalSpy).toHaveBeenCalledWith(staleHandle);
    expect(heartbeatStore.readPingInterval(sessionId)).not.toBe(staleHandle);
    expect(heartbeatStore.readPingInterval(sessionId)).not.toBeNull();
  });

  it('fails and closes an OPEN socket once after three consecutive server-activity misses', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordPong(sessionId, Date.now());
    heartbeatStore.recordServerActivity(sessionId, Date.now());
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
      heartbeatStore,
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
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordPong(sessionId, Date.now());
    heartbeatStore.recordServerActivity(sessionId, Date.now());
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
      heartbeatStore,
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
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordPong(sessionId, Date.now());
    heartbeatStore.recordServerActivity(sessionId, Date.now());
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId, ws, finalizeFailure, heartbeatStore,
      clientPingIntervalMs: 2000, maxConsecutiveMisses: 3, sendSocketPayload,
    });

    vi.advanceTimersByTime(4000);
    heartbeatStore.recordServerActivity(sessionId, Date.now());
    vi.advanceTimersByTime(4000);

    expect(sendSocketPayload).toHaveBeenCalledTimes(4);
    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('resets consecutive misses when pong truth advances on an idle terminal', () => {
    vi.useFakeTimers();
    const sessionId = 'session-1';
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordPong(sessionId, Date.now());
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId, ws, finalizeFailure, heartbeatStore,
      clientPingIntervalMs: 2000, maxConsecutiveMisses: 3, sendSocketPayload,
    });

    vi.advanceTimersByTime(4000);
    heartbeatStore.recordPong(sessionId, Date.now());
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
    const heartbeatStore = createSessionHeartbeatStore();
    heartbeatStore.recordPong(sessionId, Date.now());
    heartbeatStore.recordServerActivity(sessionId, Date.now());

    startSocketHeartbeat({
      sessionId, ws, finalizeFailure,
      heartbeatStore,
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
    const heartbeatStore = createSessionHeartbeatStore();
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn(), reportFailure: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId,
      heartbeatKey,
      ws,
      finalizeFailure,
      heartbeatStore,
      clientPingIntervalMs: 1000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });

    vi.advanceTimersByTime(2000);
    vi.setSystemTime(2500);
    heartbeatStore.recordServerActivity(heartbeatKey, Date.now());
    vi.advanceTimersByTime(3000);

    expect(finalizeFailure).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
    expect(heartbeatStore.readPingInterval(heartbeatKey)).not.toBeNull();
    expect(heartbeatStore.readPingInterval(sessionId)).toBeNull();
  });

  it('keeps only one heartbeat timer when multiple logical sessions share the same physical target', () => {
    vi.useFakeTimers();
    const heartbeatKey = 'target:mac-studio';
    const heartbeatStore = createSessionHeartbeatStore();
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const ws = { readyState: WebSocket.OPEN, close: vi.fn() } as any;

    startSocketHeartbeat({
      sessionId: 'session-a',
      heartbeatKey,
      ws,
      finalizeFailure,
      heartbeatStore,
      clientPingIntervalMs: 1000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });
    const firstTimer = heartbeatStore.readPingInterval(heartbeatKey);
    startSocketHeartbeat({
      sessionId: 'session-b',
      heartbeatKey,
      ws,
      finalizeFailure,
      heartbeatStore,
      clientPingIntervalMs: 1000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });

    expect(heartbeatStore.pingIntervalKeys()).toEqual([heartbeatKey]);
    expect(heartbeatStore.readPingInterval(heartbeatKey)).not.toBe(firstTimer);
    expect(heartbeatStore.readPingInterval('session-a')).toBeNull();
    expect(heartbeatStore.readPingInterval('session-b')).toBeNull();
  });

  it('clears stale tail-refresh markers together with head throttle state during socket cleanup prep', () => {
    const sessionId = 'session-1';
    const liveHeads = new Map([[sessionId, { revision: 5, latestEndIndex: 88, seenAt: 1 }]]);
    const sessionHeadStoreRef = {
      current: {
        clearLiveHead: (id: string) => {
          liveHeads.delete(id);
        },
      },
    };
    const sessionRevisionResetRef = { current: new Map([[sessionId, { revision: 4, latestEndIndex: 77, seenAt: 1 }]]) };
    const lastHeadRequestAtRef = { current: new Map([[sessionId, 123]]) };
    const tailRefreshStore = createSessionTailRefreshStore();
    tailRefreshStore.markPendingInputTailRefresh(sessionId, 3, 5);
    tailRefreshStore.markPendingConnectTailRefresh(sessionId);
    tailRefreshStore.markPendingResumeTailRefresh(sessionId);

    clearTailRefreshRuntime({
      sessionId,
      sessionHeadStoreRef,
      sessionRevisionResetRef,
      lastHeadRequestAtRef,
      tailRefreshStore,
    });

    expect(liveHeads.has(sessionId)).toBe(false);
    expect(sessionRevisionResetRef.current.has(sessionId)).toBe(false);
    expect(lastHeadRequestAtRef.current.has(sessionId)).toBe(false);
    expect(tailRefreshStore.hasPendingInputTailRefresh(sessionId)).toBe(false);
    expect(tailRefreshStore.hasPendingConnectTailRefresh(sessionId)).toBe(false);
    expect(tailRefreshStore.hasPendingResumeTailRefresh(sessionId)).toBe(false);
  });
});
