import { describe, expect, it, vi, afterEach } from 'vitest';
import { startSocketHeartbeat } from './session-context-socket-runtime';

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
});
