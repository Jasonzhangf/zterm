import { describe, expect, it, vi } from 'vitest';
import { handleSocketServerMessageRuntime } from './session-context-socket-message-runtime';
import { reduceSessionAction, type SessionManagerState } from './session-context-core';
import { createSessionBufferState } from '../lib/terminal-buffer';
import { drainRuntimeDebugEntries } from '../lib/runtime-debug';
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
  it('records client-rx trace bytes from raw received frame metadata', () => {
    drainRuntimeDebugEntries();
    handleSocketServerMessageRuntime({
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws: {} as any,
        debugScope: 'connect',
        rawFrameBytes: 1234,
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      },
      msg: {
        type: 'buffer-sync',
        payload: {
          revision: 9,
          startIndex: 0,
          endIndex: 1,
          cols: 80,
          rows: 24,
          cursorKeysApp: false,
          lines: [],
        },
      } as ServerMessage,
      refs: {
        stateRef: { current: {
          sessions: [{ ...makeSession(), state: 'connected' }],
          activeSessionId: 'session-1',
          } },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    const traceEntry = drainRuntimeDebugEntries().find((entry) => (
      entry.scope === 'terminal.performance.trace'
    ));
    expect(traceEntry).toBeTruthy();
    expect(JSON.parse(traceEntry?.payload || '{}')).toMatchObject({
      sessionId: 'session-1',
      traceId: 'session-1:9',
      mirrorRevision: 9,
      stage: 'client-rx',
      bytes: 1234,
    });
  });

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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
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

  it('records reliable input capability from the daemon connected payload', () => {
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
          capabilities: {
            reliableInput: { version: 1 },
          },
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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync,
    });

    expect(stateRef.current.sessions[0]?.reliableInputSupported).toBe(true);
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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
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

  it('treats tmux_session_unavailable as a retryable temporary error instead of a closed tab event', () => {
    const onFailure = vi.fn();
    const onClosed = vi.fn();
    const ws = {
      onopen: vi.fn(),
      onmessage: vi.fn(),
      onerror: vi.fn(),
      onclose: vi.fn(),
    } as any;

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
          message: 'tmux session temporarily unavailable',
          code: 'tmux_session_unavailable',
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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(onClosed).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith('tmux session temporarily unavailable', true);
    expect(ws.onopen).not.toBeNull();
    expect(ws.onmessage).not.toBeNull();
    expect(ws.onerror).not.toBeNull();
    expect(ws.onclose).not.toBeNull();
  });

  it('treats plain closed messages as retryable transport failures, not terminal session close truth', () => {
    const onFailure = vi.fn();
    const onClosed = vi.fn();
    const ws = {
      onopen: vi.fn(),
      onmessage: vi.fn(),
      onerror: vi.fn(),
      onclose: vi.fn(),
    } as any;

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
        type: 'closed',
        payload: {
          reason: 'websocket closed',
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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(onClosed).not.toHaveBeenCalled();
    expect(onFailure).toHaveBeenCalledWith('websocket closed', true);
    expect(ws.onopen).not.toBeNull();
    expect(ws.onmessage).not.toBeNull();
    expect(ws.onerror).not.toBeNull();
    expect(ws.onclose).not.toBeNull();
  });

  it('routes schedule-error into schedule state without terminal transport failure', () => {
    const onFailure = vi.fn();
    const setScheduleStateForSession = vi.fn();

    handleSocketServerMessageRuntime({
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws: {} as any,
        debugScope: 'connect',
        onConnected: vi.fn(),
        onFailure,
        onClosed: vi.fn(),
      },
      msg: {
        type: 'schedule-error',
        payload: {
          sessionName: 'tmux-1',
          operation: 'delete',
          jobId: 'missing-job',
          code: 'schedule_job_not_found',
          message: 'Schedule job no longer exists',
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
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession,
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(onFailure).not.toHaveBeenCalled();
    expect(setScheduleStateForSession).toHaveBeenCalledWith('session-1', expect.any(Function));
    const reducer = setScheduleStateForSession.mock.calls[0][1] as (current: SessionScheduleState) => SessionScheduleState;
    expect(reducer({ ...makeScheduleState(), loading: true }).error).toBe('Schedule job no longer exists');
    expect(reducer({ ...makeScheduleState(), loading: true }).loading).toBe(false);
  });
});

describe('session-context-socket-message-runtime remote window messages', () => {
  it('routes remote window catalog responses to the remote window message runtime only', () => {
    const fileTransferDispatch = vi.fn();
    const remoteWindowDispatch = vi.fn();

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
        type: 'remote-window-targets-response',
        payload: {
          requestId: 'rw-1',
          targets: [],
        },
      } as ServerMessage,
      refs: {
        stateRef: { current: { sessions: [makeSession()], activeSessionId: 'session-1' } },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: fileTransferDispatch },
      remoteWindowMessageRuntime: { dispatch: remoteWindowDispatch },
      updateSessionSync: vi.fn(),
    });

    expect(remoteWindowDispatch).toHaveBeenCalledWith({
      type: 'remote-window-targets-response',
      payload: {
        requestId: 'rw-1',
        targets: [],
      },
    });
    expect(fileTransferDispatch).not.toHaveBeenCalled();
  });

  it('routes remote window stream control messages to the remote window message runtime only', () => {
    const fileTransferDispatch = vi.fn();
    const remoteWindowDispatch = vi.fn();
    const baseOptions = {
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws: {} as any,
        debugScope: 'connect' as const,
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      },
      refs: {
        stateRef: { current: { sessions: [makeSession()], activeSessionId: 'session-1' } },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug: vi.fn(),
      isSessionTransportActive: vi.fn(() => true),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: fileTransferDispatch },
      remoteWindowMessageRuntime: { dispatch: remoteWindowDispatch },
      updateSessionSync: vi.fn(),
    };

    for (const msg of [
      {
        type: 'remote-window-stream-started',
        payload: {
          requestId: 'rw-start-1',
          streamId: 'stream-1',
          targetId: 'pane-1',
          answer: { type: 'answer', sdp: 'answer-sdp' },
          capture: {
            source: 'ScreenCaptureKit',
            frameWidth: 640,
            frameHeight: 360,
            frameRate: 5,
            targetKind: 'iterm2-pane',
          },
          transport: { kind: 'webrtc-video' },
        },
      },
      {
        type: 'remote-window-stream-ice-candidate',
        payload: {
          streamId: 'stream-1',
          candidate: { candidate: 'candidate:remote' },
        },
      },
      {
        type: 'remote-window-stream-status',
        payload: {
          streamId: 'stream-1',
          phase: 'streaming',
          framesSent: 2,
        },
      },
      {
        type: 'remote-window-input-result',
        payload: {
          requestId: 'rw-input-1',
          streamId: 'stream-1',
          targetId: 'pane-1',
          accepted: true,
        },
      },
    ] satisfies ServerMessage[]) {
      handleSocketServerMessageRuntime({
        ...baseOptions,
        msg,
      });
    }

    expect(remoteWindowDispatch).toHaveBeenCalledTimes(4);
    expect(remoteWindowDispatch.mock.calls.map((call) => call[0].type)).toEqual([
      'remote-window-stream-started',
      'remote-window-stream-ice-candidate',
      'remote-window-stream-status',
      'remote-window-input-result',
    ]);
    expect(fileTransferDispatch).not.toHaveBeenCalled();
  });
});

