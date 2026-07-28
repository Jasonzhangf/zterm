// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createSessionHeartbeatStore } from '../lib/session-heartbeat-store';
import { createSessionReconnectStore } from '../lib/session-reconnect-store';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session } from '../lib/types';
import { createSessionMessageAssemblies } from './session-context-message-assemblies';

function makeSession(sessionId: string): Session {
  return {
    id: sessionId,
    hostId: `host-${sessionId}`,
    connectionName: `conn-${sessionId}`,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: `tmux-${sessionId}`,
    title: sessionId,
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
  };
}

describe('session-context-message-assemblies cadence', () => {
  it('uses session-aware cadence for repeated head refresh requests', () => {
    const sessionId = 'session-1';
    const session = makeSession(sessionId);
    const buffer = createSessionBufferState({
      lines: ['alpha'],
      startIndex: 0,
      endIndex: 1,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 1,
      cols: 80,
      rows: 24,
      revision: 1,
      cacheLines: 1000,
    });
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const resolveTerminalRefreshCadence = vi.fn(() => ({
      headTickMs: 16,
      pullRequestStaleMs: 1200,
      minTailRefreshGapMs: 16,
      readingSyncDelayMs: 16,
    }));
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const runtime = createSessionMessageAssemblies({
        stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
        scheduleStatesRef: { current: {} },
        sessionVisibleRangeRef: { current: new Map() },
        sessionPullStateRef: { current: new Map() },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferStoreRef: { current: { commitBuffer: vi.fn(() => false) } },
        sessionHeadStoreRef: { current: { setHead: vi.fn(() => false), setLiveHead: vi.fn(() => false), getLiveHead: vi.fn(() => null), clearLiveHead: vi.fn() } },
        sessionDebugMetricsStoreRef: { current: { recordRefreshRequest: vi.fn() } },
        tailRefreshStore: createSessionTailRefreshStore(),
        lastHeadRequestAtRef: { current: new Map() },
        reconnectStore: createSessionReconnectStore(),
        heartbeatStore: createSessionHeartbeatStore(),
        lastConnectedBaselineAtRef: { current: new Map() },
        connectedBaselineBurstGuardRef: { current: new Set() },
        bufferFrameAssemblyRef: { current: new Map() },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        fileTransferMessageRuntimeRef: { current: { dispatch: vi.fn() } },
        remoteWindowMessageRuntimeRef: { current: { dispatch: vi.fn() } },
        readSessionTransportSocket: () => ws,
        daemonConnection: {
          readSessionResource: vi.fn(() => ({ socket: ws } as any)),
          readSessionSocket: vi.fn(() => ws),
          readOpenSessionSocket: vi.fn(() => ws),
          sendSessionMessage: vi.fn(() => true),
          sendSessionRaw: vi.fn(() => true),
        } as any,
        readSessionBufferSnapshot: () => buffer,
        sendSocketPayload,
        clearSessionPullState: vi.fn(),
        settleSessionPullState: vi.fn(),
        scheduleSessionRenderCommit: vi.fn(),
        isSessionTransportActive: () => true,
        shouldAcceptSessionLiveBuffer: () => true,
        resolveSessionCacheLines: () => 1000,
        resolveTerminalRefreshCadence,
        setScheduleStateForSession: vi.fn(),
        setSessionTitleSync: vi.fn(),
        updateSessionSync: vi.fn(),
        writeSessionTransportToken: vi.fn(() => null),
        cleanupSocket: vi.fn(),
        applyTransportDiagnostics: vi.fn(),
        incrementConnectedSync: vi.fn(),
      });

      expect(runtime.requestSessionBufferHead(sessionId)).toBe(true);
      now = 1_020;
      expect(runtime.requestSessionBufferHead(sessionId)).toBe(true);

      expect(resolveTerminalRefreshCadence).toHaveBeenCalledWith(sessionId);
      expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
