import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTargetMuxTransportSocketLifecycleRuntime, handleTargetMuxServerFrameRuntime } from './session-context-transport-runtime';
import { getSessionTransportResource, getSessionTransportHost } from '../lib/session-transport-runtime';
import { getSessionIdForTerminalChannel, getOpeningSessionTerminalChannelsForTarget } from '../lib/terminal-channel-mux-runtime';
import { enqueueReliableInputChunks, resetTerminalReliableInputRuntimeForTests, type SendInputTransportOptions } from '../lib/reliable-input/reliable-input-queue';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { sendInputThroughSessionTransport } from './session-context-input-runtime';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createSessionTransportRuntimeStore,
  getSessionTransportRuntime,
  setSessionRequestedTerminalGeometry,
  setSessionTargetTerminalMuxReady,
  setTargetTerminalTransport,
  upsertSessionTransportRuntime,
} from '../lib/session-transport-runtime';
import {
  ensureSessionTerminalChannel,
  getSessionTerminalChannel,
  updateSessionTerminalChannelState,
} from '../lib/terminal-channel-mux-runtime';
import type { Host } from '../lib/types';
import {
  createSessionInfraFacadeRuntime,
  wrapSessionPayloadForTargetMuxRuntime,
} from './session-context-infra-facade-runtime';

function makeHost(overrides?: Partial<Host>): Host {
  return {
    id: 'host-1',
    createdAt: 1,
    name: 'conn',
    bridgeHost: '100.64.0.1',
    bridgePort: 3333,
    sessionName: 'alpha',
    authToken: 'token-a',
    authType: 'password',
    tags: [],
    pinned: false,
    ...overrides,
  };
}

function makeSocket(name: string) {
  return {
    name,
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send() {},
    close() {},
    getDiagnostics() {
      return { transport: 'ws', reason: null };
    },
  };
}

function createMuxStore() {
  const store = createSessionTransportRuntimeStore();
  upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
  const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
  const targetSocket = makeSocket('target-terminal');
  setTargetTerminalTransport(store, targetKey, targetSocket as any);
  ensureSessionTerminalChannel(store.terminalChannels, 'session-1', { channelId: 'channel-a' });
  setSessionTargetTerminalMuxReady(store, 'session-1', true);
  return { store, targetSocket };
}

function unwrap(data: string | ArrayBuffer) {
  expect(typeof data).toBe('string');
  return JSON.parse(data as string);
}

