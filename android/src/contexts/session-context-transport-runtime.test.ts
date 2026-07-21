import { describe, expect, it, vi } from 'vitest';
import {
  bindSessionTransportSocketLifecycle,
  bindTargetMuxTransportSocketLifecycleRuntime,
  ensureControlTransportForSessionOpen,
  handleTargetMuxServerFrameRuntime,
  handleControlTransportMessage,
} from './session-context-transport-runtime';
import { sendTerminalResizeRuntime } from './session-context-transport-lifecycle-runtime';
import {
  buildSessionConnectPayload,
  buildSessionOpenPayload,
  buildSessionResizePayload,
} from './session-context-transport-wire-runtime';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import type { ServerMessage } from '../lib/types';

function makeHost() {
  return {
    id: 'host-1',
    createdAt: 1,
    name: 'conn-1',
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: 'tmux-1',
    authType: 'password' as const,
    tags: [],
    pinned: false,
  };
}

function makeIntent(
  sessionId: string,
  openRequestId: string,
): PendingSessionTransportOpenIntent {
  return {
    sessionId,
    openRequestId,
    createdAt: 1,
    host: makeHost(),
    resolvedSessionName: 'tmux-1',
    debugScope: 'connect',
    finalizeFailure: vi.fn(),
    onConnected: vi.fn(),
  };
}

describe('handleControlTransportMessage', () => {
  it('falls back to legacy clientSessionId when matching a session-ticket from older daemon/client wire', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>([
        ['session-legacy', makeIntent('session-legacy', 'open-new-1')],
      ]),
    };
    const clearSessionHandshakeTimeout = vi.fn();
    const writeSessionTransportToken = vi.fn();
    const openSessionTransportByIntent = vi.fn();

    handleControlTransportMessage({
      sessionId: 'session-legacy',
      openSessionTransportByIntent,
      pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout,
      writeSessionTransportToken,
    }, {
      type: 'session-ticket',
      payload: {
        openRequestId: '',
        clientSessionId: 'session-legacy',
        sessionTransportToken: 'token-legacy',
        sessionName: 'tmux-1',
      },
    } as ServerMessage);

    expect(clearSessionHandshakeTimeout).toHaveBeenCalledWith('session-legacy');
    expect(writeSessionTransportToken).toHaveBeenCalledWith('session-legacy', 'token-legacy');
    expect(openSessionTransportByIntent).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-legacy' }),
    );
    expect(pendingSessionTransportOpenIntentsRef.current.has('session-legacy')).toBe(false);
  });

  it('fans out generic control error to all pending intents on the same target instead of only the anchor session', () => {
    const pendingSessionTransportOpenIntentsRef = {
      current: new Map<string, PendingSessionTransportOpenIntent>([
        ['session-1', makeIntent('session-1', 'open-1')],
        ['session-2', makeIntent('session-2', 'open-2')],
      ]),
    };
    const failPendingControlTargetIntents = vi.fn();

    handleControlTransportMessage({
      sessionId: 'session-1',
      openSessionTransportByIntent: null,
      pendingSessionTransportOpenIntentsRef,
      clearSessionHandshakeTimeout: vi.fn(),
      writeSessionTransportToken: vi.fn(),
      failPendingControlTargetIntents,
    }, {
      type: 'error',
      payload: {
        message: 'control transport error',
        code: 'control_failed',
      },
    } as ServerMessage);

    expect(failPendingControlTargetIntents).toHaveBeenCalledWith(
      'session-1',
      'control transport error',
      true,
    );
    expect(pendingSessionTransportOpenIntentsRef.current.size).toBe(2);
  });
});

