import { describe, expect, it, vi } from 'vitest';
import {
  bindSessionTransportSocketLifecycle,
  bindTargetMuxTransportSocketLifecycleRuntime,
  handleTargetMuxServerFrameRuntime,
} from './session-context-transport-runtime';
import { sendTerminalResizeRuntime } from './session-context-transport-lifecycle-runtime';
import {
  buildSessionConnectPayload,
  buildSessionResizePayload,
} from './session-context-transport-wire-runtime';
import {
  createSessionTransportRuntimeStore,
  getTargetTerminalTransport,
  getSessionTransportTargetKey,
  removeSessionTransportRuntime,
  setSessionTargetTerminalTransport,
  upsertSessionTransportRuntime,
} from '../lib/session-transport-runtime';

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
  it('settles mux target management frames through the target message handler', () => {
    const handleTargetMuxMessage = vi.fn(() => true);
    const runtimeDebug = vi.fn();

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'connect',
      frame: {
        type: 'mux-target-message',
        payload: {
          requestId: 'tmux-request-1',
          message: {
            type: 'sessions',
            payload: { sessions: ['zterm'] },
          } as any,
        },
      },
      resolveSessionIdForChannel: () => null,
      updateSessionTerminalChannelState: vi.fn(),
      handleSocketServerMessage: vi.fn(),
      buildChannelCallbacks: vi.fn(),
      handleTargetMuxMessage,
      runtimeDebug,
    });

    expect(handleTargetMuxMessage).toHaveBeenCalledWith({
      requestId: 'tmux-request-1',
      message: {
        type: 'sessions',
        payload: { sessions: ['zterm'] },
      },
    });
    expect(runtimeDebug).not.toHaveBeenCalledWith(
      'session.mux.target-frame',
      expect.anything(),
    );
  });

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

  it('marks only the opened channel as allocated without projecting terminal connected', () => {
    const updateSessionTerminalChannelState = vi.fn();
    const onChannelAllocated = vi.fn();
    const onConnected = vi.fn();
    const sendSocketPayload = vi.fn();

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
      readSessionTerminalChannelBodySubscribed: () => false,
      updateSessionTerminalChannelState,
      sendSocketPayload,
      handleSocketServerMessage: vi.fn(),
      buildChannelCallbacks: () => ({
        onChannelAllocated,
        onConnected,
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      }),
      runtimeDebug: vi.fn(),
    });

    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'open');
    expect(onChannelAllocated).toHaveBeenCalledTimes(1);
    expect(onConnected).not.toHaveBeenCalled();
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2])).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-b',
        message: {
          type: 'body-subscription',
          payload: { version: 1, subscribed: false },
        },
      },
    });
  });

  it('settles terminal connected only from a real channel connected message', () => {
    const handleSocketServerMessage = vi.fn((_params, msg) => {
      expect(msg).toEqual({
        type: 'connected',
        payload: {
          daemonHostId: 'mac-studio',
          capabilities: { reliableInput: { version: 1 } },
        },
      });
    });
    const onConnected = vi.fn();

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'reconnect',
      frame: {
        type: 'mux-channel-message',
        payload: {
          channelId: 'channel-b',
          message: {
            type: 'connected',
            payload: {
              daemonHostId: 'mac-studio',
              capabilities: { reliableInput: { version: 1 } },
            },
          } as any,
        },
      },
      resolveSessionIdForChannel: () => 'session-2',
      readSessionTerminalChannelBodySubscribed: () => true,
      updateSessionTerminalChannelState: vi.fn(),
      sendSocketPayload: vi.fn(),
      handleSocketServerMessage,
      buildChannelCallbacks: () => ({
        onConnected,
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      }),
      runtimeDebug: vi.fn(),
    });

    expect(handleSocketServerMessage).toHaveBeenCalledTimes(1);
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
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: (sessionId) => (
        sessionId === 'session-1'
          ? { cols: 90, widthMode: 'adaptive-phone' }
          : { widthMode: 'mirror-fixed' }
      ),
      getOpeningTerminalChannelsForTarget: () => [
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
      setTargetMuxReady: vi.fn(),
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
        bodySubscribed: true,
      },
    });
    expect(JSON.parse(sendSocketPayload.mock.calls[2][2])).toEqual({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-b',
        sessionName: 'tmux-b',
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      },
    });
  });

  it('starts target heartbeat on mux target open and records target activity from mux frames', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();
    const startSocketHeartbeat = vi.fn();
    const recordTargetServerActivity = vi.fn();
    const recordTargetPong = vi.fn();
    const finalizeFailure = vi.fn();

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => null,
      getOpeningTerminalChannelsForTarget: () => [],
      setTargetMuxReady: vi.fn(),
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure,
      startSocketHeartbeat,
      recordTargetServerActivity,
      recordTargetPong,
    } as any);

    ws.onopen?.();

    expect(startSocketHeartbeat).toHaveBeenCalledTimes(1);
    expect(startSocketHeartbeat).toHaveBeenCalledWith('session-anchor', ws, expect.any(Function), {
      heartbeatKey: 'target:mac-studio',
    });
    startSocketHeartbeat.mock.calls[0][2]('heartbeat server activity timeout', true);
    expect(finalizeFailure).toHaveBeenCalledWith('heartbeat server activity timeout', true);

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

    expect(recordTargetServerActivity).toHaveBeenCalledWith('target:mac-studio');

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'mux-pong',
        payload: {
          sentAt: 1000,
          receivedAt: 1001,
        },
      }),
    });

    expect(recordTargetServerActivity).toHaveBeenCalledTimes(2);
    expect(recordTargetPong).toHaveBeenCalledWith('target:mac-studio');
  });

  it('accepts target probe activity after the original anchor session is removed', () => {
    const store = createSessionTransportRuntimeStore();
    const host = makeHost();
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: vi.fn(),
      close: vi.fn(),
      reportFailure: vi.fn(),
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    upsertSessionTransportRuntime(store, 'session-anchor', host);
    const targetKey = getSessionTransportTargetKey(store, 'session-anchor')!;
    setSessionTargetTerminalTransport(store, 'session-anchor', ws);
    const recordTargetServerActivity = vi.fn();
    const recordTargetPong = vi.fn();
    const finalizeFailure = vi.fn();

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey,
      targetHeartbeatKey: `target:${targetKey}`,
      host,
      ws,
      debugScope: 'connect',
      readTargetTerminalSocket: (key) => getTargetTerminalTransport(store, key),
      readRequestedTerminalGeometry: () => null,
      getOpeningTerminalChannelsForTarget: () => [],
      setTargetMuxReady: vi.fn(),
      sendSocketPayload: vi.fn(),
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure,
      recordTargetServerActivity,
      recordTargetPong,
    });
    removeSessionTransportRuntime(store, 'session-anchor');

    ws.onmessage?.({
      data: JSON.stringify({
        type: 'mux-pong',
        payload: { sentAt: 1000, receivedAt: 1001 },
      }),
    });

    expect(getTargetTerminalTransport(store, targetKey)).toBe(ws);
    expect(recordTargetServerActivity).toHaveBeenCalledWith(`target:${targetKey}`);
    expect(recordTargetPong).toHaveBeenCalledWith(`target:${targetKey}`);
    expect(finalizeFailure).not.toHaveBeenCalled();
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
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => null,
      getOpeningTerminalChannelsForTarget: () => [],
      setTargetMuxReady: vi.fn(),
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