describe('channel-owned connected input policy at mux wire boundaries', () => {
  afterEach(() => {
    resetTerminalReliableInputRuntimeForTests();
    vi.useRealTimers();
  });

  function fixture(inputReadiness: 'terminal-connected' | null = 'terminal-connected', backend: 'tmux' | 'herdr' = 'tmux') {
    vi.useFakeTimers();
    const store = createSessionTransportRuntimeStore();
    const host = { ...makeHost(), terminalBackend: backend, expectedSessionIdentity: 'opaque-block-a' };
    const runtime = upsertSessionTransportRuntime(store, 'session-1', host);
    const wire: unknown[] = [];
    const ws: BridgeTransportSocket = { readyState: WebSocket.OPEN, bufferedAmount: 0,
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send: (data) => { wire.push(unwrap(data)); }, close: vi.fn(),
      reportFailure: vi.fn(),
      getDiagnostics: () => ({ mode: 'auto', stage: 'open', attempts: [] }),
    };
    setTargetTerminalTransport(store, runtime.targetKey, ws);
    const channelOptions = { channelId: 'attempt-a', inputReadiness: inputReadiness ?? undefined };
    ensureSessionTerminalChannel(store.terminalChannels, 'session-1', channelOptions);
    const sendSocketPayload: SendInputTransportOptions['sendSocketPayload'] = (sessionId, socket, data) => {
      socket.send(wrapSessionPayloadForTargetMuxRuntime({ store, sessionId, ws: socket, data }));
    };
    const daemonConnection = {
      readSessionResource: (id: string) => getSessionTransportResource(store, id),
      readSessionSocket: (id: string) => getSessionTransportResource(store, id).socket,
    } as ClientDaemonConnection;
    const inputOptions: SendInputTransportOptions = {
      sessionId: 'session-1', data: 'marker', refs: {
        sessionsRef: { current: [{ id: 'session-1', reliableInputSupported: true }] },
        stateRef: { current: { activeSessionId: 'session-1' } },
      },
      daemonConnection, sendSocketPayload, runtimeDebug: vi.fn(), isReconnectInFlight: () => false,
      markPendingInputTailRefresh: () => false, readSessionBufferSnapshot: () => ({ revision: 0 }),
      requestSessionBufferHead: () => false, hasPendingSessionTransportOpen: () => false,
      isPendingSessionTransportOpenStale: () => false,
    };
    const readChannel = () => getSessionTerminalChannel(store.terminalChannels, 'session-1');
    const bindSocket = (ws: BridgeTransportSocket) => bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: 'session-1', targetKey: runtime.targetKey, targetHeartbeatKey: 'test-heartbeat', host, ws,
      debugScope: 'connect', readTargetTerminalSocket: () => store.targets.get(runtime.targetKey)?.terminalTransport || null,
      readRequestedTerminalGeometry: () => null,
      getOpeningTerminalChannelsForTarget: (key, priority) => getOpeningSessionTerminalChannelsForTarget(store.terminalChannels, key, priority),
      readSessionTransportHost: (id) => getSessionTransportHost(store, id), readSessionTerminalChannel: readChannel,
      writeSessionTerminalChannelState: (id, state) => updateSessionTerminalChannelState(store.terminalChannels, id, state),
      readPrioritySessionId: () => 'session-1',
      setTargetMuxReady: (_key, ready) => setSessionTargetTerminalMuxReady(store, 'session-1', ready),
      sendSocketPayload, applyTransportDiagnostics: vi.fn(), runtimeDebug: vi.fn(), finalizeFailure: vi.fn(),
      handleTargetMuxServerFrame: (frame) => handleTargetMuxServerFrameRuntime({
        anchorSessionId: 'session-1', host, ws, debugScope: 'connect', frame,
        resolveSessionIdForChannel: (id) => getSessionIdForTerminalChannel(store.terminalChannels, runtime.targetKey, id),
        readSessionTransportHost: (id) => getSessionTransportHost(store, id), readSessionTerminalChannel: readChannel,
        readSessionTerminalChannelBodySubscribed: () => true,
        updateSessionTerminalChannelState: (id, state) => updateSessionTerminalChannelState(store.terminalChannels, id, state),
        sendSocketPayload, handleSocketServerMessage: vi.fn(),
        buildChannelCallbacks: () => ({ onConnected: vi.fn(), onClosed: vi.fn(), onFailure: vi.fn() }),
        onExactChannelRejected: () => updateSessionTerminalChannelState(store.terminalChannels, 'session-1', 'closed'),
        runtimeDebug: vi.fn(),
      }),
    });
    bindSocket(ws);
    const ingress = (frame: unknown) => ws.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
    const opened = (stableId = host.expectedSessionIdentity) => ingress({ type: 'mux-channel-opened', payload: { channelId: readChannel()!.channelId, sessionName: 'alpha', stableId } });
    const message = (type: string, channelId = readChannel()!.channelId) => ingress({ type: 'mux-channel-message', payload: { channelId, message: { type, payload: {} } } });
    ingress({ type: 'mux-ready', payload: { version: 1, capabilities: { version: 1, channelEnvelope: true, targetMessages: true, boundedBodyScheduler: true } } });
    const inputs = () => wire.filter((frame: any) => frame.type === 'mux-channel-message' && frame.payload.message.type === 'input');
    return { store, runtime, ws, wire, inputOptions, sendSocketPayload, readChannel, ingress, opened, message, inputs, bindSocket };
  }

  it('holds reliable input after matched ACK while control passes, then releases once on current connected', () => {
    const f = fixture();
    enqueueReliableInputChunks(f.inputOptions, 'session-1', ['marker']);
    f.message('connected'); // Pre-admission evidence must be forgotten.
    f.opened();
    expect(f.wire).toContainEqual(expect.objectContaining({ type: 'mux-channel-message', payload: expect.objectContaining({ message: expect.objectContaining({ type: 'body-subscription' }) }) }));
    f.message('buffer-head');
    f.message('buffer-sync');
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toEqual([]);
    f.message('connected');
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toHaveLength(1);
    f.message('connected');
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toHaveLength(1);
  });

  it('gates raw, typed and pre-wrapped input at final send without blocking control', () => {
    const f = fixture();
    f.opened();
    const payloads = ['raw marker', JSON.stringify({ type: 'input', payload: 'typed' }), JSON.stringify({ type: 'mux-channel-message', payload: { channelId: 'attempt-a', message: { type: 'input', payload: 'wrapped' } } })];
    for (const data of payloads) {
      expect(() => f.sendSocketPayload('session-1', f.ws, data)).toThrow('input is not ready');
    }
    f.sendSocketPayload('session-1', f.ws, JSON.stringify({ type: 'body-subscription', payload: { version: 1, subscribed: true } }));
    expect(f.inputs()).toEqual([]);
    f.message('connected');
    for (const data of payloads) f.sendSocketPayload('session-1', f.ws, data);
    expect(f.inputs()).toHaveLength(3);
    expect(() => f.sendSocketPayload('session-1', f.ws, JSON.stringify({ type: 'mux-channel-message', payload: { channelId: 'retired-id', message: { type: 'input', payload: 'stale' } } }))).toThrow();
    expect(f.inputs()).toHaveLength(3);
  });

  it('drops ordinary input while waiting without queueing or reconnecting', () => {
    const f = fixture();
    f.opened();
    const scheduleReconnect = vi.fn();
    const ordinary = { ...f.inputOptions, scheduleReconnect, refs: { ...f.inputOptions.refs, sessionsRef: { current: [{ id: 'session-1', reliableInputSupported: false }] } } };
    sendInputThroughSessionTransport(ordinary);
    f.message('connected');
    vi.advanceTimersByTime(1000);
    expect(f.inputs()).toEqual([]);
    expect(scheduleReconnect).not.toHaveBeenCalled();
    sendInputThroughSessionTransport(ordinary);
    expect(f.inputs()).toHaveLength(1);
  });

  it('requires a fresh admission and connected after physical replacement; stale socket cannot release it', () => {
    const f = fixture();
    f.opened();
    f.message('connected');
    const replacement = { ...f.ws };
    setTargetTerminalTransport(f.store, f.runtime.targetKey, replacement);
    f.bindSocket(replacement);
    enqueueReliableInputChunks(f.inputOptions, 'session-1', ['replacement-marker']);
    f.opened(); // Old socket callback is fenced before ingress.
    f.message('connected');
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toEqual([]);
    expect(f.readChannel()?.state).toBe('opening');
    expect(() => f.sendSocketPayload('session-1', f.ws, 'stale raw')).toThrow();
    const receive = (frame: unknown) => replacement.onmessage?.({ data: JSON.stringify(frame) });
    const connected = { type: 'mux-channel-message', payload: { channelId: 'attempt-a', message: { type: 'connected', payload: {} } } };
    receive({ type: 'mux-ready', payload: { version: 1, capabilities: { version: 1, channelEnvelope: true, targetMessages: true, boundedBodyScheduler: true } } });
    receive(connected);
    receive({ type: 'mux-channel-opened', payload: { channelId: 'attempt-a', sessionName: 'alpha', stableId: 'opaque-block-a' } });
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toEqual([]);
    receive(connected);
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toHaveLength(1);
  });

  it('does not let closed/rejected or retired channel events release a new exact attempt', () => {
    const f = fixture();
    f.opened('wrong-block');
    f.message('connected');
    expect(f.readChannel()?.state).toBe('closed');
    ensureSessionTerminalChannel(f.store.terminalChannels, 'session-1', { channelId: 'attempt-b', inputReadiness: 'terminal-connected' });
    enqueueReliableInputChunks(f.inputOptions, 'session-1', ['new-marker']);
    f.opened();
    f.message('connected', 'attempt-a');
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toEqual([]);
    f.message('connected');
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toHaveLength(1);
    f.ingress({ type: 'mux-channel-closed', payload: { channelId: 'attempt-b', reason: 'attach failed' } });
    f.message('connected');
    expect(() => f.sendSocketPayload('session-1', f.ws, 'closed marker')).toThrow();
    expect(f.inputs()).toHaveLength(1);
  });

  it.each(['tmux', 'herdr'] as const)('preserves exact %s ACK-ready input without the policy', (backend) => {
    // Explicitly omitted policy: exact identity by itself does not select Rex.
    const f = fixture(null, backend);
    enqueueReliableInputChunks(f.inputOptions, 'session-1', ['legacy-marker']);
    f.opened();
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toHaveLength(1);
  });

  it('cancels held input when its channel is retired rather than transferring it to replacement', () => {
    const f = fixture();
    enqueueReliableInputChunks(f.inputOptions, 'session-1', ['retired-marker']);
    f.opened();
    f.ingress({ type: 'mux-channel-closed', payload: { channelId: 'attempt-a', reason: 'attach failed' } });
    ensureSessionTerminalChannel(f.store.terminalChannels, 'session-1', { channelId: 'attempt-b', inputReadiness: 'terminal-connected' });
    f.opened();
    f.message('connected');
    vi.advanceTimersByTime(500);
    expect(f.inputs()).toEqual([]);
    enqueueReliableInputChunks(f.inputOptions, 'session-1', ['replacement-marker']);
    expect(f.inputs()).toHaveLength(1);
    expect(f.inputs()[0]).toMatchObject({ payload: { channelId: 'attempt-b', message: { payload: { data: 'replacement-marker' } } } });
  });
});

