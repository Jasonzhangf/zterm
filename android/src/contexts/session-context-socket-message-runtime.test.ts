import { describe, expect, it, vi } from 'vitest';
import { handleSocketServerMessageRuntime } from './session-context-socket-message-runtime';
import { reduceSessionAction, type SessionManagerState } from './session-context-core';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Host, Session, SessionScheduleState, ServerMessage } from '../lib/types';

function makeHost(): Host {
  return {
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
  };
}

function makeSession(): Session {
  return {
    id: 'session-1',
    hostId: 'host-1',
    connectionName: 'Conn 1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    daemonHostId: 'daemon-host-1',
    sessionName: 'tmux-1',
    title: 'tmux-1',
    ws: null,
    state: 'connecting',
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

describe('session-context-socket-message-runtime connected truth', () => {
  it('keeps existing daemonHostId when connected payload omits it', () => {
    const state: SessionManagerState = {
      sessions: [makeSession()],
      activeSessionId: 'session-1',
      liveSessionIds: ['session-1'],
      liveSessionIdsExplicit: true,
      connectedCount: 0,
    };
    const stateRef = { current: state };
    const scheduleStatesRef = {
      current: {
        'session-1': makeScheduleState(),
      },
    };

    const updateSessionSync = (id: string, updates: Partial<Session>) => {
      stateRef.current = reduceSessionAction(stateRef.current, {
        type: 'UPDATE_SESSION',
        id,
        updates,
      });
    };

    handleSocketServerMessageRuntime({
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws: {} as any,
        debugScope: 'connect',
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      },
      msg: {
        type: 'connected',
        payload: {
          sessionId: 'session-1',
        },
      } as ServerMessage,
      refs: {
        stateRef,
        scheduleStatesRef,
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync,
    });

    expect(stateRef.current.sessions[0]?.daemonHostId).toBe('daemon-host-1');
    expect(stateRef.current.sessions[0]?.state).toBe('connected');
  });

  it('promotes daemonHostId when connected payload provides a new daemon identity', () => {
    const state: SessionManagerState = {
      sessions: [makeSession()],
      activeSessionId: 'session-1',
      liveSessionIds: ['session-1'],
      liveSessionIdsExplicit: true,
      connectedCount: 0,
    };
    const stateRef = { current: state };

    const updateSessionSync = (id: string, updates: Partial<Session>) => {
      stateRef.current = reduceSessionAction(stateRef.current, {
        type: 'UPDATE_SESSION',
        id,
        updates,
      });
    };

    handleSocketServerMessageRuntime({
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws: {} as any,
        debugScope: 'connect',
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      },
      msg: {
        type: 'connected',
        payload: {
          sessionId: 'session-1',
          daemonHostId: 'daemon-host-2',
        },
      } as ServerMessage,
      refs: {
        stateRef,
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync,
    });

    expect(stateRef.current.sessions[0]?.daemonHostId).toBe('daemon-host-2');
    expect(stateRef.current.sessions[0]?.state).toBe('connected');
  });

  it('does not advance head throttle timestamp when a buffer-sync payload arrives', () => {
    const state: SessionManagerState = {
      sessions: [{
        ...makeSession(),
        state: 'connected',
      }],
      activeSessionId: 'session-1',
      liveSessionIds: ['session-1'],
      liveSessionIdsExplicit: true,
      connectedCount: 0,
    };
    const lastHeadRequestAtRef = {
      current: new Map<string, number>([['session-1', 1234]]),
    };

    handleSocketServerMessageRuntime({
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws: {} as any,
        debugScope: 'connect',
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      },
      msg: {
        type: 'buffer-sync',
        payload: {
          revision: 2,
          startIndex: 0,
          endIndex: 1,
          cols: 80,
          rows: 24,
          cursorKeysApp: false,
          lines: [],
        },
      } as ServerMessage,
      refs: {
        stateRef: { current: state },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef,
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(lastHeadRequestAtRef.current.get('session-1')).toBe(1234);
  });

  it('treats tmux_session_killed as a terminal closed event instead of scheduling reconnect', () => {
    const onFailure = vi.fn();
    const onClosed = vi.fn();
    const ws = {} as any;

    handleSocketServerMessageRuntime({
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws,
        debugScope: 'connect',
        onConnected: vi.fn(),
        onFailure,
        onClosed,
      },
      msg: {
        type: 'error',
        payload: {
          message: 'tmux session killed',
          code: 'tmux_session_killed',
        },
      } as ServerMessage,
      refs: {
        stateRef: {
          current: {
            sessions: [makeSession()],
            activeSessionId: 'session-1',
          },
        },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(onFailure).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledWith('tmux session killed');
    expect(ws.onopen).toBeNull();
    expect(ws.onmessage).toBeNull();
    expect(ws.onerror).toBeNull();
    expect(ws.onclose).toBeNull();
  });
});
