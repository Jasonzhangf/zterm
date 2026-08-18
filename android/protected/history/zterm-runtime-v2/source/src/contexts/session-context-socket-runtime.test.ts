import { describe, expect, it, vi, afterEach } from 'vitest';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import {
  CLIENT_TRANSPORT_HEARTBEAT_INTERVAL_MS,
  CLIENT_TRANSPORT_HEARTBEAT_MAX_MISSES,
  clearTailRefreshRuntime,
  startSocketHeartbeat,
} from './session-context-socket-runtime';
import { createSessionHeartbeatStore } from '../lib/session-heartbeat-store';

describe('session-context-socket-runtime heartbeat lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses a thirty-second target transport heartbeat policy by default', () => {
    expect(CLIENT_TRANSPORT_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(CLIENT_TRANSPORT_HEARTBEAT_MAX_MISSES).toBe(3);
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

  it('delegates stale-heartbeat failure without mutating route health in the heartbeat observer', () => {
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

    expect(reportFailure).not.toHaveBeenCalled();
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
    expect(sendSocketPayload).toHaveBeenNthCalledWith(
      1,
      sessionId,
      ws,
      JSON.stringify({ type: 'mux-ping', payload: { sentAt: 1000 } }),
    );
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
    const retainedError = {
      error: 'invalid-frame-metadata' as const,
      revision: 11,
      repair: {
        status: 'dispatched' as const,
        range: { startIndex: 0, endIndex: 2 },
      },
    };
    const bufferFrameAssemblyRef = { current: new Map([[sessionId, {
      pending: {
        frameKey: '12:0:2:100:2',
        revision: 12,
        frameStartIndex: 0,
        frameEndIndex: 2,
        frameChunkCount: 2,
        generatedAt: 100,
        firstReceivedAt: 100,
        retainedBytes: 10,
        chunks: new Map(),
      },
      error: retainedError,
      repairDispatchedRevisions: [11],
    }]]) };
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
      bufferFrameAssemblyRef,
    });

    expect(liveHeads.has(sessionId)).toBe(false);
    expect(sessionRevisionResetRef.current.get(sessionId)).toEqual({
      revision: 4,
      latestEndIndex: 77,
      seenAt: 1,
    });
    expect(lastHeadRequestAtRef.current.has(sessionId)).toBe(false);
    expect(bufferFrameAssemblyRef.current.get(sessionId)).toEqual({
      pending: null,
      error: retainedError,
      repairDispatchedRevisions: [11],
    });
    expect(tailRefreshStore.hasPendingInputTailRefresh(sessionId)).toBe(false);
    expect(tailRefreshStore.hasPendingConnectTailRefresh(sessionId)).toBe(false);
    expect(tailRefreshStore.hasPendingResumeTailRefresh(sessionId)).toBe(false);
  });

  // 2026-08-09 BUG #1: heartbeat 计时器在 ws.readyState !== OPEN 期间冻结 consecutiveMisses,
  // 导致 socket 重新 attach 后立刻被旧 state 误判 timeout 并触发死循环 reconnect
  // 红测预期：socket 从 CLOSING → OPEN 后，前 90s 内不能触发 finalizeFailure / ws.close
  describe('long-voice-commit transport resilience (BUG #1 regression)', () => {
    it('resets consecutive misses when ws flips from CLOSING back to OPEN during a long voice commit', () => {
      vi.useFakeTimers();
      const sessionId = 'session-voice';
      const heartbeatStore = createSessionHeartbeatStore();
      const sendSocketPayload = vi.fn();
      const finalizeFailure = vi.fn();
      const ws = { readyState: WebSocket.CLOSING, close: vi.fn() } as any;

      // 1. start heartbeat while socket is still CLOSING (e.g. mid lifecycle close)
      startSocketHeartbeat({
        sessionId, ws, finalizeFailure, heartbeatStore,
        clientPingIntervalMs: 30_000, maxConsecutiveMisses: 3, sendSocketPayload,
      });

      // 2. simulate voice commit during close window: 80s pass but socket still CLOSING
      vi.advanceTimersByTime(80_000);

      // 3. socket recovers, voice commit completes, socket flips to OPEN
      ws.readyState = WebSocket.OPEN;
      heartbeatStore.recordServerActivity(sessionId, Date.now());

      // 4. now advance another 80s (well within 90s grace) — finalizeFailure MUST NOT fire
      vi.advanceTimersByTime(80_000);

      expect(finalizeFailure).not.toHaveBeenCalled();
      expect(ws.close).not.toHaveBeenCalled();
      // ping should resume sending
      expect(sendSocketPayload.mock.calls.length).toBeGreaterThan(0);
    });

    it('does not let pre-close consecutiveMisses leak into a fresh socket after a transport swap', () => {
      vi.useFakeTimers();
      const sessionId = 'session-swap';
      const heartbeatStore = createSessionHeartbeatStore();
      const sendSocketPayload = vi.fn();
      const finalizeFailure = vi.fn();
      const wsOld = { readyState: WebSocket.OPEN, close: vi.fn() } as any;
      const wsNew = { readyState: WebSocket.OPEN, close: vi.fn() } as any;

      // 1. start heartbeat on old socket; old socket accrues 2 misses
      startSocketHeartbeat({
        sessionId, ws: wsOld, finalizeFailure, heartbeatStore,
        clientPingIntervalMs: 30_000, maxConsecutiveMisses: 3, sendSocketPayload,
      });
      vi.advanceTimersByTime(60_000);
      expect(finalizeFailure).not.toHaveBeenCalled();

      // 2. voice commit triggers ws close + transport swap; old ws is gone
      wsOld.readyState = WebSocket.CLOSED;

      // 3. caller installs new ws without re-priming heartbeat state
      // (this is the realistic path: a new socket replaces the old one but
      // startSocketHeartbeat might be called again with a fresh lastObservedServerActivityAt)
      heartbeatStore.recordServerActivity(sessionId, Date.now());

      // 4. swap to new ws and restart heartbeat
      startSocketHeartbeat({
        sessionId, ws: wsNew, finalizeFailure, heartbeatStore,
        clientPingIntervalMs: 30_000, maxConsecutiveMisses: 3, sendSocketPayload,
      });

      // 5. advance 60s while new socket receives server activity — must NOT be flagged
      vi.advanceTimersByTime(60_000);
      // simulate one server activity on the new socket so heartbeat does not time out
      heartbeatStore.recordServerActivity(sessionId, Date.now());
      vi.advanceTimersByTime(30_000);

      expect(finalizeFailure).not.toHaveBeenCalled();
      expect(wsNew.close).not.toHaveBeenCalled();
    });
  });
});
