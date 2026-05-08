import { describe, expect, it, vi } from 'vitest';
import { createSessionMessageOrchestrationRuntime } from './session-context-message-orchestration-runtime';
import { createSessionBufferState } from '../lib/terminal-buffer';
import { createSessionHeadStore } from '../lib/session-head-store';
import type { ServerMessage, Session, SessionScheduleState } from '../lib/types';

function makeSession(sessionId = 'session-1'): Session {
  return {
    id: sessionId,
    hostId: 'host-1',
    connectionName: 'Conn 1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    daemonHostId: 'daemon-host-1',
    sessionName: 'tmux-1',
    title: 'tmux-1',
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    daemonHeadRevision: 0,
    daemonHeadEndIndex: 0,
    buffer: createSessionBufferState({
      lines: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      revision: 0,
      cacheLines: 1000,
    }),
  };
}

function makeScheduleState(): SessionScheduleState {
  return {
    sessionName: 'tmux-1',
    jobs: [],
    loading: false,
    error: undefined,
    lastEvent: undefined,
  };
}

describe('session-context-message-orchestration-runtime visible live buffer gate', () => {
  it('forwards shouldAcceptSessionLiveBuffer so visible non-active panes can accept bootstrap live buffer before live ids settle', () => {
    const session = makeSession();
    const settleSessionPullState = vi.fn();
    const summarizeBufferPayload = vi.fn(() => ({}));
    const runtimeDebug = vi.fn();

    const runtime = createSessionMessageOrchestrationRuntime({
      refs: {
        stateRef: {
          current: {
            sessions: [session],
            activeSessionId: 'session-2',
          },
        },
        scheduleStatesRef: {
          current: {
            'session-1': makeScheduleState(),
          },
        },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
        sessionVisibleRangeRef: { current: new Map() },
        sessionBufferHeadsRef: { current: new Map() },
        sessionPullStateRef: { current: new Map() },
        pendingInputTailRefreshRef: { current: new Map() },
        pendingConnectTailRefreshRef: { current: new Set() },
        pendingResumeTailRefreshRef: { current: new Set() },
        lastConnectedBaselineAtRef: { current: new Map() },
        connectedBaselineBurstGuardRef: { current: new Set() },
        sessionRevisionResetRef: { current: new Map() },
        sessionBufferStoreRef: {
          current: {
            commitBuffer: vi.fn(() => true),
          },
        },
        sessionHeadStoreRef: { current: createSessionHeadStore() },
        sessionDebugMetricsStoreRef: {
          current: {
            recordRefreshRequest: vi.fn(),
          },
        },
        pendingSessionTransportOpenIntentsRef: { current: new Map() },
        manualCloseRef: { current: new Set() },
      },
      readSessionTransportSocket: vi.fn(() => ({ readyState: WebSocket.OPEN } as any)),
      readSessionBufferSnapshot: vi.fn(() => session.buffer),
      clearSessionPullState: vi.fn(),
      sendSocketPayload: vi.fn(),
      resolveTerminalRefreshCadence: () => ({ headTickMs: 33, headStalePingMs: 120, pullRequestStaleMs: 500 }),
      resolveSessionCacheLines: vi.fn(() => 1000),
      summarizeBufferPayload,
      runtimeDebug,
      isSessionTransportActive: vi.fn(() => false),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      scheduleSessionRenderCommit: vi.fn(),
      settleSessionPullState,
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      applyTransportDiagnostics: vi.fn(),
      updateSessionSync: vi.fn(),
      incrementConnectedSync: vi.fn(),
      cleanupSocket: vi.fn(),
      writeSessionTransportToken: vi.fn(),
    });

    runtime.handleSocketServerMessage({
      sessionId: 'session-1',
      host: {
        id: 'host-1',
        createdAt: 1,
        name: 'Conn 1',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-1',
        relayHostId: 'daemon-host-1',
        sessionName: 'tmux-1',
        authType: 'password',
        authToken: 'token-1',
        tags: [],
        pinned: false,
      },
      ws: {} as any,
      debugScope: 'connect',
      onConnected: vi.fn(),
      onFailure: vi.fn(),
      onClosed: vi.fn(),
    }, {
      type: 'buffer-sync',
      payload: {
        revision: 7,
        startIndex: 120,
        endIndex: 180,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: Array.from({ length: 60 }, (_, index) => ({
          i: 120 + index,
          t: `row-${120 + index}`,
        })),
      },
    } as ServerMessage);

    expect(settleSessionPullState).toHaveBeenCalledTimes(1);
    expect(summarizeBufferPayload.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(runtimeDebug).not.toHaveBeenCalledWith(
      'session.ws.connect.buffer-sync.inactive-drop',
      expect.anything(),
    );
  });
});