describe('adaptive width wire guard', () => {
  it('does not request an adaptive lease in connect/open payloads without finite positive cols', () => {
    expect(buildSessionConnectPayload({
      host: makeHost(),
      resolvedSessionName: 'tmux-1',
      sessionId: 'session-1',
      openRequestId: 'open-1',
      sessionTransportToken: 'token-1',
      geometry: { widthMode: 'adaptive-phone', cols: undefined },
    })).toMatchObject({
      widthMode: 'mirror-fixed',
      cols: undefined,
      rows: undefined,
    });

    expect(buildSessionOpenPayload({
      host: makeHost(),
      resolvedSessionName: 'tmux-1',
      sessionId: 'session-1',
      openRequestId: 'open-1',
      geometry: { widthMode: 'adaptive-phone', cols: Number.NaN },
    })).toMatchObject({
      widthMode: 'mirror-fixed',
      cols: undefined,
      rows: undefined,
    });
  });

  it('keeps adaptive resize off the wire until finite positive cols exist', () => {
    expect(buildSessionResizePayload({
      widthMode: 'adaptive-phone',
      cols: undefined,
    })).toEqual({
      widthMode: 'mirror-fixed',
      cols: undefined,
      rows: undefined,
    });

    const sendSocketPayload = vi.fn();
    const writeRequestedTerminalGeometry = vi.fn();
    const sent = sendTerminalResizeRuntime({
      sessionId: 'session-1',
      ws: { readyState: WebSocket.OPEN } as any,
      sendSocketPayload,
      writeRequestedTerminalGeometry,
      widthMode: 'adaptive-phone',
      cols: undefined,
    });

    expect(sent).toBe(false);
    expect(writeRequestedTerminalGeometry).not.toHaveBeenCalled();
    expect(sendSocketPayload).not.toHaveBeenCalled();
  });

  it('sends adaptive lease requests when finite positive cols exist', () => {
    expect(buildSessionConnectPayload({
      host: makeHost(),
      resolvedSessionName: 'tmux-1',
      sessionId: 'session-1',
      openRequestId: 'open-1',
      sessionTransportToken: 'token-1',
      geometry: { widthMode: 'adaptive-phone', cols: 55.8 },
    })).toMatchObject({
      widthMode: 'adaptive-phone',
      cols: 55,
      rows: undefined,
    });

    expect(buildSessionResizePayload({
      widthMode: 'adaptive-phone',
      cols: 56.9,
    })).toEqual({
      widthMode: 'adaptive-phone',
      cols: 56,
      rows: undefined,
    });
  });
});