describe('session-context-socket-message-runtime inactive live buffer gate', () => {
  it('drops inactive buffer-sync before payload summarization/apply so hidden tabs do not parse live frames', () => {
    const summarizeBufferPayload = vi.fn(() => ({}));
    const applyIncomingBufferSync = vi.fn();
    const settleSessionPullState = vi.fn();
    const runtimeDebug = vi.fn();

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
      } as ServerMessage,
      refs: {
        stateRef: {
          current: {
            sessions: [{
              ...makeSession(),
              state: 'connected',
            }],
            activeSessionId: 'session-2',
          },
        },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState,
      runtimeDebug,
      isSessionTransportActive: vi.fn(() => false),
      shouldAcceptSessionLiveBuffer: vi.fn(() => false),
      summarizeBufferPayload,
      applyIncomingBufferSync,
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(settleSessionPullState).not.toHaveBeenCalled();
    expect(summarizeBufferPayload).not.toHaveBeenCalled();
    expect(applyIncomingBufferSync).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.ws.connect.buffer-sync.inactive-drop',
      expect.objectContaining({
        sessionId: 'session-1',
        activeSessionId: 'session-2',
        lineCount: 60,
        revision: 7,
      }),
    );
  });

  it('drops inactive buffer-head before it can move local head truth backwards', () => {
    const handleBufferHead = vi.fn();
    const onConnected = vi.fn();
    const runtimeDebug = vi.fn();

    handleSocketServerMessageRuntime({
      params: {
        sessionId: 'session-1',
        host: makeHost(),
        ws: {} as any,
        debugScope: 'connect',
        onConnected,
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      },
      msg: {
        type: 'buffer-head',
        payload: {
          revision: 3,
          latestEndIndex: 24,
          availableStartIndex: 0,
          availableEndIndex: 24,
        },
      } as ServerMessage,
      refs: {
        stateRef: {
          current: {
            sessions: [{
              ...makeSession(),
              state: 'connected',
            }],
            activeSessionId: 'session-2',
          },
        },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState: vi.fn(),
      runtimeDebug,
      isSessionTransportActive: vi.fn(() => false),
      shouldAcceptSessionLiveBuffer: vi.fn(() => false),
      summarizeBufferPayload: vi.fn(() => ({})),
      applyIncomingBufferSync: vi.fn(),
      handleBufferHead,
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(onConnected).not.toHaveBeenCalled();
    expect(handleBufferHead).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.ws.connect.buffer-head.inactive-drop',
      expect.objectContaining({
        sessionId: 'session-1',
        activeSessionId: 'session-2',
        revision: 3,
      }),
    );
  });

  it('accepts bootstrap buffer-sync before live ids settle when local window is still empty', () => {
    const summarizeBufferPayload = vi.fn(() => ({}));
    const applyIncomingBufferSync = vi.fn();
    const settleSessionPullState = vi.fn();

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
      } as ServerMessage,
      refs: {
        stateRef: {
          current: {
            sessions: [{
              ...makeSession(),
              state: 'connected',
            }],
            activeSessionId: 'session-2',
          },
        },
        scheduleStatesRef: { current: { 'session-1': makeScheduleState() } },
        lastHeadRequestAtRef: { current: new Map() },
        lastPongAtRef: { current: new Map() },
      },
      settleSessionPullState,
      runtimeDebug: vi.fn(),
      isSessionTransportActive: vi.fn(() => false),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      summarizeBufferPayload,
      applyIncomingBufferSync,
      handleBufferHead: vi.fn(),
      setScheduleStateForSession: vi.fn(),
      setSessionTitleSync: vi.fn(),
      fileTransferMessageRuntime: { dispatch: vi.fn() },
      updateSessionSync: vi.fn(),
    });

    expect(settleSessionPullState).toHaveBeenCalledTimes(1);
    expect(summarizeBufferPayload).toHaveBeenCalledTimes(1);
    expect(applyIncomingBufferSync).toHaveBeenCalledTimes(1);
  });

});