describe('Android connection service platform wiring', () => {
  it('routes Android daemon target sockets through the native service projection factory', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'session-context-infra-facade-runtime.ts'), 'utf8');

    expect(source).toContain('Capacitor.isNativePlatform()');
    expect(source).toContain("Capacitor.getPlatform() === 'android'");
    expect(source).toContain('openAndroidConnectionServiceTransportSocket(host, {');
  });

  it('does not bypass the native service for WebRTC or relay-rtc Android hosts', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'session-context-infra-facade-runtime.ts'), 'utf8');

    expect(source).not.toContain('shouldRouteAndroidHostToTraversalSocket');
    expect(source).not.toContain("host.transportMode === 'webrtc'");
    expect(source).toContain("transportRole: 'session'");
    expect(source).toContain('buildTraversalSocketForHostRuntime({');
  });
});

describe('body demand reconciliation', () => {
  it('never reopens a closed mux channel from body demand reconciliation', () => {
    const { store } = createMuxStore();
    const channel = getSessionTerminalChannel(store.terminalChannels, 'session-1');
    if (!channel) {
      throw new Error('channel not initialized');
    }
    channel.state = 'closed';
    const stateRef = {
      current: {
        activeSessionId: null,
        liveSessionIds: ['session-1'],
        sessions: [{ id: 'session-1', state: 'connected' }],
      },
    };
    const runtime = createSessionInfraFacadeRuntime({
      stateRef,
      dispatch: vi.fn(),
      reduceSessionAction: (state: unknown, _action: unknown) => state,
      transportRuntimeStoreRef: { current: store },
      sessionBufferStoreRef: { current: {} },
      sessionRenderGateRef: { current: {} },
      sessionHeadStoreRef: { current: {} },
      sessionDebugMetricsStoreRef: { current: { recordTxBytes: vi.fn(), recordRxBytes: vi.fn() } },
      scheduleStatesRef: { current: {} },
      setScheduleStates: vi.fn(),
      sessionAttachTokensRef: { current: new Map() },
      pendingSessionTransportOpenIntentsRef: { current: new Map() },
      activeBodySubscriptionSuppressedRef: { current: false },
      reconnectStore: {},
      tailRefreshStore: {},
      bufferFrameAssemblyRef: { current: new Map() },
      sessionPullStateRef: { current: new Map() },
      heartbeatStore: {},
      handshakeTimeoutsRef: { current: new Map() },
      sessionRevisionResetRef: { current: new Map() },
      lastHeadRequestAtRef: { current: new Map() },
      terminalCacheLines: 1000,
      defaultRows: 40,
      bridgeSettings: {},
      staleActivityMs: 3000,
      runtimeDebug: vi.fn(),
    } as any);

    runtime.reconcilePhysicalBodySubscriptions('live-sessions');

    expect(channel.state).toBe('closed');
    expect(channel.bodySubscribed).toBe(true);
  });

  it('sends the current adaptive-phone geometry with a foreground body-subscription so reattach restores the lease', () => {
    const { store, targetSocket } = createMuxStore();
    updateSessionTerminalChannelState(store.terminalChannels, 'session-1', 'open');
    setSessionRequestedTerminalGeometry(store, 'session-1', { cols: 68, widthMode: 'adaptive-phone' });
    const sent: string[] = [];
    (targetSocket as any).send = (data: string) => { sent.push(data); };
    const stateRef = {
      current: {
        activeSessionId: 'session-1',
        liveSessionIds: ['session-1'],
        sessions: [{ id: 'session-1', state: 'connected' }],
      },
    };
    const runtime = createSessionInfraFacadeRuntime({
      stateRef,
      dispatch: vi.fn(),
      reduceSessionAction: (state: unknown, _action: unknown) => state,
      transportRuntimeStoreRef: { current: store },
      sessionBufferStoreRef: { current: {} },
      sessionRenderGateRef: { current: {} },
      sessionHeadStoreRef: { current: {} },
      sessionDebugMetricsStoreRef: { current: { recordTxBytes: vi.fn(), recordRxBytes: vi.fn() } },
      scheduleStatesRef: { current: {} },
      setScheduleStates: vi.fn(),
      sessionAttachTokensRef: { current: new Map() },
      pendingSessionTransportOpenIntentsRef: { current: new Map() },
      activeBodySubscriptionSuppressedRef: { current: false },
      reconnectStore: {},
      tailRefreshStore: {},
      bufferFrameAssemblyRef: { current: new Map() },
      sessionPullStateRef: { current: new Map() },
      heartbeatStore: {},
      handshakeTimeoutsRef: { current: new Map() },
      sessionRevisionResetRef: { current: new Map() },
      lastHeadRequestAtRef: { current: new Map() },
      terminalCacheLines: 1000,
      defaultRows: 40,
      bridgeSettings: {},
      staleActivityMs: 3000,
      runtimeDebug: vi.fn(),
    } as any);

    runtime.reconcilePhysicalBodySubscriptions('live-sessions');

    const bodyMessage = sent
      .map((item) => JSON.parse(item))
      .find((item) => item.type === 'mux-channel-message' && item.payload?.message?.type === 'body-subscription');
    expect(bodyMessage).toBeTruthy();
    expect(bodyMessage.payload.message.payload).toEqual({
      version: 1,
      subscribed: true,
      cols: 68,
      widthMode: 'adaptive-phone',
    });
  });
});