describe('bindSessionTransportSocketLifecycle', () => {
  it('ignores late events from a socket that is no longer the current active transport for the session', () => {
    const staleWs = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: 'stale socket' }),
    } as any;
    const currentWs = {
      getDiagnostics: () => ({ reason: 'current socket' }),
    } as any;
    const handleSocketServerMessage = vi.fn();
    const recordSessionRx = vi.fn();
    const finalizeFailure = vi.fn();

    bindSessionTransportSocketLifecycle({
      sessionId: 'session-1',
      host: makeHost(),
      resolvedSessionName: 'tmux-1',
      ws: staleWs,
      debugScope: 'reconnect',
      readActiveSessionId: () => 'session-1',
      readSessionTransportSocket: () => currentWs,
      sendSocketPayload: vi.fn(),
      connectMessagePayload: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      } as any,
      runtimeDebug: vi.fn(),
      flushRuntimeDebugLogs: vi.fn(),
      startSocketHeartbeat: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      clearSessionHandshakeTimeout: vi.fn(),
      setSessionHandshakeTimeout: vi.fn(),
      recordSessionRx,
      isSessionTransportActive: vi.fn(() => true),
      handleSocketServerMessage,
      finalizeFailure,
      onConnected: vi.fn(),
      sessionHandshakeTimeoutMs: 5000,
    });

    staleWs.onmessage?.({ data: JSON.stringify({ type: 'connected', payload: { sessionId: 'session-1' } }) });
    staleWs.onerror?.();
    staleWs.onclose?.();

    expect(recordSessionRx).not.toHaveBeenCalled();
    expect(handleSocketServerMessage).not.toHaveBeenCalled();
    expect(finalizeFailure).not.toHaveBeenCalled();
  });

  it('drops inactive buffer-sync before JSON.parse so hidden tabs do not spend parse time on live frames', () => {
    const ws = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const handleSocketServerMessage = vi.fn();
    const recordSessionRx = vi.fn();
    const runtimeDebug = vi.fn();

    bindSessionTransportSocketLifecycle({
      sessionId: 'session-1',
      host: makeHost(),
      resolvedSessionName: 'tmux-1',
      ws,
      debugScope: 'connect',
      readActiveSessionId: () => 'session-2',
      readSessionTransportSocket: () => ws,
      sendSocketPayload: vi.fn(),
      connectMessagePayload: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
      } as any,
      runtimeDebug,
      flushRuntimeDebugLogs: vi.fn(),
      startSocketHeartbeat: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      clearSessionHandshakeTimeout: vi.fn(),
      setSessionHandshakeTimeout: vi.fn(),
      recordSessionRx,
      isSessionTransportActive: vi.fn(() => false),
      handleSocketServerMessage,
      finalizeFailure: vi.fn(),
      onConnected: vi.fn(),
      sessionHandshakeTimeoutMs: 5000,
    });

    const payload = JSON.stringify({
      type: 'buffer-sync',
      payload: {
        revision: 8,
        startIndex: 0,
        endIndex: 100,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: Array.from({ length: 100 }, (_, i) => ({ i, t: `line-${i}` })),
      },
    });
    ws.onmessage?.({ data: payload });

    expect(recordSessionRx).toHaveBeenCalledWith('session-1', payload);
    expect(handleSocketServerMessage).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.ws.connect.buffer-sync.preparse-inactive-drop',
      expect.objectContaining({ sessionId: 'session-1' }),
    );
  });

  it('does not preparse-drop live visible pane buffer-sync when the pane is non-active but still visible', () => {
    const ws = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const handleSocketServerMessage = vi.fn();
    const recordSessionRx = vi.fn();
    const runtimeDebug = vi.fn();

    bindSessionTransportSocketLifecycle({
      sessionId: 'session-2',
      host: makeHost(),
      resolvedSessionName: 'tmux-2',
      ws,
      debugScope: 'connect',
      readActiveSessionId: () => 'session-1',
      readSessionTransportSocket: () => ws,
      sendSocketPayload: vi.fn(),
      connectMessagePayload: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-2',
      } as any,
      runtimeDebug,
      flushRuntimeDebugLogs: vi.fn(),
      startSocketHeartbeat: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      clearSessionHandshakeTimeout: vi.fn(),
      setSessionHandshakeTimeout: vi.fn(),
      recordSessionRx,
      isSessionTransportActive: vi.fn(() => false),
      shouldAcceptSessionLiveBuffer: vi.fn(() => true),
      handleSocketServerMessage,
      finalizeFailure: vi.fn(),
      onConnected: vi.fn(),
      sessionHandshakeTimeoutMs: 5000,
    });

    const payload = JSON.stringify({
      type: 'buffer-sync',
      payload: {
        revision: 9,
        startIndex: 80,
        endIndex: 104,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        lines: Array.from({ length: 24 }, (_, i) => ({ i: i + 80, t: `line-${i + 80}` })),
      },
    });
    ws.onmessage?.({ data: payload });

    expect(recordSessionRx).toHaveBeenCalledWith('session-2', payload);
    expect(handleSocketServerMessage).toHaveBeenCalledTimes(1);
    expect(handleSocketServerMessage.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        rawFrameBytes: new TextEncoder().encode(payload).byteLength,
      }),
    );
    expect(runtimeDebug).not.toHaveBeenCalledWith(
      'session.ws.connect.buffer-sync.preparse-inactive-drop',
      expect.anything(),
    );
  });
});

