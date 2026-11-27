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
import { buildSessionMuxChannelOpenFrame } from './session-context-transport-runtime';
import {
  createSessionTransportRuntimeStore,
  getSessionTargetTransportRuntime,
  getSessionTransportHost,
  getTargetTerminalTransport,
  getSessionTransportTargetKey,
  removeSessionTransportRuntime,
  setSessionTargetTerminalMuxReady,
  setSessionTargetTerminalTransport,
  setTargetTerminalTransport,
  upsertSessionTransportRuntime,
} from '../lib/session-transport-runtime';
import {
  ensureSessionTerminalChannel,
  getOpeningSessionTerminalChannelsForTarget,
  getSessionTerminalChannel,
  updateSessionTerminalChannelState,
} from '../lib/terminal-channel-mux-runtime';
import {
  handleTargetMuxTransportFailureRuntime,
  retireRejectedExactChannelRuntime,
  resolveMuxChannelClosedWithControlStatusRuntime,
} from './session-context-transport-orchestration-runtime';
import { openSessionMuxChannelByIntentRuntime } from './session-context-transport-open-runtime';
import { createPendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import { getSessionIdForTerminalChannel, removeSessionTerminalChannel } from '../lib/terminal-channel-mux-runtime';
import type { Host } from '../lib/types';

function makeHost(): Host {
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

type ExactSessionTransportHost = Host & {
  expectedSessionIdentity?: string;
};

// Pure in-process socket: no timers, listeners outside this object, or product resources.
function makeAttemptHarness(invalidHost?: ExactSessionTransportHost) {
  const store = createSessionTransportRuntimeStore();
  const hosts = new Map<string, ExactSessionTransportHost>([
    ['exact', { ...makeHost(), terminalBackend: 'tmux', expectedSessionIdentity: 'opaque/pane 雪' }],
    ['legacy', makeHost()],
    ...(invalidHost ? [['invalid', invalidHost] as [string, ExactSessionTransportHost]] : []),
  ]);
  for (const [id, host] of hosts) {
    upsertSessionTransportRuntime(store, id, host);
    ensureSessionTerminalChannel(store.terminalChannels, id);
  }
  const targetKey = getSessionTransportTargetKey(store, 'exact')!;
  const ws = { readyState: WebSocket.OPEN, onopen: null, onmessage: null, onerror: null, onclose: null,
    getDiagnostics: () => ({ reason: '' }) } as any;
  setTargetTerminalTransport(store, targetKey, ws);
  const read = (id: string) => getSessionTerminalChannel(store.terminalChannels, id);
  const write = (id: string, state: any) => updateSessionTerminalChannelState(store.terminalChannels, id, state);
  const pending = { current: new Map<string, ReturnType<typeof createPendingSessionTransportOpenIntent>>() };
  const finalizeFailure = vi.fn();
  const allocated = vi.fn();
  const dispatched = vi.fn();
  const teardown = vi.fn();
  const timeout = vi.fn();
  const status = vi.fn();
  const heartbeat = vi.fn();
  const send = vi.fn();
  const reject = (details: any) => retireRejectedExactChannelRuntime({
    ...details, ws, readSessionTerminalChannel: read, writeSessionTerminalChannelState: write,
    pendingSessionTransportOpenIntentsRef: pending, clearSessionHandshakeTimeout: timeout,
    sendSocketPayload: send, onSessionTransportTeardown: teardown, updateSessionSync: vi.fn(),
    emitSessionStatus: status, runtimeDebug: vi.fn(),
  });
  const open = (
    id: string,
    sender: Parameters<typeof openSessionMuxChannelByIntentRuntime>[0]['sendSocketPayload'] = send,
    geometry: Parameters<typeof openSessionMuxChannelByIntentRuntime>[0]['readRequestedTerminalGeometry'] = () => null,
    onClosed?: (reason?: string, code?: string) => void,
  ) => {
    const intent = createPendingSessionTransportOpenIntent({ sessionId: id, host: hosts.get(id)!,
      resolvedSessionName: 'tmux-1', debugScope: 'connect', onHandshakeFailure: finalizeFailure,
      onClosed,
      clearHandshakeTimeout: () => timeout(id),
      finalizeSocketFailureBaseline: ({ markCompleted }) => ({ shouldContinue: markCompleted(), manualClosed: false }),
    });
    pending.current.set(id, intent);
    openSessionMuxChannelByIntentRuntime({ intent, daemonConnection: { readSessionTargetSocket: () => ws } as any,
      readSessionTargetTerminalSocket: () => ws, isSessionTargetMuxReady: () => ready,
      ensureSessionTerminalChannel: (sid, opts) => ensureSessionTerminalChannel(store.terminalChannels, sid, opts),
      updateSessionTerminalChannelState: write, readRequestedTerminalGeometry: geometry,
      sendSocketPayload: sender, onInvalidOpenIntent: reject, runtimeDebug: vi.fn(),
    });
  };
  let ready = false;
  bindTargetMuxTransportSocketLifecycleRuntime({ sessionId: 'exact', targetKey, targetHeartbeatKey: 'target:test',
    host: hosts.get('exact')!, ws, debugScope: 'connect', readTargetTerminalSocket: () => getTargetTerminalTransport(store, targetKey),
    readRequestedTerminalGeometry: () => null, readPrioritySessionId: () => invalidHost ? 'invalid' : 'exact',
    readSessionTerminalChannel: read, writeSessionTerminalChannelState: write,
    getOpeningTerminalChannelsForTarget: (_key: string, priority: string) => getOpeningSessionTerminalChannelsForTarget(store.terminalChannels, targetKey, priority),
    readSessionTransportHost: (id: string) => hosts.get(id) || null,
    setTargetMuxReady: (_key: string, value: boolean) => { ready = value; }, sendSocketPayload: send,
    onInvalidOpenIntent: reject,
    handleTargetMuxServerFrame: (frame: any) => handleTargetMuxServerFrameRuntime({ frame, ws, anchorSessionId: 'exact',
      host: hosts.get('exact')!, debugScope: 'connect', resolveSessionIdForChannel: (cid) => getSessionIdForTerminalChannel(store.terminalChannels, targetKey, cid),
      readSessionTransportHost: (id) => hosts.get(id) || null, readSessionTerminalChannel: read,
      readSessionTerminalChannelBodySubscribed: (id) => read(id)?.bodySubscribed ?? null,
      updateSessionTerminalChannelState: write, sendSocketPayload: send, handleSocketServerMessage: dispatched,
      buildChannelCallbacks: (id) => ({
        onChannelAllocated: () => allocated(id),
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: (reason, code) => {
          const intent = pending.current.get(id);
          if (!intent) {
            return;
          }
          pending.current.delete(id);
          intent.onClosed?.(reason, code);
        },
      }),
      onExactChannelRejected: reject, runtimeDebug: vi.fn(),
    }), applyTransportDiagnostics: vi.fn(), startSocketHeartbeat: heartbeat, runtimeDebug: vi.fn(), finalizeFailure,
  } as any);
  const receive = (frame: unknown) => ws.onmessage({ data: JSON.stringify(frame) });
  const ack = (id: string, stableId?: string) => receive({ type: 'mux-channel-opened', payload: { channelId: id, sessionName: 'tmux-1', ...(stableId ? { stableId } : {}) } });
  const frames = () => send.mock.calls.map(([, , data]) => JSON.parse(data as string));
  const start = () => { ws.onopen(); receive({ type: 'mux-ready', payload: { version: 1, capabilities: { version: 1, channelEnvelope: true, targetMessages: true, boundedBodyScheduler: true } } }); };
  return { store, targetKey, ws, read, pending, open, receive, ack, frames, start, send, allocated, dispatched, teardown, timeout, status, heartbeat, finalizeFailure, ready: () => ready };
}

describe('exact open attempt isolation through mux wire', () => {
  it.each(['send', 'builder'])('keeps unexpected %s failures on the retryable owner', (stage) => {
    const h = makeAttemptHarness(); h.start();
    const failure = () => { throw new Error(`${stage} failed`); };
    h.open('exact', stage === 'send' ? failure : h.send, () => stage === 'builder' ? { get cols(): number { return failure(); } } : null);
    expect(h.finalizeFailure).toHaveBeenCalledWith(`${stage} failed`, true, 'handshake');
    expect(h.status).not.toHaveBeenCalled();
    expect(h.teardown).not.toHaveBeenCalled();
  });
  it.each(['blank identity', 'missing backend'])('isolates invalid first batch row: %s', (kind) => {
    const h = makeAttemptHarness({ ...makeHost(), expectedSessionIdentity: kind === 'blank identity' ? '  ' : 'pane', ...(kind === 'blank identity' ? { terminalBackend: 'tmux' as const } : {}) });
    h.open('invalid');
    h.start();
    expect(h.finalizeFailure.mock.calls, JSON.stringify(h.frames())).toEqual([]);
    expect(h.read('invalid')?.state).toBe('closed');
    expect(h.pending.current.has('invalid')).toBe(false);
    expect(h.timeout).toHaveBeenCalledWith('invalid');
    expect(h.teardown).toHaveBeenCalledTimes(1);
    expect(h.status).toHaveBeenCalledTimes(1);
    expect(h.frames().filter(f => f.payload?.channelId === 'channel:invalid')).toEqual([]);
    expect(h.frames().filter(f => f.type === 'mux-channel-open').map(f => f.payload.channelId)).toEqual(['channel:exact', 'channel:legacy']);
    h.ack('channel:exact', 'opaque/pane 雪'); h.ack('channel:legacy');
    for (const id of ['exact', 'legacy']) h.receive({ type: 'mux-channel-message', payload: { channelId: `channel:${id}`, message: { type: 'terminal-title', payload: { title: id } } } });
    expect(h.allocated.mock.calls).toEqual([['exact'], ['legacy']]);
    expect(h.dispatched).toHaveBeenCalledTimes(2);
    expect(h.frames().filter(f => f.type === 'mux-channel-message')).toHaveLength(2);
    expect(h.ready()).toBe(true); expect(h.heartbeat).toHaveBeenCalledTimes(1);
    expect(getTargetTerminalTransport(h.store, h.targetKey)).toBe(h.ws);
  });

  it.each(['rejected', 'removed'])('does not admit a reopened attempt with a retired ACK: %s', (retirement) => {
    const h = makeAttemptHarness(); h.start();
    const oldId = h.read('exact')!.channelId;
    h.ack(oldId, 'wrong');
    expect(h.read('exact')?.state).toBe('closed');
    if (retirement === 'removed') removeSessionTerminalChannel(h.store.terminalChannels, 'exact');
    h.open('exact');
    const newId = h.frames().filter(f => f.type === 'mux-channel-open').at(-1).payload.channelId;
    h.ack(oldId, 'opaque/pane 雪');
    expect(h.allocated.mock.calls, JSON.stringify({ oldId, newId, frames: h.frames(), state: h.read('exact')?.state })).toEqual([]);
    expect(newId).not.toBe(oldId);
    expect(h.read('exact')?.state).toBe('opening');
    console.info('exact attempt routing', { retirement, oldId, newId, stateAfterOldAck: h.read('exact')?.state });
    expect(getSessionIdForTerminalChannel(h.store.terminalChannels, h.targetKey, oldId)).toBeNull();
    expect(getSessionIdForTerminalChannel(h.store.terminalChannels, h.targetKey, newId)).toBe('exact');
    h.ack(newId, 'opaque/pane 雪');
    expect(h.allocated.mock.calls).toEqual([['exact']]);
    expect(h.frames().filter(f => f.type === 'mux-channel-message').map(f => f.payload.channelId)).toEqual([newId]);
    h.ack('channel:legacy'); expect(h.allocated).toHaveBeenCalledWith('legacy');
    expect(h.finalizeFailure).not.toHaveBeenCalled();
    expect(getTargetTerminalTransport(h.store, h.targetKey)).toBe(h.ws);
  });

  it('reopens the current exact channel without the legacy name catalog or a sibling', () => {
    const h = makeAttemptHarness(); h.start();
    h.ack('channel:exact', 'opaque/pane 雪');
    expect(h.allocated).toHaveBeenCalledWith('exact');
    h.ack('channel:legacy');

    const reconnectHost = {
      ...makeHost(),
      terminalBackend: 'tmux' as const,
      expectedSessionIdentity: 'opaque/pane 雪',
    };
    const queryTargetSessions = vi.fn(async () => null);
    const settledReopenedIntent = vi.fn((reason?: string, code?: string) => {
      h.teardown('exact', reason);
      return code;
    });
    const scheduleReconnect = vi.fn(() => h.open('exact', h.send, () => null, settledReopenedIntent));
    updateSessionTerminalChannelState(h.store.terminalChannels, 'exact', 'closed');
    resolveMuxChannelClosedWithControlStatusRuntime({
      sessionId: 'exact',
      sessionName: reconnectHost.sessionName,
      channelId: h.read('exact')!.channelId,
      reason: 'mux data channel closed',
      expectedSessionIdentity: reconnectHost.expectedSessionIdentity,
      shouldReconnectNow: true,
      queryTargetSessions,
      readSessionTerminalChannel: h.read,
      onTransportTeardown: h.teardown,
      scheduleReconnect,
      updateSessionSync: vi.fn(),
      emitSessionStatus: h.status,
      runtimeDebug: vi.fn(),
    });

    expect(queryTargetSessions).not.toHaveBeenCalled();
    expect(scheduleReconnect).toHaveBeenCalledWith('exact', 'mux data channel closed', true);
    expect(h.teardown).toHaveBeenCalledWith('exact', 'mux data channel closed');
    const reopen = h.frames().filter((frame) => frame.type === 'mux-channel-open').at(-1);
    expect(reopen?.payload).toMatchObject({
      sessionName: 'tmux-1',
      backend: 'tmux',
      expectedSessionIdentity: 'opaque/pane 雪',
      existingOnly: true,
    });
    expect(h.read('exact')?.state).toBe('opening');
    expect(h.read('legacy')?.state).toBe('open');
    expect(h.finalizeFailure).not.toHaveBeenCalled();

    const reopenChannelId = h.read('exact')!.channelId;
    const legacyChannelId = h.read('legacy')!.channelId;
    const framesBeforeRejection = h.frames().length;
    expect(h.pending.current.has('exact')).toBe(true);
    h.receive({
      type: 'mux-channel-closed',
      payload: {
        channelId: reopenChannelId,
        reason: 'tmux session identity is no longer present',
        code: 'session_identity_mismatch',
      },
    });

    expect(settledReopenedIntent).toHaveBeenCalledWith(
      'tmux session identity is no longer present',
      'session_identity_mismatch',
    );
    expect(h.pending.current.has('exact')).toBe(false);
    expect(h.read('exact')?.state).toBe('closed');
    expect(h.read('legacy')).toMatchObject({
      channelId: legacyChannelId,
      state: 'open',
      bodySubscribed: true,
    });
    expect(h.frames().slice(framesBeforeRejection).filter((frame) => (
      frame.type === 'mux-channel-open'
      || frame.payload?.channelId === legacyChannelId
    ))).toEqual([]);
    expect(h.teardown.mock.calls.every(([sessionId]) => sessionId === 'exact')).toBe(true);
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

describe('terminal backend mux identity', () => {
  it('forwards the selected Herdr backend on channel open', () => {
    expect(buildSessionMuxChannelOpenFrame({
      channel: {
        channelId: 'herdr-channel',
        sessionName: 'herdr-session',
        bodySubscribed: true,
      },
      sessionName: 'herdr-session',
      host: {
        terminalBackend: 'herdr',
      },
    })).toMatchObject({
      type: 'mux-channel-open',
      payload: {
        channelId: 'herdr-channel',
        sessionName: 'herdr-session',
        backend: 'herdr',
        bodySubscribed: true,
      },
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

  it('admits an exact channel only when the current opening reply carries the same opaque identity', () => {
    const updateSessionTerminalChannelState = vi.fn();
    const onChannelAllocated = vi.fn();
    const sendSocketPayload = vi.fn();
    const onExactChannelRejected = vi.fn();
    const exactIdentity = 'rex:pane/a.b+c 雪';

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'connect',
      frame: {
        type: 'mux-channel-opened',
        payload: {
          channelId: 'channel-exact',
          sessionName: 'same-label',
          stableId: exactIdentity,
        },
      },
      resolveSessionIdForChannel: () => 'session-exact',
      readSessionTransportHost: () => ({
        ...makeHost(),
        sessionName: 'same-label',
        terminalBackend: 'tmux',
        expectedSessionIdentity: exactIdentity,
      }),
      readSessionTerminalChannel: () => ({
        channelId: 'channel-exact',
        sessionId: 'session-exact',
        sessionName: 'same-label',
        targetKey: 'target-a',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      }),
      readSessionTerminalChannelBodySubscribed: () => true,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      updateSessionTerminalChannelState,
      sendSocketPayload,
      handleSocketServerMessage: vi.fn(),
      buildChannelCallbacks: () => ({
        onChannelAllocated,
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      }),
      onExactChannelRejected,
      runtimeDebug: vi.fn(),
    });

    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-exact', 'open');
    expect(onChannelAllocated).toHaveBeenCalledTimes(1);
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(onExactChannelRejected).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['different', 'rex:pane/other'],
  ])('rejects a %s exact reply identity without allocating or subscribing', (_case, stableId) => {
    const onChannelAllocated = vi.fn();
    const onExactChannelRejected = vi.fn();
    const sendSocketPayload = vi.fn();
    const updateSessionTerminalChannelState = vi.fn();
    const exactIdentity = 'rex:pane/a.b+c 雪';

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'reconnect',
      frame: {
        type: 'mux-channel-opened',
        payload: {
          channelId: 'channel-exact',
          sessionName: 'same-label',
          ...(stableId ? { stableId } : {}),
        },
      },
      resolveSessionIdForChannel: () => 'session-exact',
      readSessionTransportHost: () => ({
        ...makeHost(),
        sessionName: 'same-label',
        terminalBackend: 'tmux',
        expectedSessionIdentity: exactIdentity,
      }),
      readSessionTerminalChannel: () => ({
        channelId: 'channel-exact',
        sessionId: 'session-exact',
        sessionName: 'same-label',
        targetKey: 'target-a',
        state: 'opening',
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      }),
      readSessionTerminalChannelBodySubscribed: () => true,
      updateSessionTerminalChannelState,
      sendSocketPayload,
      handleSocketServerMessage: vi.fn(),
      buildChannelCallbacks: () => ({
        onChannelAllocated,
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      }),
      onExactChannelRejected,
      runtimeDebug: vi.fn(),
    });

    expect(onExactChannelRejected).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-exact',
      channelId: 'channel-exact',
    }));
    expect(onChannelAllocated).not.toHaveBeenCalled();
    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(updateSessionTerminalChannelState).not.toHaveBeenCalledWith('session-exact', 'open');
  });

  it.each(['opening', 'open', 'closed'] as const)(
    'dispatches exact-channel terminal data only after admission (%s)',
    (state) => {
      const handleSocketServerMessage = vi.fn();
      const channelId = 'channel-exact';
      const message = { type: 'title', payload: 'selected pane' } as const;
      const options = {
        anchorSessionId: 'session-anchor',
        host: makeHost(),
        ws: { readyState: WebSocket.OPEN } as any,
        debugScope: 'reconnect' as const,
        resolveSessionIdForChannel: () => 'session-exact',
        readSessionTransportHost: () => ({
          terminalBackend: 'tmux' as const,
          expectedSessionIdentity: 'opaque-exact-id',
        }),
        readSessionTerminalChannel: () => ({ channelId, state }),
        updateSessionTerminalChannelState: vi.fn(),
        handleSocketServerMessage,
        buildChannelCallbacks: () => ({
          onConnected: vi.fn(),
          onFailure: vi.fn(),
          onClosed: vi.fn(),
        }),
        runtimeDebug: vi.fn(),
      };

      handleTargetMuxServerFrameRuntime({
        ...options,
        frame: { type: 'mux-channel-message', payload: { channelId, message } },
      });
      expect(handleSocketServerMessage).toHaveBeenCalledTimes(state === 'open' ? 1 : 0);

      handleSocketServerMessage.mockClear();
      handleTargetMuxServerFrameRuntime({
        ...options,
        frame: {
          type: 'mux-error',
          payload: { channelId, code: 'mux_channel_mismatch', message: 'target unavailable' },
        },
      });
      expect(handleSocketServerMessage).toHaveBeenCalledTimes(state === 'closed' ? 0 : 1);
    },
  );

  it('rewrites body=true over the same transport when the opened channel is body-subscribed', () => {
    const updateSessionTerminalChannelState = vi.fn();
    const onChannelAllocated = vi.fn();
    const sendSocketPayload = vi.fn();
    const sameTransport = { readyState: WebSocket.OPEN, targetKey: 'mac-studio' } as any;

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: sameTransport,
      debugScope: 'reconnect',
      frame: {
        type: 'mux-channel-opened',
        payload: {
          channelId: 'channel-b',
          sessionName: 'tmux-b',
        },
      },
      resolveSessionIdForChannel: () => 'session-2',
      readSessionTerminalChannelBodySubscribed: () => true,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      updateSessionTerminalChannelState,
      sendSocketPayload,
      handleSocketServerMessage: vi.fn(),
      buildChannelCallbacks: () => ({
        onChannelAllocated,
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed: vi.fn(),
      }),
      runtimeDebug: vi.fn(),
    });

    // Reattached resume must restore body demand on the very same physical
    // transport, not a fresh socket; a suppressed-background channel that
    // returns to foreground writes subscribed:true back to the existing ws.
    expect(updateSessionTerminalChannelState).toHaveBeenCalledWith('session-2', 'open');
    expect(onChannelAllocated).toHaveBeenCalledTimes(1);
    expect(sendSocketPayload).toHaveBeenCalledWith(
      'session-2',
      sameTransport,
      expect.stringContaining('"type":"body-subscription"'),
    );
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2])).toMatchObject({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-b',
        message: {
          type: 'body-subscription',
          payload: { version: 1, subscribed: true },
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

  it('forwards the mux channel close code to channel callbacks', () => {
    const onClosed = vi.fn();

    handleTargetMuxServerFrameRuntime({
      anchorSessionId: 'session-anchor',
      host: makeHost(),
      ws: { readyState: WebSocket.OPEN } as any,
      debugScope: 'reconnect',
      frame: {
        type: 'mux-channel-closed',
        payload: {
          channelId: 'channel-a',
          reason: 'body subscription released',
          code: 'no_body_demand',
        },
      },
      resolveSessionIdForChannel: () => 'session-1',
      updateSessionTerminalChannelState: vi.fn(),
      handleSocketServerMessage: vi.fn(),
      buildChannelCallbacks: () => ({
        onConnected: vi.fn(),
        onFailure: vi.fn(),
        onClosed,
      }),
      runtimeDebug: vi.fn(),
    });

    expect(onClosed).toHaveBeenCalledWith('body subscription released', 'no_body_demand');
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
  it('reconnect debugScope re-attaches the service-owned transport instead of binding', async () => {
    const serviceSocket = {
      readyState: WebSocket.OPEN,
      transportOwnership: 'service',
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws: serviceSocket,
      debugScope: 'reconnect',
      readTargetTerminalSocket: () => serviceSocket,
      readRequestedTerminalGeometry: () => null,
      getOpeningTerminalChannelsForTarget: () => [],
      readPrioritySessionId: () => 'session-anchor',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
      setTargetMuxReady: vi.fn(),
      sendSocketPayload: vi.fn(),
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      startSocketHeartbeat: vi.fn(),
      startMuxHandshakeTimeout: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
    });

    serviceSocket.onopen?.();

    // A service-owned socket is only projected back; no JS hello or heartbeat.
    expect(serviceSocket.onopen).toBeTruthy();
  });

  it('does not send JS mux hello or start JS heartbeat for a service-owned socket', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      transportOwnership: 'service',
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();
    const startSocketHeartbeat = vi.fn();
    const startMuxHandshakeTimeout = vi.fn();

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
      readPrioritySessionId: () => 'session-anchor',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
      setTargetMuxReady: vi.fn(),
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      startSocketHeartbeat,
      startMuxHandshakeTimeout,
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
    });

    ws.onopen?.();

    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(startSocketHeartbeat).not.toHaveBeenCalled();
    expect(startMuxHandshakeTimeout).not.toHaveBeenCalled();
  });

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
      readPrioritySessionId: () => 'session-1',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
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
    expect(Object.fromEntries(
      sendSocketPayload.mock.calls.slice(1).map(([, , data]) => {
        const frame = JSON.parse(data);
        return [frame.payload.channelId, frame.payload.sessionName];
      }),
    )).toEqual({
      'channel-a': 'tmux-a',
      'channel-b': 'tmux-b',
    });
  });

  it('routes each opening channel to its own backend and open options after mux-ready', () => {
    const run = (seedHost: ReturnType<typeof makeHost>) => {
      const ws = {
        readyState: WebSocket.OPEN,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        getDiagnostics: () => ({ reason: '' }),
      } as any;
      const sendSocketPayload = vi.fn();
      const hosts = new Map<string, ReturnType<typeof makeHost>>([
        ['session-1', {
          ...makeHost(),
          sessionName: 'tmux-a',
          terminalBackend: 'tmux' as const,
          autoCommand: 'tmux-command',
        }],
        ['session-2', {
          ...makeHost(),
          sessionName: 'herdr-a',
          terminalBackend: 'herdr' as const,
          autoCommand: 'herdr-command',
        }],
      ]);

      const bindOptions: Parameters<typeof bindTargetMuxTransportSocketLifecycleRuntime>[0] = {
        sessionId: 'session-anchor',
        targetKey: 'mac-studio',
        targetHeartbeatKey: 'target:mac-studio',
        host: seedHost,
        ws,
        debugScope: 'connect',
        readTargetTerminalSocket: () => ws,
        readRequestedTerminalGeometry: (sessionId) => (
          sessionId === 'session-1'
            ? { cols: 90, rows: 30, widthMode: 'adaptive-phone' }
            : { widthMode: 'mirror-fixed' }
        ),
        readPrioritySessionId: () => 'session-1',
        readSessionTerminalChannel: () => null,
        writeSessionTerminalChannelState: vi.fn(),
        getOpeningTerminalChannelsForTarget: () => [
          {
            channelId: 'channel-tmux',
            sessionId: 'session-1',
            sessionName: 'tmux-a',
            targetKey: 'mac-studio',
            state: 'opening',
            bodySubscribed: false,
            openedAt: 1,
            closedAt: null,
          },
          {
            channelId: 'channel-herdr',
            sessionId: 'session-2',
            sessionName: 'herdr-a',
            targetKey: 'mac-studio',
            state: 'opening',
            bodySubscribed: true,
            openedAt: 1,
            closedAt: null,
          },
        ],
        readSessionTransportHost: (sessionId) => hosts.get(sessionId) || null,
        setTargetMuxReady: vi.fn(),
        sendSocketPayload,
        handleTargetMuxServerFrame: vi.fn(),
        applyTransportDiagnostics: vi.fn(),
        runtimeDebug: vi.fn(),
        finalizeFailure: vi.fn(),
      };
      bindTargetMuxTransportSocketLifecycleRuntime(bindOptions);

      ws.onopen?.();
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

      return sendSocketPayload.mock.calls.slice(1).map(([, , data]) => JSON.parse(data as string));
    };

    const expectedFrames = [
      {
        type: 'mux-channel-open',
        payload: {
          channelId: 'channel-tmux',
          sessionName: 'tmux-a',
          backend: 'tmux',
          autoCommand: 'tmux-command',
          cols: 90,
          rows: 30,
          widthMode: 'adaptive-phone',
          bodySubscribed: false,
        },
      },
      {
        type: 'mux-channel-open',
        payload: {
          channelId: 'channel-herdr',
          sessionName: 'herdr-a',
          backend: 'herdr',
          autoCommand: 'herdr-command',
          widthMode: 'mirror-fixed',
          bodySubscribed: true,
        },
      },
    ];

    expect(run({ ...makeHost(), terminalBackend: 'tmux', autoCommand: 'seed-command' })).toEqual(expectedFrames);
    expect(run({ ...makeHost(), terminalBackend: 'herdr', autoCommand: 'seed-command' })).toEqual(expectedFrames);
  });

  it('preserves each exact identity on first open and a legacy same-label sibling', () => {
    const run = (prioritySessionId: string, openingChannelIds: string[]) => {
      const ws = {
        readyState: WebSocket.OPEN,
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        getDiagnostics: () => ({ reason: '' }),
      } as any;
      const sendSocketPayload = vi.fn();
      const hosts = new Map<string, ExactSessionTransportHost>([
        ['session-a', {
          ...makeHost(),
          id: 'host-a',
          sessionName: 'same-label',
          terminalBackend: 'tmux',
          expectedSessionIdentity: 'rex:pane/a.b+c 雪',
        }],
        ['session-b', {
          ...makeHost(),
          id: 'host-b',
          sessionName: 'same-label',
          terminalBackend: 'herdr',
          expectedSessionIdentity: 'rex:pane/a.b+d 雪',
        }],
        ['session-legacy', {
          ...makeHost(),
          id: 'host-legacy',
          sessionName: 'same-label',
          terminalBackend: 'tmux',
        }],
      ]);
      const channels = new Map(openingChannelIds.map((sessionId) => [sessionId, {
        channelId: `channel-${sessionId}`,
        sessionId,
        sessionName: 'same-label',
        targetKey: 'mac-studio',
        state: 'opening' as const,
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      }]));

      bindTargetMuxTransportSocketLifecycleRuntime({
        sessionId: 'session-a',
        targetKey: 'mac-studio',
        targetHeartbeatKey: 'target:mac-studio',
        host: hosts.get('session-a')!,
        ws,
        debugScope: 'connect',
        readTargetTerminalSocket: () => ws,
        readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
        readPrioritySessionId: () => prioritySessionId,
        readSessionTerminalChannel: () => null,
        writeSessionTerminalChannelState: vi.fn(),
        readSessionTransportHost: (sessionId) => hosts.get(sessionId) || null,
        getOpeningTerminalChannelsForTarget: () => openingChannelIds.map((sessionId) => channels.get(sessionId)!),
        setTargetMuxReady: vi.fn(),
        sendSocketPayload,
        handleTargetMuxServerFrame: vi.fn(),
        applyTransportDiagnostics: vi.fn(),
        runtimeDebug: vi.fn(),
        finalizeFailure: vi.fn(),
      });

      ws.onopen?.();
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

      return Object.fromEntries(sendSocketPayload.mock.calls.slice(1).map(([, , data]) => {
        const frame = JSON.parse(data as string);
        return [frame.payload.channelId, frame.payload];
      }));
    };

    const expected = {
      'channel-session-a': {
        channelId: 'channel-session-a',
        sessionName: 'same-label',
        backend: 'tmux',
        expectedSessionIdentity: 'rex:pane/a.b+c 雪',
        existingOnly: true,
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      },
      'channel-session-b': {
        channelId: 'channel-session-b',
        sessionName: 'same-label',
        backend: 'herdr',
        expectedSessionIdentity: 'rex:pane/a.b+d 雪',
        existingOnly: true,
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      },
      'channel-session-legacy': {
        channelId: 'channel-session-legacy',
        sessionName: 'same-label',
        backend: 'tmux',
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      },
    };

    expect(run('session-a', ['session-a', 'session-b', 'session-legacy'])).toEqual(expected);
    expect(run('session-b', ['session-legacy', 'session-b', 'session-a'])).toEqual(expected);
  });

  it('skips an opening channel without a session Host instead of inheriting the seed Host', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const setTargetMuxReady = vi.fn();

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: { ...makeHost(), terminalBackend: 'herdr', autoCommand: 'seed-command' },
      ws,
      debugScope: 'connect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      readPrioritySessionId: () => 'session-1',
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
      getOpeningTerminalChannelsForTarget: () => [
        {
          channelId: 'channel-missing-host',
          sessionId: 'session-removed',
          sessionName: 'removed-a',
          targetKey: 'mac-studio',
          state: 'opening',
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
        {
          channelId: 'channel-live',
          sessionId: 'session-1',
          sessionName: 'live-a',
          targetKey: 'mac-studio',
          state: 'opening',
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
      ],
      readSessionTransportHost: (sessionId) => (
        sessionId === 'session-1'
          ? { ...makeHost(), sessionName: 'live-a', terminalBackend: 'tmux' }
          : null
      ),
      setTargetMuxReady,
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure,
    });

    ws.onopen?.();
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

    expect(setTargetMuxReady).toHaveBeenCalledWith('mac-studio', true);
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    const [openSessionId, openSocket, openData] = sendSocketPayload.mock.calls[1];
    expect(openSessionId).toBe('session-1');
    expect(openSocket).toBe(ws);
    expect(JSON.parse(openData as string)).toEqual({
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-live',
        sessionName: 'live-a',
        backend: 'tmux',
        widthMode: 'mirror-fixed',
        bodySubscribed: true,
      },
    });
    expect(finalizeFailure).not.toHaveBeenCalled();
  });

  it('replays each recovered opening channel with its own session Host and open options', () => {
    const store = createSessionTransportRuntimeStore();
    const hostA = {
      ...makeHost(),
      id: 'host-a',
      sessionName: 'tmux-a',
      terminalBackend: 'tmux' as const,
      autoCommand: 'tmux-command',
    };
    const hostB = {
      ...makeHost(),
      id: 'host-b',
      sessionName: 'herdr-a',
      terminalBackend: 'herdr' as const,
      autoCommand: 'herdr-command',
    };
    upsertSessionTransportRuntime(store, 'session-1', hostA);
    upsertSessionTransportRuntime(store, 'session-2', hostB);
    const targetKey = getSessionTransportTargetKey(store, 'session-1')!;
    ensureSessionTerminalChannel(store.terminalChannels, 'session-1', {
      channelId: 'channel-tmux',
      bodySubscribed: false,
    });
    ensureSessionTerminalChannel(store.terminalChannels, 'session-2', {
      channelId: 'channel-herdr',
      bodySubscribed: true,
    });
    updateSessionTerminalChannelState(store.terminalChannels, 'session-1', 'open');
    updateSessionTerminalChannelState(store.terminalChannels, 'session-2', 'open');

    const failedSocket = {
      readyState: WebSocket.OPEN,
      reportFailure: vi.fn(),
      close: vi.fn(),
    } as any;
    handleTargetMuxTransportFailureRuntime({
      anchorSessionId: 'session-1',
      message: 'rtc data channel error',
      failedSocket,
      readSessionTargetRuntime: (sessionId) => getSessionTargetTransportRuntime(store, sessionId),
      readSessionTerminalChannel: (sessionId) => getSessionTerminalChannel(store.terminalChannels, sessionId),
      writeSessionTerminalChannelState: (sessionId, state) => (
        updateSessionTerminalChannelState(store.terminalChannels, sessionId, state)
      ),
      writeSessionTargetTerminalSocket: (sessionId, socket) => (
        setSessionTargetTerminalTransport(store, sessionId, socket)
      ),
      writeSessionTargetTerminalMuxReady: (sessionId, ready) => (
        setSessionTargetTerminalMuxReady(store, sessionId, ready)
      ),
      clearSessionHandshakeTimeout: vi.fn(),
      pendingSessionTransportOpenIntentsRef: { current: new Map() },
      updateSessionSync: vi.fn(),
      scheduleReconnect: vi.fn(),
      runtimeDebug: vi.fn(),
    });

    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    setTargetTerminalTransport(store, targetKey, ws);
    const sendSocketPayload = vi.fn();
    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-1',
      targetKey,
      targetHeartbeatKey: `target:${targetKey}`,
      host: hostA,
      ws,
      debugScope: 'reconnect',
      readTargetTerminalSocket: (key) => getTargetTerminalTransport(store, key),
      readRequestedTerminalGeometry: (sessionId) => (
        sessionId === 'session-1'
          ? { cols: 91, rows: 31, widthMode: 'adaptive-phone' }
          : { widthMode: 'mirror-fixed' }
      ),
      getOpeningTerminalChannelsForTarget: (key, prioritySessionId) => (
        getOpeningSessionTerminalChannelsForTarget(store.terminalChannels, key, prioritySessionId)
      ),
      readSessionTransportHost: (sessionId) => getSessionTransportHost(store, sessionId),
      readSessionTerminalChannel: (sessionId) => getSessionTerminalChannel(store.terminalChannels, sessionId),
      writeSessionTerminalChannelState: (sessionId, state) => (
        updateSessionTerminalChannelState(store.terminalChannels, sessionId, state)
      ),
      readPrioritySessionId: () => 'session-1',
      setTargetMuxReady: vi.fn(),
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
    });

    ws.onopen?.();
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

    expect(sendSocketPayload.mock.calls.slice(1).map(([, , data]) => JSON.parse(data))).toEqual([
      {
        type: 'mux-channel-open',
        payload: {
          channelId: 'channel-tmux',
          sessionName: 'tmux-a',
          backend: 'tmux',
          autoCommand: 'tmux-command',
          cols: 91,
          rows: 31,
          widthMode: 'adaptive-phone',
          bodySubscribed: false,
        },
      },
      {
        type: 'mux-channel-open',
        payload: {
          channelId: 'channel-herdr',
          sessionName: 'herdr-a',
          backend: 'herdr',
          autoCommand: 'herdr-command',
          widthMode: 'mirror-fixed',
          bodySubscribed: true,
        },
      },
    ]);
  });

  it('calls confirmTransportReady and enables bulk on capable mux-ready', () => {
    const confirmTransportReady = vi.fn();
    const enableBulkChannel = vi.fn(() => true);
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      confirmTransportReady,
      enableBulkChannel,
      getDiagnostics: () => ({ reason: '' }),
    } as any;

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      readPrioritySessionId: () => 'session-1',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
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
      ],
      setTargetMuxReady: vi.fn(),
      sendSocketPayload: vi.fn(),
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
    });

    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'mux-ready',
        payload: {
          version: 1,
          capabilities: {
            version: 1,
            channelEnvelope: true,
            targetMessages: true,
            bulkChannel: { version: 1, label: 'zterm-bulk' },
          },
        },
      }),
    });

    expect(confirmTransportReady).toHaveBeenCalledTimes(1);
    expect(enableBulkChannel).toHaveBeenCalledTimes(1);
  });

  it('does not throw when confirmTransportReady is absent on mux-ready', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'connect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      readPrioritySessionId: () => 'session-1',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
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
      ],
      setTargetMuxReady: vi.fn(),
      sendSocketPayload: vi.fn(),
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
    });

    ws.onopen?.();
    expect(() => ws.onmessage?.({
      data: JSON.stringify({
        type: 'mux-ready',
        payload: {
          version: 1,
          capabilities: { version: 1, channelEnvelope: true, targetMessages: true },
        },
      }),
    })).not.toThrow();
  });

  it('flushes the active opening channel first when mux-ready releases a shared target', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();
    const getOpeningTerminalChannelsForTarget = vi.fn((_targetKey: string, prioritySessionId?: string | null) => {
      const channels = [
        {
          channelId: 'channel-a',
          sessionId: 'session-1',
          sessionName: 'tmux-a',
          targetKey: 'target-a',
          state: 'opening' as const,
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
        {
          channelId: 'channel-b',
          sessionId: 'session-2',
          sessionName: 'tmux-b',
          targetKey: 'target-a',
          state: 'opening' as const,
          bodySubscribed: true,
          openedAt: 1,
          closedAt: null,
        },
      ];
      return prioritySessionId === 'session-2' ? [channels[1]!, channels[0]!] : channels;
    });

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'reconnect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      getOpeningTerminalChannelsForTarget,
      readPrioritySessionId: () => 'session-2',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
      setTargetMuxReady: vi.fn(),
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
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

    expect(getOpeningTerminalChannelsForTarget).toHaveBeenCalledWith('mac-studio', 'session-2');
    expect(sendSocketPayload).toHaveBeenCalledTimes(2);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2]).payload.sessionName).toBe('tmux-b');
    expect(JSON.parse(sendSocketPayload.mock.calls[1][2]).payload.sessionName).toBe('tmux-a');
  });

  it('fails mux-ready instead of flushing channels when active priority truth is missing', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const getOpeningTerminalChannelsForTarget = vi.fn(() => [
      {
        channelId: 'channel-a',
        sessionId: 'session-1',
        sessionName: 'tmux-a',
        targetKey: 'target-a',
        state: 'opening' as const,
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      },
    ]);

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'reconnect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      getOpeningTerminalChannelsForTarget,
      readPrioritySessionId: () => null,
      readSessionTransportHost: () => null,
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
      setTargetMuxReady: vi.fn(),
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure,
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

    expect(getOpeningTerminalChannelsForTarget).not.toHaveBeenCalled();
    expect(sendSocketPayload).not.toHaveBeenCalled();
    expect(finalizeFailure).toHaveBeenCalledWith('missing active session for terminal mux channel priority', true);
  });

  it('replays opening channels when the active session is not the target reconnect anchor', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();
    const finalizeFailure = vi.fn();
    const setTargetMuxReady = vi.fn();
    const getOpeningTerminalChannelsForTarget = vi.fn(() => [
      {
        channelId: 'channel-a',
        sessionId: 'session-1',
        sessionName: 'tmux-a',
        targetKey: 'target-a',
        state: 'opening' as const,
        bodySubscribed: true,
        openedAt: 1,
        closedAt: null,
      },
    ]);

    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-anchor',
      targetKey: 'mac-studio',
      targetHeartbeatKey: 'target:mac-studio',
      host: makeHost(),
      ws,
      debugScope: 'reconnect',
      readTargetTerminalSocket: () => ws,
      readRequestedTerminalGeometry: () => ({ widthMode: 'mirror-fixed' }),
      getOpeningTerminalChannelsForTarget,
      readPrioritySessionId: () => 'session-2',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
      setTargetMuxReady,
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      runtimeDebug: vi.fn(),
      finalizeFailure,
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

    expect(getOpeningTerminalChannelsForTarget).toHaveBeenCalledWith('mac-studio', 'session-2');
    expect(setTargetMuxReady).toHaveBeenCalledWith('mac-studio', true);
    expect(sendSocketPayload).toHaveBeenCalledTimes(1);
    expect(finalizeFailure).not.toHaveBeenCalled();
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
      readPrioritySessionId: () => 'session-anchor',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
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

  it('starts the mux handshake timeout after sending mux-hello on target open', () => {
    const ws = {
      readyState: WebSocket.OPEN,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      getDiagnostics: () => ({ reason: '' }),
    } as any;
    const sendSocketPayload = vi.fn();
    const startMuxHandshakeTimeout = vi.fn();

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
      readPrioritySessionId: () => 'session-anchor',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
      setTargetMuxReady: vi.fn(),
      sendSocketPayload,
      handleTargetMuxServerFrame: vi.fn(),
      applyTransportDiagnostics: vi.fn(),
      startMuxHandshakeTimeout,
      runtimeDebug: vi.fn(),
      finalizeFailure: vi.fn(),
    });

    ws.onopen?.();

    expect(JSON.parse(sendSocketPayload.mock.calls[0][2])).toEqual({
      type: 'mux-hello',
      payload: {
        version: 1,
        clientInstanceId: 'session-anchor',
      },
    });
    expect(startMuxHandshakeTimeout).toHaveBeenCalledWith('session-anchor');
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
      readPrioritySessionId: () => 'session-anchor',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
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
      readPrioritySessionId: () => 'session-anchor',
      readSessionTransportHost: () => makeHost(),
      readSessionTerminalChannel: () => null,
      writeSessionTerminalChannelState: vi.fn(),
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