describe('wrapSessionPayloadForTargetMuxRuntime', () => {
  it('leaves non-target sockets unchanged', () => {
    const { store } = createMuxStore();
    const legacySocket = makeSocket('legacy-session');
    const data = JSON.stringify({ type: 'input', payload: 'pwd\r' });

    expect(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: legacySocket as any,
      data,
    })).toBe(data);
  });

  it('wraps session-bound JSON messages in channel envelopes on the target mux socket', () => {
    const { store, targetSocket } = createMuxStore();
    const wrapped = unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'input', payload: 'echo alpha\r' }),
    }));

    expect(wrapped).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: {
          type: 'input',
          payload: 'echo alpha\r',
        },
      },
    });
  });

  it('wraps binary chunks with the owning channel id', () => {
    const { store, targetSocket } = createMuxStore();
    const wrapped = unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: new TextEncoder().encode('image-chunk').buffer,
    }));

    expect(wrapped).toEqual({
      type: 'mux-channel-binary',
      payload: {
        channelId: 'channel-a',
        dataBase64: 'aW1hZ2UtY2h1bms=',
      },
    });
  });

  it('maps target and close messages to mux target-level frames without rebuilding sockets', () => {
    const { store, targetSocket } = createMuxStore();

    expect(unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'list-sessions' }),
    }))).toEqual({
      type: 'mux-target-message',
      payload: {
        message: { type: 'list-sessions' },
      },
    });

    expect(unwrap(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({ type: 'close' }),
    }))).toEqual({
      type: 'mux-channel-close',
      payload: {
        channelId: 'channel-a',
        reason: 'client requested channel close',
      },
    });
  });

  it('does not double-wrap existing mux frames and rejects legacy connect frames on target mux transport', () => {
    const { store, targetSocket } = createMuxStore();
    const muxHello = JSON.stringify({
      type: 'mux-hello',
      payload: { version: 1, clientInstanceId: 'session-1' },
    });

    expect(wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: muxHello,
    })).toBe(muxHello);

    expect(() => wrapSessionPayloadForTargetMuxRuntime({
      store,
      sessionId: 'session-1',
      ws: targetSocket as any,
      data: JSON.stringify({
        type: 'connect',
        payload: {
          openRequestId: 'open-1',
          sessionTransportToken: 'token-1',
          sessionName: 'alpha',
        },
      }),
    })).toThrow(/legacy terminal message connect/);
  });
});