describe('handleTargetMuxServerFrameRuntime', () => {
  it('routes channel messages to the local session resolved from channelId', () => {
    const handleSocketServerMessage = vi.fn();
    const onConnected = vi.fn();
    const onFailure = vi.fn();
    const onClosed = vi.fn();
    const ws = { readyState: WebSocket.OPEN } as any;

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      rawFrameBytes: 123,
      frame: {
        type: 'mux-channel-message',
        payload: {
          channelId: 'channel-a',
          message: {
            type: 'buffer-head',
            payload: {
              revision: 7,
              latestEndIndex: 10,
            },
          } as any,
        },
      },
      resolveSessionIdForChannel: () => 'session-1',
      updateSessionTerminalChannelState: vi.fn(),
      handleSocketServerMessage,
      buildChannelCallbacks: () => ({ onConnected, onFailure, onClosed }),
      runtimeDebug: vi.fn(),
    });

    expect(handleSocketServerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        host: expect.objectContaining({ bridgeHost: '100.127.23.27' }),
        ws,
        debugScope: 'connect',
        rawFrameBytes: 123,
        onConnected,
        onFailure,
        onClosed,
      }),
      expect.objectContaining({ type: 'buffer-head' }),
    );
  });

  it('does not dispatch unknown channel messages into any session truth', () => {
    const handleSocketServerMessage = vi.fn();
    const runtimeDebug = vi.fn();

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'connect',
      frame: {
        type: 'mux-channel-message',
        payload: {
          channelId: 'missing-channel',
          message: { type: 'buffer-sync', payload: { revision: 1, lines: [] } } as any,
        },
      },
      resolveSessionIdForChannel: () => null,
      updateSessionTerminalChannelState: vi.fn(),
      handleSocketServerMessage,
      buildChannelCallbacks: vi.fn(),
      runtimeDebug,
    });

    expect(handleSocketServerMessage).not.toHaveBeenCalled();
    expect(runtimeDebug).toHaveBeenCalledWith(
      'session.mux.channel-message.unknown-channel',
      expect.objectContaining({ channelId: 'missing-channel' }),
    );
  });

  it('marks only the opened channel session as connected when channel-opened arrives', () => {
    const updateSessionTerminalChannelState = vi.fn();
    const onConnected = vi.fn();

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'reconnect',
      frame: {
        type: 'mux-channel-opened',
        payload: {
          channelId: 'channel-b',
          sessionName: 'tmux-b',
        },
      },
      resolveSessionIdForChannel: () => 'session-2',
      updateSessionTerminalChannelState,
      handleSocketServerMessage: vi.fn(),
      buildChannelCallbacks: () => ({
        onConnected,
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      }),
      runtimeDebug: vi.fn(),
    });

    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'open');
    expect(onConnected).toHaveBeenCalled();
  });

  it('marks a channel closed before routing a plain closed channel message into reconnect handling', () => {
    const updateSessionTerminalChannelState = vi.fn();
    const handleSocketServerMessage = vi.fn((_params, msg) => {
      expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-1', 'closed');
      expect(msg).toMatchObject({ type: 'closed' });
    });
    const onFailure = vi.fn();

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'reconnect',
      frame: {
        type: 'mux-channel-message',
        payload: {
          channelId: 'channel-a',
          message: {
            type: 'closed',
            payload: {
              reason: 'tmux session closed',
            },
          } as any,
        },
      },
      resolveSessionIdForChannel: () => 'session-1',
      updateSessionTerminalChannelState,
      handleSocketServerMessage,
      buildChannelCallbacks: () => ({
        onConnected: vi.fn(),
        onFailure,
        onClosed: vi.fn(),
      }),
      runtimeDebug: vi.fn(),
    });

    expect(handleSocketServerMessage).toHaveBeenCalledTimes(1);
  });
});

describe('bindTargetMuxTransportSocketLifecycleRuntime', () => {
  it('sends mux-hello on target open and flushes opening channels only after mux-ready', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      readSessionTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: (sessionId) => (
        sessionId === 'session-1'
          ? { cols: 90, widthMode: 'adaptive-phone' }
          : { widthMode: 'mirror-fixed' }
      ),
      getOpeningSessionTerminalChannelsForTarget: () => [
        {
          channelId: 'channel-a',
          sessionId: 'session-1',
          sessionName: 'tmux-a',
          targetKey: 'target-a',
          state: 'opening',
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
        {
          channelId: 'channel-b',
          sessionId: 'session-2',
          sessionName: 'tmux-b',
          targetKey: 'target-a',
          state: 'opening',
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
      ],
      setSessionTargetMuxReady: vi.fn(),
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
    });

    ws.onopen?.();

    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2])).toEqual({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'session-anchor',
      },
    });

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'mux-ready',
        payload: {
          version: 1,
          capabilities: {
            version: 1,
            channelEnvelope: true,
            targetMessages: true,
            boundedBodyScheduler: true,
          },
        },
      }),
    });

    expect(sendSocketPayload).toHaveBeenCalledTimes(3);
    expect(JSON.parse(sendSocketPayload.mock.calls[1][2])).toEqual({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-a',
        sessionName: 'tmux-a',
        cols: 90,
        widthMode: 'adaptive-phone',
      },
    });
    expect(JSON.parse(sendSocketPayload.mock.calls[2][2])).toEqual({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-b',
        sessionName: 'tmux-b',
        widthMode: 'mirror-fixed',
      },
    });
  });

  it('rejects invalid mux frames without routing them into session handlers', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const finalizeFailure = vi.fn();
    const handleTargetMuxServerFrame = vi.fn();

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      readSessionTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => null,
      getOpeningSessionTerminalChannelsForTarget: () => [],
      setSessionTargetMuxReady: vi.fn(),
      sendSocketPayload: vi.fn(),
      handleTargetMuxServerFrame,
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure,
    });

    ws.onmessage?.({ data: JSON.stringify({ type: 'buffer-sync', payload: {} }) });

    expect(handleTargetMuxServerFrame).not.toHaveBeenCalled();
    expect(finalizeFailure).toHaveBeenCalledWith('invalid terminal mux frame', true);
  });
});

describe('ensureControlTransportForSessionOpen', () => {
  it('reopens a stale connecting control transport instead of leaving new session opens hanging forever', () => {
    const intent = {
      ...makeIntent('session-1', 'open-1'),
      hostConfigPayload: {
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'tmux-1',
        openRequestId: 'open-1',
      },
    };
    const connectingSocket = {
      readyState: WebSocket.CONNECTING,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
      getDiagnostics: () => ({ reason: 'stuck connecting' }),
    } as any;
    const replacementSocket = {
      readyState: WebSocket.CONNECTING,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
      getDiagnostics: () => ({ reason: '' }),
    } as any;

    let currentSocket: any = connectingSocket;
    const setSessionHandshakeTimeout = vi.fn((_sessionId: string, callback: () => void) => {
      callback();
      return 1;
    });
    const buildTraversalSocketForHost = vi.fn(() => {
      currentSocket = replacementSocket;
      return replacementSocket;
    });
    const writeSessionTargetControlSocket = vi.fn((_sessionId: string, socket: any | null) => {
      currentSocket = socket;
    });

    ensureControlTransportForSessionOpen({
      intent: intent as any,
      readSessionTargetControlSocket: () => currentSocket,
      readSessionTargetRuntime: () => ({ sessionIds: ['session-1'] }),
      readSessionTargetKey: () => 'daemon:host-1',
      pendingSessionTransportOpenIntentsRef: { current: new Map([['session-1', intent]]) },
      sendSocketPayload: vi.fn(),
      clearSessionHandshakeTimeout: vi.fn(),
      setSessionHandshakeTimeout,
      failPendingControlTargetIntents: vi.fn(),
      buildTraversalSocketForHost,
      writeSessionTargetControlSocket,
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      recordControlTransportRxBytes: vi.fn(),
      handleControlTransportMessage: vi.fn(),
      cleanupControlSocket: vi.fn((_sessionId: string, shouldClose?: boolean) => {
        if (shouldClose) {
          currentSocket?.close?.();
        }
        currentSocket = null;
      }),
      sessionHandshakeTimeoutMs: 10,
    });

    expect(setSessionHandshakeTimeout).toHaveBeenCalled();
    expect(connectingSocket.close).toHaveBeenCalled();
    expect(buildTraversalSocketForHost).toHaveBeenCalledTimes(1);
    expect(writeSessionTargetControlSocket).toHaveBeenCalledWith('session-1', replacementSocket);
  });
});
